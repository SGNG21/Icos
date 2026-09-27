import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

/**
 * THE canonical worker eligibility authority (decision 0031).
 *
 * Before M4 there were THREE independent implementations of "can this worker
 * take work":
 *   - IndependentReviewerSelector.select()            (strict, fail closed)
 *   - BoundedRepairController.getEligibleWorkers()    (strict, fail closed, copy)
 *   - AdaptedAIResourceCatalog.isRunnable()           (LOOSE, failed OPEN on
 *                                                      health/availability
 *                                                      "unknown")
 * Three matchers means three answers to one question, and the third one let an
 * unprobed worker through. There is now exactly one.
 *
 * FAIL CLOSED IS THE WHOLE POINT: every gate is an ALLOW-list of one exact
 * value. "unknown" is never a pass. A worker we have not probed is a worker we
 * do not route to.
 *
 * This module is pure: no I/O, no clock, no randomness. Same inputs -> same
 * outputs, which is what makes routing reproducible across a restart.
 *
 * SCOPE — a Worker is an execution unit. It is NOT a Model, NOT a Provider,
 * NOT an Account and NOT a capacity slot. Model/provider/account selection is
 * the AI resource catalog's job and stays out of here on purpose; conflating
 * them is how a "routing" layer becomes a provider hardwire.
 */

/** The ONLY worker status that may receive work. */
export const ELIGIBLE_WORKER_STATUS = "active" as const;
/** The ONLY runtime-support value that may receive work. DECLARED_ONLY/UNKNOWN cannot. */
export const ELIGIBLE_RUNTIME_SUPPORT = "SUPPORTED_RUNTIME" as const;
/** The ONLY health value that may receive work. degraded/unhealthy/unknown cannot. */
export const ELIGIBLE_WORKER_HEALTH = "healthy" as const;
/** The ONLY availability value that may receive work. unavailable/unknown cannot. */
export const ELIGIBLE_WORKER_AVAILABILITY = "available" as const;

/**
 * How long health evidence stays valid, by default (M5.2).
 *
 * ONE value, imported by both the producer (WorkerHealthProber) and the
 * consumer (CapabilityRouter). Two independent horizons would create a window
 * where the router still trusts evidence the prober has already given up on,
 * or the reverse.
 */
export const HEALTH_EVIDENCE_MAX_AGE_MS = 120_000;

export type WorkerIneligibilityReason =
  | "EXCLUDED_WORKER"
  | "STATUS_NOT_ACTIVE"
  | "RUNTIME_NOT_SUPPORTED"
  | "HEALTH_NOT_HEALTHY"
  | "NOT_AVAILABLE"
  | "WORKER_KIND_MISMATCH"
  | "MISSING_REQUIRED_CAPABILITIES"
  /** Never probed: `healthy` written by anything other than a probe is not evidence. */
  | "HEALTH_EVIDENCE_MISSING"
  /** Probed, but too long ago to still describe the worker. */
  | "HEALTH_EVIDENCE_STALE"
  /** Already holding its declared concurrent maximum. */
  | "AT_CAPACITY"
  /** The SHARED pool this worker draws from is fully committed. */
  | "CAPACITY_POOL_SATURATED";

/**
 * How old health evidence may be and still count (M5.2).
 *
 * The clock arrives as DATA, never as a `Date.now()` call inside this module.
 * That is what lets a freshness rule live in a pure matcher: the same
 * (worker, now, maxAgeMs) triple always produces the same verdict, so a
 * routing decision is still reproducible after a restart — which is exactly
 * the property decision 0031 certified and must not lose.
 */
export interface HealthEvidenceHorizon {
  /** ISO instant the decision is being made at. */
  now: string;
  /** Maximum age of probe evidence, in milliseconds. Must be > 0. */
  maxAgeMs: number;
}

/**
 * Durable load, derived — never a counter (M5.3).
 *
 * Both maps are COUNTS OF NON-TERMINAL DISPATCH ATTEMPTS, read from the ledger
 * that already certifies exactly-once dispatch per task. Passing them as data
 * keeps the matcher pure, and deriving them from durable rows is what makes the
 * resulting distribution survive a restart. An in-memory round-robin counter
 * would produce a different assignment after a restart and silently break
 * ROUTING_SURVIVES_RESTART (decision 0031).
 */
export interface WorkerLoadSnapshot {
  /** workerId -> active executions currently assigned to it. */
  byWorkerId: Readonly<Record<string, number>>;
  /** capacityPool -> active executions currently charged to that pool. */
  byCapacityPool?: Readonly<Record<string, number>>;
  /**
   * capacityPool -> the EFFECTIVE ceiling for that pool, i.e. the smallest limit
   * any member declares (see effectiveCapacityPoolLimits). Derived once by the
   * caller so the per-worker gate cannot be fooled by one member declaring a
   * larger quota than its peers.
   */
  capacityPoolLimits?: Readonly<Record<string, number>>;
}

export interface WorkerRequirement {
  /** Every one of these must be present on the worker. Empty/absent = no capability constraint. */
  requiredCapabilities?: readonly string[];
  /** Optional hard filter on worker kind. */
  workerKind?: string | null;
  /** Worker ids that must not be selected (self-review, repair retry on a burnt worker). */
  excludeWorkerIds?: readonly string[];
  /**
   * Health-evidence freshness policy (M5.2).
   *
   * Omitted means the caller cannot date the evidence, so the age gates do not
   * run. That is NOT a fail-open hole: `health` itself still has to be exactly
   * `healthy`, and the durable sweeper
   * (WorkerHealthProber.expireStaleEvidence) independently resets expired
   * evidence to `unknown` in the database, so a stale worker stops being
   * eligible for every consumer, horizon or not. Passing a horizon makes the
   * refusal immediate instead of eventual, and the capability router always
   * passes one.
   */
  evidenceHorizon?: HealthEvidenceHorizon;
  /**
   * Durable load (M5.3). Omitted means "load unknown", in which case the
   * capacity gates do not run and ordering falls back to worker id — exactly
   * the pre-M5.3 behaviour. That is safe for the synchronous consumers
   * (reviewer selection, bounded repair), which pick ONE worker for ONE
   * decision and cannot oversubscribe a fleet; the dispatch path always passes
   * it, and the atomic guard in the dispatch ledger is what actually enforces
   * capacity under concurrency.
   */
  load?: WorkerLoadSnapshot;
}

export interface WorkerEligibilityVerdict {
  workerId: string;
  eligible: boolean;
  /** All failing gates, always in the same fixed order. Empty iff eligible. */
  reasons: WorkerIneligibilityReason[];
  /** Deduplicated, sorted. Empty unless MISSING_REQUIRED_CAPABILITIES is present. */
  missingCapabilities: string[];
}

/**
 * Evaluates one worker against one requirement.
 *
 * Collects EVERY failing gate rather than short-circuiting: a routing decision
 * that cannot say why it refused is not auditable evidence.
 */
export function evaluateWorkerEligibility(
  worker: WorkerRegistryEntry,
  requirement: WorkerRequirement = {},
): WorkerEligibilityVerdict {
  const reasons: WorkerIneligibilityReason[] = [];

  if (requirement.excludeWorkerIds?.includes(worker.id)) {
    reasons.push("EXCLUDED_WORKER");
  }

  if (worker.status !== ELIGIBLE_WORKER_STATUS) {
    reasons.push("STATUS_NOT_ACTIVE");
  }

  if (worker.runtimeSupport !== ELIGIBLE_RUNTIME_SUPPORT) {
    reasons.push("RUNTIME_NOT_SUPPORTED");
  }

  if (worker.health !== ELIGIBLE_WORKER_HEALTH) {
    reasons.push("HEALTH_NOT_HEALTHY");
  }

  if (worker.availability !== ELIGIBLE_WORKER_AVAILABILITY) {
    reasons.push("NOT_AVAILABLE");
  }

  if (requirement.workerKind && worker.workerKind !== requirement.workerKind) {
    reasons.push("WORKER_KIND_MISMATCH");
  }

  if (requirement.evidenceHorizon) {
    const { now, maxAgeMs } = requirement.evidenceHorizon;
    if (!worker.lastProbeAt) {
      reasons.push("HEALTH_EVIDENCE_MISSING");
    } else if (isEvidenceStale(worker.lastProbeAt, now, maxAgeMs)) {
      reasons.push("HEALTH_EVIDENCE_STALE");
    }
  }

  if (requirement.load) {
    const active = requirement.load.byWorkerId[worker.id] ?? 0;
    if (active >= worker.maxConcurrency) {
      reasons.push("AT_CAPACITY");
    }

    /*
     * A pool is a SHARED ceiling: several distinct workers may be drawing on one
     * provider/account quota, so a worker can be idle and still have nowhere to
     * run. Without this, per-worker limits would silently multiply the quota by
     * the number of workers pointed at it.
     */
    if (worker.capacityPool) {
      const declared = worker.capacityPoolLimit;
      const effective = requirement.load.capacityPoolLimits?.[worker.capacityPool];
      // The pool ceiling is the SMALLEST limit anyone declared for it.
      const limit =
        declared === null || declared === undefined
          ? effective
          : effective === undefined
            ? declared
            : Math.min(declared, effective);

      if (limit !== undefined) {
        const poolActive = requirement.load.byCapacityPool?.[worker.capacityPool] ?? 0;
        if (poolActive >= limit) {
          reasons.push("CAPACITY_POOL_SATURATED");
        }
      }
    }
  }

  const owned = new Set(worker.capabilities);
  const missingCapabilities = [
    ...new Set((requirement.requiredCapabilities ?? []).filter((cap) => !owned.has(cap))),
  ].sort();

  if (missingCapabilities.length > 0) {
    reasons.push("MISSING_REQUIRED_CAPABILITIES");
  }

  return {
    workerId: worker.id,
    eligible: reasons.length === 0,
    reasons,
    missingCapabilities,
  };
}

/** Verdict for every candidate, sorted by worker id. Durable routing evidence. */
export function evaluateWorkerPool(
  workers: readonly WorkerRegistryEntry[],
  requirement: WorkerRequirement = {},
): WorkerEligibilityVerdict[] {
  return workers
    .map((worker) => evaluateWorkerEligibility(worker, requirement))
    .sort((a, b) => a.workerId.localeCompare(b.workerId));
}

/**
 * The eligible subset, in deterministic order.
 *
 * ORDERING IS THE DISTRIBUTION POLICY (M5.3): least durable load first, worker
 * id as the tie-break. Nothing else. That is the simplest rule that actually
 * distributes, and — crucially — it is a pure function of durable rows, so two
 * processes, or the same process before and after a restart, derive the SAME
 * order from the same database. A clock, a random pick or an in-memory
 * round-robin cursor would each distribute too, and each would destroy
 * ROUTING_SURVIVES_RESTART (decision 0031).
 *
 * With no load snapshot the order is by id alone — the pre-M5.3 behaviour, kept
 * for the synchronous single-decision consumers.
 */
export function selectEligibleWorkers(
  workers: readonly WorkerRegistryEntry[],
  requirement: WorkerRequirement = {},
): WorkerRegistryEntry[] {
  const load = requirement.load;

  return workers
    .filter((worker) => evaluateWorkerEligibility(worker, requirement).eligible)
    .sort((a, b) => {
      if (load) {
        const delta = (load.byWorkerId[a.id] ?? 0) - (load.byWorkerId[b.id] ?? 0);
        if (delta !== 0) {
          return delta;
        }
      }
      return a.id.localeCompare(b.id);
    });
}

/**
 * Derives a load snapshot from durable worker assignments (M5.3).
 *
 * `assignments` is the list of worker ids on NON-TERMINAL dispatch attempts —
 * one entry per active execution, duplicates included. The pool tally needs the
 * registry too, because which pool an assignment is charged to is a property of
 * the worker, not of the attempt.
 *
 * Kept here, next to the gates that consume it, so there is exactly one
 * definition of "load" for the whole system.
 */
export function computeWorkerLoad(
  assignments: readonly string[],
  workers: readonly WorkerRegistryEntry[],
): WorkerLoadSnapshot {
  const poolOf = new Map(workers.map((worker) => [worker.id, worker.capacityPool] as const));
  const byWorkerId: Record<string, number> = {};
  const byCapacityPool: Record<string, number> = {};

  for (const workerId of assignments) {
    byWorkerId[workerId] = (byWorkerId[workerId] ?? 0) + 1;
    const pool = poolOf.get(workerId);
    if (pool) {
      byCapacityPool[pool] = (byCapacityPool[pool] ?? 0) + 1;
    }
  }

  return { byWorkerId, byCapacityPool, capacityPoolLimits: effectiveCapacityPoolLimits(workers) };
}

/**
 * The smallest pool ceiling declared by any worker in a pool (M5.5).
 *
 * Workers in one pool may disagree about its size. A quota is a CEILING, so
 * disagreement resolves DOWNWARDS: taking the largest, or the first seen, would
 * let one misdeclared worker raise everyone else's limit.
 */
export function effectiveCapacityPoolLimits(
  workers: readonly WorkerRegistryEntry[],
): Record<string, number> {
  const limits: Record<string, number> = {};

  for (const worker of workers) {
    if (!worker.capacityPool || worker.capacityPoolLimit === null) {
      continue;
    }
    const current = limits[worker.capacityPool];
    limits[worker.capacityPool] =
      current === undefined ? worker.capacityPoolLimit : Math.min(current, worker.capacityPoolLimit);
  }

  return limits;
}

/** The single winner, or null when nothing is eligible. Never throws, never guesses. */
export function selectWorker(
  workers: readonly WorkerRegistryEntry[],
  requirement: WorkerRequirement = {},
): WorkerRegistryEntry | null {
  return selectEligibleWorkers(workers, requirement)[0] ?? null;
}

/**
 * True when probe evidence is older than the horizon allows.
 *
 * An unparseable timestamp is STALE, not fresh: garbage in a freshness field
 * must not buy a worker eligibility. Evidence dated in the future is accepted
 * as fresh (clock skew between a worker host and the router is not the
 * worker's fault, and treating skew as staleness would take a healthy fleet
 * offline).
 */
function isEvidenceStale(lastProbeAt: string, now: string, maxAgeMs: number): boolean {
  const probed = Date.parse(lastProbeAt);
  const reference = Date.parse(now);
  if (Number.isNaN(probed) || Number.isNaN(reference)) {
    return true;
  }
  return reference - probed > maxAgeMs;
}
