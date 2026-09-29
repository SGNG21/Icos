import { createHash } from "node:crypto";

import type {
  WorkerRegistryEntry,
  WorkerRuntimeDescriptor,
} from "@/core/contracts/worker-registry";
import {
  FAMILY_HINTS,
  inferModelFamily,
  MODEL_FAMILIES,
  type ModelFamily,
} from "@/core/workers/compute-routing";

/**
 * THE COMPUTE FLEET, from provider truth (decision 0054).
 *
 * Which models exist is OmniRoute's answer (`GET /v1/models`), never a list compiled into ICOS
 * or into a test. This module turns that answer into registry candidates: one worker per model
 * of a recognised family, with a DETERMINISTIC id derived from the model id, so re-running
 * registration is idempotent and a restart rediscovers the same candidates.
 *
 * It registers; it never marks anything healthy. Health is the prober's job, on dated evidence.
 */

export interface DiscoveredModel {
  modelId: string;
  /** OmniRoute's routing prefix (`nvidia/...` -> `nvidia`); opaque, never branched on. */
  provider: string;
  family: ModelFamily;
}

export interface ComputeSnapshot {
  source: string;
  listed: number;
  families: Array<{ family: ModelFamily; available: boolean; models: string[] }>;
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

/** Lists the models OmniRoute serves. The credential is sent, never returned or logged. */
export async function listOmniRouteModels(options: {
  baseUrl: string;
  credential: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<string[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}/v1/models`, {
    headers: { Authorization: ["Bearer", options.credential].join(" ") },
    signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`COMPUTE_DISCOVERY_HTTP_${response.status}`);
  const payload = (await response.json()) as ModelsResponse;
  return (payload.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .sort();
}

/**
 * Classifies model ids into the six families. Unrecognised ids are ignored (reported in the
 * snapshot's count), and the `auto/*` meta-routes are skipped: a candidate must be ONE model,
 * or history and independence would be attributed to whatever the meta-route picked that day.
 */
export function classifyModels(modelIds: readonly string[]): DiscoveredModel[] {
  return modelIds
    .filter((id) => !id.startsWith("auto/"))
    .flatMap((modelId) => {
      const family = inferModelFamily(modelId);
      if (!family) return [];
      const provider = modelId.includes("/") ? modelId.split("/")[0]! : "omniroute";
      return [{ modelId, provider, family }];
    });
}

/** Effort / tier variants of one model, and prompt-mode wrappers: not distinct compute. */
const VARIANT = /(-(low|medium|high|xhigh|max|ultra)|:free-[a-z]+)$/i;
const WRAPPER = /^no-think\//i;

/**
 * ONE representative per (family, provider): the base id, not its effort variants or prompt
 * wrappers, and the newest version (greatest id). The live gateway lists ~20 ids per family;
 * registering each as a candidate would multiply one model's history and capacity by 20.
 */
export function representativeModels(discovered: readonly DiscoveredModel[]): DiscoveredModel[] {
  const best = new Map<string, DiscoveredModel>();
  for (const d of discovered) {
    if (VARIANT.test(d.modelId) || WRAPPER.test(d.modelId)) continue;
    const key = `${d.family}|${d.provider}`;
    const current = best.get(key);
    if (!current || d.modelId > current.modelId) best.set(key, d);
  }
  return [...best.values()].sort(
    (a, b) => a.family.localeCompare(b.family) || a.modelId.localeCompare(b.modelId),
  );
}

export function computeSnapshot(source: string, modelIds: readonly string[]): ComputeSnapshot {
  const discovered = classifyModels(modelIds);
  return {
    source,
    listed: modelIds.length,
    families: MODEL_FAMILIES.map((family) => {
      const models = discovered.filter((d) => d.family === family).map((d) => d.modelId);
      return { family, available: models.length > 0, models };
    }),
  };
}

/** A stable UUID (v4-shaped) from the model id: same model, same worker, across restarts. */
export function candidateWorkerId(modelId: string): string {
  const h = createHash("sha256").update(`icos-compute:${modelId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface CandidateRegistrationOptions {
  runtime: WorkerRuntimeDescriptor;
  /** Capabilities every candidate offers through the configured runtime. */
  capabilities: readonly string[];
  /** Per-family budget overrides; otherwise the runtime's own timeout applies. */
  budgetMs?: Partial<
    Record<ModelFamily, { executionBudgetMs?: number; maxExecutionBudgetMs?: number }>
  >;
  maxConcurrency?: number;
}

/**
 * The registration for one discovered model. `capacityPool` is the provider, so every model
 * behind one provider account shares its concurrency ceiling rather than multiplying it.
 */
export function candidateRegistration(
  model: DiscoveredModel,
  options: CandidateRegistrationOptions,
): Pick<
  WorkerRegistryEntry,
  | "id"
  | "workerKind"
  | "displayName"
  | "capabilities"
  | "runtime"
  | "runtimeSupport"
  | "maxConcurrency"
  | "capacityPool"
  | "metadata"
> {
  const budget = options.budgetMs?.[model.family];
  const metadata: Record<string, string> = {
    model: model.modelId,
    provider: model.provider,
    modelFamily: model.family,
    tierHint: String(FAMILY_HINTS[model.family].tier),
  };
  if (budget?.executionBudgetMs) metadata.executionBudgetMs = String(budget.executionBudgetMs);
  if (budget?.maxExecutionBudgetMs)
    metadata.maxExecutionBudgetMs = String(budget.maxExecutionBudgetMs);

  return {
    id: candidateWorkerId(model.modelId),
    workerKind: "agent",
    displayName: `compute:${model.modelId}`,
    capabilities: [...options.capabilities],
    runtime: options.runtime,
    runtimeSupport: "SUPPORTED_RUNTIME",
    maxConcurrency: options.maxConcurrency ?? 1,
    capacityPool: `provider:${model.provider}`,
    metadata,
  };
}

export type ProbeClassification =
  "AVAILABLE" | "UNAVAILABLE" | "NOT_CONFIGURED" | "RATE_LIMITED" | "AUTH_FAILURE" | "UNKNOWN";

/**
 * What a FAILED probe means, from its message. Ordered: "no credentials for provider" is a
 * deployment gap (NOT_CONFIGURED), not a refused credential, even though it arrives as a 404.
 * Anything unrecognised — including a timeout — is UNKNOWN, never AVAILABLE.
 */
export function classifyProbeFailure(message: string): ProbeClassification {
  if (/no active credentials|not configured|no credentials/i.test(message)) return "NOT_CONFIGURED";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid (api )?key|authentication/i.test(message)) {
    return "AUTH_FAILURE";
  }
  if (/\b429\b|rate.?limit|quota|too many requests/i.test(message)) return "RATE_LIMITED";
  if (
    /\b(404|502|503)\b|not found|unknown model|no such model|unavailable|not available/i.test(
      message,
    )
  ) {
    return "UNAVAILABLE";
  }
  return "UNKNOWN";
}
