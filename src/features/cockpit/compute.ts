import { z } from "zod";

import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";

import type { Tone, WorkerView } from "./snapshot";
import { isReal, missing, real, type Truth } from "./truth";

/**
 * Compute / OmniRoute view (decision 0054). A compute candidate IS a registered
 * worker; its provider, model and family live in registration metadata; its
 * health is the prober's dated evidence; a provider quota is its capacity pool.
 * Routing facts (history, exclusions, fallback, reason, model steering) are
 * READ from the persisted ROUTING_DECISION evidence on dispatch attempts —
 * never recomputed here. Families are open strings: no closed model list.
 */

/** Subset of CORE3's RoutingDecisionEvidence, parsed defensively (extra keys pass). */
const candidateSchema = z
  .object({
    workerId: z.string(),
    family: z.string().optional(),
    fallback: z.string().optional(),
    excludedBecause: z.array(z.string()).default([]),
    history: z
      .object({
        executions: z.number(),
        infraFailures: z.number(),
        timeouts: z.number(),
        reviewed: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export const routingEvidenceSchema = z
  .object({
    kind: z.literal("ROUTING_DECISION"),
    policyVersion: z.string(),
    decidedAt: z.string(),
    role: z.string(),
    requiredTier: z.number(),
    escalationReason: z.array(z.string()).default([]),
    candidateSet: z.array(candidateSchema).default([]),
    selected: z
      .object({
        workerId: z.string(),
        family: z.string().optional(),
        score: z.number().optional(),
        modelSteered: z.boolean().optional(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();
export type RoutingEvidence = z.infer<typeof routingEvidenceSchema>;

/** Evidence present on attempts. Attempts routed before 0054 simply carry none. */
export function routingEvidenceOf(attempts: readonly DispatchAttempt[]): RoutingEvidence[] {
  return attempts.flatMap((a) => {
    const parsed = routingEvidenceSchema.safeParse(
      (a as DispatchAttempt & { routingDecision?: unknown }).routingDecision,
    );
    return parsed.success ? [parsed.data] : [];
  });
}

export interface ComputeRow {
  workerId: string;
  workerName: string;
  provider: Truth<string>;
  /** OmniRoute route / provider quota = the capacity pool (0054). */
  route: Truth<string>;
  family: Truth<string>;
  modelId: Truth<string>;
  health: WorkerView["health"];
  availability: WorkerView["availability"];
  probe: WorkerView["probe"];
  load: { used: Truth<number>; max: number };
  latency: Truth<number>;
  timeoutRate: Truth<number>;
  infraFailureRate: Truth<number>;
  /** Exclusions the router recorded for this candidate at its latest decision. */
  routingExclusions: Truth<string[]>;
  rateLimit: Truth<string>;
  credentialHealth: Truth<string>;
  modelSteered: Truth<boolean>;
  fallbackEvents: Truth<number>;
  routingReason: Truth<string>;
  tone: Tone;
  routable: boolean;
}

export interface ComputeGroup {
  family: string;
  declared: boolean;
  rows: ComputeRow[];
}

const NO_EVIDENCE = (what: string) =>
  missing<never>(
    "not_connected",
    `${what} comes from ROUTING_DECISION evidence (CORE3 decision 0054); no active attempt carries it here.`,
    "CORE3 0054",
  );
export const UNDECLARED_FAMILY = "UNDECLARED";

export function buildCompute(
  workers: readonly WorkerView[],
  attempts: Truth<DispatchAttempt[]>,
): ComputeGroup[] {
  const evidence = isReal(attempts)
    ? routingEvidenceOf(attempts.value).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
    : [];

  const rows = workers.map((w): ComputeRow => {
    const family = w.metadata.modelFamily;
    const seen = evidence
      .map((e) => ({ e, c: e.candidateSet.find((c) => c.workerId === w.id) }))
      .filter((x) => x.c);
    const latest = seen[0];
    const history = latest?.c?.history;
    const rate = (n: number | undefined, label: string): Truth<number> =>
      !latest
        ? NO_EVIDENCE(label)
        : history && history.executions > 0 && n !== undefined
          ? real(n / history.executions, `router history ${n}/${history.executions}`)
          : missing("unknown", "No execution history for this model yet.");
    const selectedBy = evidence.filter((e) => e.selected?.workerId === w.id);
    const lastSelected = selectedBy[0];
    const exclusions = latest?.c?.excludedBecause ?? [];

    return {
      workerId: w.id,
      workerName: w.name,
      provider: w.provider,
      route: w.pool
        ? real(w.pool.name, "capacity pool declared in the registry")
        : missing("not_available", "No capacity pool declared."),
      family: family
        ? real(family, "declared in registration metadata")
        : missing("unknown", "Family not declared; the router infers it from the model id at dispatch."),
      modelId: w.model,
      health: w.health,
      availability: w.availability,
      probe: w.probe,
      load: { used: w.slots.used, max: w.slots.max },
      latency: missing("not_available", "No per-model latency telemetry.", "BR-04"),
      timeoutRate: rate(history?.timeouts, "Timeout rate"),
      infraFailureRate: rate(history?.infraFailures, "Infrastructure failure rate"),
      routingExclusions: latest ? real(exclusions, "latest routing decision") : NO_EVIDENCE("Routing exclusions"),
      rateLimit: !latest
        ? NO_EVIDENCE("Rate-limit state")
        : exclusions.some((x) => x.includes("COOLDOWN"))
          ? real("cooldown", "router excluded it for a provider/model cooldown")
          : real("no cooldown recorded", "latest routing decision"),
      credentialHealth: missing(
        "not_available",
        "Credential health is not exposed to the cockpit; an AUTH_FAILURE shows as a routing cooldown.",
      ),
      modelSteered:
        lastSelected?.selected?.modelSteered !== undefined
          ? real(lastSelected.selected.modelSteered, "recorded when selected")
          : NO_EVIDENCE("Model steering"),
      fallbackEvents: evidence.length
        ? real(
            seen.filter((x) => x.c?.fallback && x.e.selected?.workerId === w.id).length,
            "selections marked TIER_FALLBACK on active attempts",
          )
        : NO_EVIDENCE("Fallback events"),
      routingReason: lastSelected
        ? real(
            `tier ≥ ${lastSelected.requiredTier}${
              lastSelected.escalationReason.length ? ` (${lastSelected.escalationReason.join("; ")})` : ""
            }${lastSelected.selected?.score !== undefined ? ` · score ${lastSelected.selected.score.toFixed(2)}` : ""} · ${lastSelected.policyVersion}`,
            "latest decision that selected this candidate",
          )
        : NO_EVIDENCE("Routing reason"),
      tone: w.tone,
      routable: w.routable,
    };
  });

  const groups = new Map<string, ComputeRow[]>();
  for (const r of rows) {
    const key = isReal(r.family) ? r.family.value : UNDECLARED_FAMILY;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => Number(a === UNDECLARED_FAMILY) - Number(b === UNDECLARED_FAMILY) || a.localeCompare(b))
    .map(([family, rows]) => ({ family, declared: family !== UNDECLARED_FAMILY, rows }));
}
