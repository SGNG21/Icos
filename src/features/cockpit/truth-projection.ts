import type { ImprovementCandidate } from "@/core/autonomy/improvement-backlog";
import type { CapabilityFact, CapabilityState } from "@/core/cognitive/self-model";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

import type { Tone } from "./snapshot";
import { missing, real, type Truth } from "./truth";

/**
 * COCKPIT TRUTH PROJECTION (decision 0069).
 *
 * The cockpit's `NOT AVAILABLE` tiles are honesty markers: a requirement code on a value
 * ICOS could not source. Several of those sources exist now — durable memory, the spend
 * ledger, the durable improvement backlog, the measured self-model — and leaving the tiles
 * dark became the misleading choice. This module turns those RAW FACTS into `Truth` values.
 * It is pure: every function here is a projection of what was read, never an estimate.
 */

/** What the loader reads. Each field is a measurement or an explicit miss, never a default. */
export interface TruthProjection {
  readonly memory: Truth<{ records: number; active: number; retrievals24h: number }>;
  readonly spend: Truth<{
    calls24h: number;
    tokens24h: number;
    unpriced24h: number;
    /** `null` while any 24h call is UNPRICED: an amount that cannot be proven is not shown. */
    amount24h: number | null;
    currency: string | null;
  }>;
  readonly selfDevelopment: Truth<readonly ImprovementCandidate[]>;
  /** The same measured facts the conversation receives as `[runtime:capability.*]`. */
  readonly capabilities: Truth<readonly CapabilityFact[]>;
}

export const memoryMetric = (t: TruthProjection["memory"]): Truth<number> =>
  t.kind === "real" ? real(t.value.records, "memory_records rows (BR-02)") : t;

/** Tokens, not money: money is only real once every call in the window is priced. */
export const tokenThroughputMetric = (t: TruthProjection["spend"]): Truth<number> =>
  t.kind === "real" ? real(t.value.tokens24h, "spend_ledger total_tokens, 24h") : t;

export const costMetric = (t: TruthProjection["spend"]): Truth<number | string> => {
  if (t.kind !== "real") return t;
  const { amount24h, currency, unpriced24h, calls24h } = t.value;
  if (amount24h !== null && currency)
    return real(`${amount24h.toFixed(2)} ${currency}`, "spend_ledger amount, 24h");
  // UNPRICED is a measured state (decision 0066): an empty price table makes every call
  // unpriced, so the honest number is how many calls could not be priced — never 0.00.
  return real(
    `UNPRICED ${unpriced24h}/${calls24h}`,
    "calls without a price in the 24h window (BR-05)",
  );
};

export const selfDevelopmentMetric = (t: TruthProjection["selfDevelopment"]): Truth<number> =>
  t.kind === "real" ? real(t.value.length, "durable improvement candidates (BR-08)") : t;

export function candidatesByStatus(
  candidates: readonly ImprovementCandidate[],
): Record<ImprovementCandidate["status"], number> {
  const out: Record<ImprovementCandidate["status"], number> = {
    proposed: 0,
    under_review: 0,
    approved: 0,
    rejected: 0,
    implemented: 0,
    superseded: 0,
  };
  for (const c of candidates) out[c.status]++;
  return out;
}

/**
 * Provider health from the registry's OWN probe evidence: routable workers over registered
 * ones. It replaces `providerTelemetry()` only for health; latency stays unmeasured.
 */
export function providerHealthMetric(workers: Truth<WorkerRegistryEntry[]>): Truth<number> {
  if (workers.kind !== "real") return workers;
  if (workers.value.length === 0)
    return missing("not_available", "No worker is registered, so no provider is probed.", "BR-04");
  const routable = workers.value.filter(
    (w) => w.health === "healthy" && w.availability === "available",
  ).length;
  return real(
    routable,
    `routable workers out of ${workers.value.length} registered (probe evidence)`,
  );
}

export const CAPABILITY_TONE: Record<CapabilityState, Tone> = {
  AUTONOMOUS: "autonomy",
  GOVERNED: "ok",
  APPROVAL_REQUIRED: "flow",
  DEGRADED: "warn",
  NOT_CONFIGURED: "warn",
  NOT_CONNECTED: "critical",
  NOT_SUPPORTED: "unknown",
};
