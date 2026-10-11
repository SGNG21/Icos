import type { WorkerProbeErrorClass, WorkerRegistryEntry } from "@/core/contracts/worker-registry";

import { evaluateWorkerEligibility, HEALTH_EVIDENCE_MAX_AGE_MS } from "./worker-eligibility";

/**
 * FLEET READINESS, MEASURED WITH THE ROUTER'S OWN RULES.
 *
 * The self-model counted every `workers` row against the rows reading
 * `health = 'healthy' AND availability = 'available'`. That is a third notion of
 * "routable" next to the canonical matcher's: it counted disabled rows, ignored runtime
 * support and evidence age, and so disagreed with what routing would actually do.
 *
 * `routable` here IS the canonical verdict — `evaluateWorkerEligibility` with the same
 * evidence horizon the capability router passes — and every other bucket is read off
 * that verdict's reasons or off the durable probe outcome. No gate is re-implemented.
 *
 * PURE: no I/O, and the clock arrives as data, so the same rows and the same `now`
 * always measure the same fleet.
 */

/** Provider label for a worker that declares no `metadata.provider`. */
export const FLEET_PROVIDER_UNDECLARED = "(non déclaré)";

export const PROBE_ERROR_CLASSES = [
  "NOT_CONFIGURED",
  "AUTH_FAILURE",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "UNKNOWN",
] as const satisfies readonly WorkerProbeErrorClass[];

/**
 * One provider's slice of the fleet.
 *
 * EXCLUSIVE BUCKETS over ACTIVE rows, assigned in this precedence:
 *   routable > unsupported > unprobed > stale > failing > degraded
 * so `active === routable + unsupported + unprobed + stale + sum(failing) + degraded`
 * always holds. `disabled` counts the non-active rows, outside that sum.
 * `notConfigured` is NOT an extra bucket: it repeats `failing.NOT_CONFIGURED`, the
 * deployment-gap signal (no credential for this provider) a reader most needs by name.
 */
export interface ProviderReadiness {
  provider: string;
  /** Rows with status `active`. */
  active: number;
  /** Active rows the canonical matcher would route to right now. */
  routable: number;
  /** Active rows whose last probe failed for lack of a provider credential. */
  notConfigured: number;
  /** Active rows whose (fresh) last probe failed, by persisted failure class. */
  failing: Record<WorkerProbeErrorClass, number>;
  /** Active rows never probed. */
  unprobed: number;
  /** Active rows whose evidence is older than the horizon or was expired by the sweeper. */
  stale: number;
  /** Active rows whose runtime is not supported here, or that nothing may probe. */
  unsupported: number;
  /** Active rows probed `ok` that still fail a gate (degraded/unavailable observation). */
  degraded: number;
  /** Rows not `active` (operator-disabled, retired orphans, maintenance). */
  disabled: number;
}

export interface FleetReadiness {
  /** ISO instant the measurement was taken at. */
  measuredAt: string;
  /** The evidence horizon applied — the router's. */
  maxEvidenceAgeMs: number;
  /** Every provider, sorted by name. */
  providers: ProviderReadiness[];
  /** The whole fleet, `provider: "*"`. */
  total: ProviderReadiness;
}

function emptyReadiness(provider: string): ProviderReadiness {
  return {
    provider,
    active: 0,
    routable: 0,
    notConfigured: 0,
    failing: Object.fromEntries(PROBE_ERROR_CLASSES.map((c) => [c, 0])) as Record<
      WorkerProbeErrorClass,
      number
    >,
    unprobed: 0,
    stale: 0,
    unsupported: 0,
    degraded: 0,
    disabled: 0,
  };
}

export type ActiveReadinessBucket =
  "routable" | "unsupported" | "unprobed" | "stale" | "failing" | "degraded";

/**
 * The one bucket an ACTIVE worker falls in, from the canonical verdict. Exported so a
 * reader explaining a single worker uses the same precedence as the counts.
 */
export function readinessBucket(
  worker: WorkerRegistryEntry,
  now: string,
  maxAgeMs: number = HEALTH_EVIDENCE_MAX_AGE_MS,
): ActiveReadinessBucket {
  const verdict = evaluateWorkerEligibility(worker, { evidenceHorizon: { now, maxAgeMs } });
  if (verdict.eligible) return "routable";
  if (
    verdict.reasons.includes("RUNTIME_NOT_SUPPORTED") ||
    worker.lastProbeOutcome === "unsupported"
  ) {
    return "unsupported";
  }
  if (verdict.reasons.includes("HEALTH_EVIDENCE_MISSING") || worker.lastProbeOutcome === "never") {
    return "unprobed";
  }
  if (verdict.reasons.includes("HEALTH_EVIDENCE_STALE") || worker.lastProbeOutcome === "stale") {
    return "stale";
  }
  if (worker.lastProbeOutcome === "failed") return "failing";
  return "degraded";
}

function providerOf(worker: WorkerRegistryEntry): string {
  const declared = worker.metadata.provider?.trim();
  return declared ? declared : FLEET_PROVIDER_UNDECLARED;
}

function add(
  target: ProviderReadiness,
  worker: WorkerRegistryEntry,
  now: string,
  maxAgeMs: number,
) {
  if (worker.status !== "active") {
    target.disabled += 1;
    return;
  }
  target.active += 1;
  const bucket = readinessBucket(worker, now, maxAgeMs);
  if (bucket === "failing") {
    const errorClass = worker.lastProbeErrorClass ?? "UNKNOWN";
    target.failing[errorClass] += 1;
    if (errorClass === "NOT_CONFIGURED") target.notConfigured += 1;
    return;
  }
  target[bucket] += 1;
}

/**
 * Measures the fleet per provider (`metadata.provider`, or `(non déclaré)`).
 *
 * `maxAgeMs` defaults to the canonical horizon shared by the prober and the router;
 * override it only to mirror a router configured with a different one.
 */
export function measureFleet(
  rows: readonly WorkerRegistryEntry[],
  now: Date | string,
  maxAgeMs: number = HEALTH_EVIDENCE_MAX_AGE_MS,
): FleetReadiness {
  const measuredAt = typeof now === "string" ? new Date(now).toISOString() : now.toISOString();
  const byProvider = new Map<string, ProviderReadiness>();
  const total = emptyReadiness("*");

  for (const worker of rows) {
    const provider = providerOf(worker);
    let slice = byProvider.get(provider);
    if (!slice) {
      slice = emptyReadiness(provider);
      byProvider.set(provider, slice);
    }
    add(slice, worker, measuredAt, maxAgeMs);
    add(total, worker, measuredAt, maxAgeMs);
  }

  return {
    measuredAt,
    maxEvidenceAgeMs: maxAgeMs,
    providers: [...byProvider.values()].sort((a, b) => a.provider.localeCompare(b.provider)),
    total,
  };
}
