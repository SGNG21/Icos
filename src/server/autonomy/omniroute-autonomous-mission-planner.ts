import type { Env } from "@/config/env";
import type { AutonomousMissionPlanner } from "@/server/autonomy/autonomous-mission-runner";
import type { MissionPlan } from "@/server/mission/mission-plan";
import {
  CanonicalAutonomousMissionPlanner,
  plannerError,
  type PlannerCompletionProvider,
  PlannerFailureCode,
} from "./canonical-mission-planner";

/**
 * OmniRoute as a PROVIDER behind the canonical planner (M12).
 *
 * This file used to own the plan schema, the prompts, DAG validation and the error taxonomy.
 * All of that is canonical planning semantics and now lives in
 * `CanonicalAutonomousMissionPlanner`; what remains here is transport — an HTTP call to an
 * OpenAI-compatible endpoint. The class keeps its name, constructor and error codes so the
 * behaviour it was certified with is unchanged.
 */

interface OmniRouteChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

export interface OmniRouteAutonomousMissionPlannerOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

/** Transport only. It never parses, repairs or interprets a plan. */
export class OmniRouteCompletionProvider implements PlannerCompletionProvider {
  readonly name = "omniroute";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OmniRouteAutonomousMissionPlannerOptions) {
    if (!options.baseUrl || !options.apiKey || !options.model) {
      throw plannerError(PlannerFailureCode.CONFIGURATION_INCOMPLETE);
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async complete(input: { system: string; user: string; signal: AbortSignal }): Promise<string> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
      }),
      cache: "no-store",
      signal: input.signal,
    });

    if (!response.ok) {
      throw plannerError(PlannerFailureCode.PROVIDER_HTTP, `${response.status}`);
    }

    let payload: OmniRouteChatResponse;
    try {
      payload = (await response.json()) as OmniRouteChatResponse;
    } catch {
      throw plannerError(PlannerFailureCode.INVALID_RESPONSE);
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw plannerError(PlannerFailureCode.INVALID_RESPONSE);
    }
    return content;
  }
}

/**
 * Preserved as the OmniRoute-configured canonical planner.
 *
 * Kept as a class with the same constructor so every existing call site and certification
 * continues to work; it delegates rather than reimplementing, so there is still exactly one
 * planning authority.
 */
export class OmniRouteAutonomousMissionPlanner implements AutonomousMissionPlanner {
  private readonly canonical: CanonicalAutonomousMissionPlanner;

  constructor(options: OmniRouteAutonomousMissionPlannerOptions) {
    /* Provider config is validated first, so CONFIGURATION_INCOMPLETE still precedes it. */
    const provider = new OmniRouteCompletionProvider(options);
    this.canonical = new CanonicalAutonomousMissionPlanner({
      provider,
      timeoutMs: options.timeoutMs,
    });
  }

  plan(input: Parameters<AutonomousMissionPlanner["plan"]>[0]): Promise<MissionPlan> {
    return this.canonical.plan(input);
  }
}

/**
 * `fetchImpl` est la couture du COMPTEUR DE DÉPENSE : le conteneur y passe le `fetch` mesuré
 * de la couture « mission », plafonné par le budget du goal imputé (voir
 * `server/budget/compose-spend.ts`). Absent = le `fetch` global, comportement d'avant.
 */
export function createOmniRouteAutonomousMissionPlanner(
  env: Pick<
    Env,
    "OMNIROUTE_BASE_URL" | "OMNIROUTE_API_KEY" | "ICOS_PLANNER_MODEL" | "ICOS_PLANNER_TIMEOUT_MS"
  >,
  fetchImpl?: typeof fetch,
): AutonomousMissionPlanner | undefined {
  const plannerRequested =
    env.ICOS_PLANNER_MODEL !== undefined || env.ICOS_PLANNER_TIMEOUT_MS !== undefined;

  if (!plannerRequested) {
    return undefined;
  }

  if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY || !env.ICOS_PLANNER_MODEL) {
    throw plannerError(PlannerFailureCode.CONFIGURATION_INCOMPLETE);
  }

  return new OmniRouteAutonomousMissionPlanner({
    baseUrl: env.OMNIROUTE_BASE_URL,
    apiKey: env.OMNIROUTE_API_KEY,
    model: env.ICOS_PLANNER_MODEL,
    timeoutMs: env.ICOS_PLANNER_TIMEOUT_MS ?? 30_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}
