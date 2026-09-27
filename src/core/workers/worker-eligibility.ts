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

export type WorkerIneligibilityReason =
  | "EXCLUDED_WORKER"
  | "STATUS_NOT_ACTIVE"
  | "RUNTIME_NOT_SUPPORTED"
  | "HEALTH_NOT_HEALTHY"
  | "NOT_AVAILABLE"
  | "WORKER_KIND_MISMATCH"
  | "MISSING_REQUIRED_CAPABILITIES";

export interface WorkerRequirement {
  /** Every one of these must be present on the worker. Empty/absent = no capability constraint. */
  requiredCapabilities?: readonly string[];
  /** Optional hard filter on worker kind. */
  workerKind?: string | null;
  /** Worker ids that must not be selected (self-review, repair retry on a burnt worker). */
  excludeWorkerIds?: readonly string[];
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
 * Ordering is by worker id and nothing else. No scoring, no load balancing, no
 * "most recently healthy" — anything derived from a clock or a counter would
 * make the same inputs produce different routes across a restart.
 */
export function selectEligibleWorkers(
  workers: readonly WorkerRegistryEntry[],
  requirement: WorkerRequirement = {},
): WorkerRegistryEntry[] {
  return workers
    .filter((worker) => evaluateWorkerEligibility(worker, requirement).eligible)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The single winner, or null when nothing is eligible. Never throws, never guesses. */
export function selectWorker(
  workers: readonly WorkerRegistryEntry[],
  requirement: WorkerRequirement = {},
): WorkerRegistryEntry | null {
  return selectEligibleWorkers(workers, requirement)[0] ?? null;
}
