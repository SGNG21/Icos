import { WORK_CLASSES, type WorkClass } from "./contracts";

/**
 * PORTFOLIO GOVERNOR (decision 0065). Pure, deterministic, admission-time only.
 *
 * It is consulted ONCE, before a `start_mission` job is enqueued, and it never inspects
 * or alters work that is already running. Holding, pausing and cancelling running work
 * stays with RuntimeControlGuard and the control plane: this module has no path to them
 * and cannot substitute for them.
 *
 * It has no REJECT outcome. Pressure defers; the deferral is expressed as `runAt` on the
 * existing durable job, so the existing scheduler — not a new loop — brings the work back.
 */

export interface ClassCaps {
  readonly maxConcurrent: number;
  /** Slots held for this class that no other class may draw from the global pool. */
  readonly reserved: number;
  readonly computeBudgetUnits: number;
}

export interface PortfolioPolicy {
  readonly version: string;
  readonly classes: Readonly<Record<WorkClass, ClassCaps>>;
  /**
   * Must EXCEED the sum of every class's `reserved`, or there is no shared pool at all and
   * the only class with demand is capped at its own reservation while idle classes hold
   * the rest. `assertPortfolioPolicyCoherent` checks this.
   */
  readonly globalMaxConcurrent: number;
  readonly windowMs: number;
  readonly deferBackoffMs: number;
}

export const DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy = {
  version: "portfolio/2026-10-02",
  classes: {
    USER: { maxConcurrent: 4, reserved: 2, computeBudgetUnits: 400 },
    CLIENT: { maxConcurrent: 4, reserved: 2, computeBudgetUnits: 400 },
    REVENUE: { maxConcurrent: 2, reserved: 1, computeBudgetUnits: 200 },
    SECURITY: { maxConcurrent: 2, reserved: 1, computeBudgetUnits: 200 },
    MAINTENANCE: { maxConcurrent: 2, reserved: 1, computeBudgetUnits: 150 },
    SELF_IMPROVEMENT: { maxConcurrent: 2, reserved: 1, computeBudgetUnits: 150 },
    RESEARCH: { maxConcurrent: 1, reserved: 1, computeBudgetUnits: 100 },
  },
  /*
   * 12, not 10: reservations total 9, so a 10-slot pool left ONE shared slot and USER —
   * the class every conversation-launched goal lands in — saturated at 3 while six idle
   * classes held seven slots for work nobody had asked for. A reservation is a floor, not
   * a standing claim on a pool nobody else is using.
   */
  globalMaxConcurrent: 12,
  windowMs: 60 * 60_000,
  deferBackoffMs: 5 * 60_000,
};

export interface PortfolioState {
  readonly windowStartedAt: Date;
  readonly active: Readonly<Record<WorkClass, number>>;
  readonly computeSpent: Readonly<Record<WorkClass, number>>;
}

export interface AllocationCandidate {
  readonly class: WorkClass;
  readonly computeUnits: number;
}

export interface AllocationEvidence {
  readonly policyVersion: string;
  readonly class: WorkClass;
  readonly activeInClass: number;
  readonly maxConcurrent: number;
  readonly reservedElsewhere: number;
  readonly globalActive: number;
  readonly globalMax: number;
  readonly slotsAvailable: number;
  readonly computeSpent: number;
  readonly computeBudget: number;
  readonly computeRequested: number;
  readonly windowEndsAt: string;
}

export type DeferReason = "CLASS_CONCURRENCY" | "GLOBAL_CONCURRENCY" | "COMPUTE_BUDGET";

export type AllocationDecision =
  | { readonly admit: true; readonly evidence: AllocationEvidence }
  | {
      readonly admit: false;
      readonly defer: true;
      readonly reason: DeferReason;
      readonly retryAfterMs: number;
      readonly evidence: AllocationEvidence;
    };

/**
 * Rejects a policy whose own numbers cannot be satisfied. Called at composition, not per
 * allocation: a policy that over-subscribes its pool deadlocks EVERY class at once, and
 * that must fail loudly at wiring time rather than look like a quiet capacity shortage.
 */
export function assertPortfolioPolicyCoherent(policy: PortfolioPolicy): void {
  let totalReserved = 0;
  for (const c of WORK_CLASSES) {
    const caps = policy.classes[c];
    if (caps.reserved > caps.maxConcurrent) {
      throw new Error(
        `PORTFOLIO_POLICY_INCOHERENT: ${c} reserved ${caps.reserved} exceeds its maxConcurrent ${caps.maxConcurrent}`,
      );
    }
    totalReserved += caps.reserved;
  }
  if (policy.globalMaxConcurrent <= totalReserved) {
    throw new Error(
      `PORTFOLIO_POLICY_INCOHERENT: globalMaxConcurrent ${policy.globalMaxConcurrent} leaves no shared pool above reserved ${totalReserved}`,
    );
  }
}

export function allocate(
  policy: PortfolioPolicy,
  state: PortfolioState,
  candidate: AllocationCandidate,
  now: Date,
): AllocationDecision {
  const caps = policy.classes[candidate.class];
  const windowEndsAt = new Date(state.windowStartedAt.getTime() + policy.windowMs);
  const windowElapsed = now.getTime() >= windowEndsAt.getTime();

  const activeInClass = state.active[candidate.class];
  const globalActive = WORK_CLASSES.reduce((sum, c) => sum + state.active[c], 0);

  /*
   * Only the UNUSED part of another class's reservation is held back. Counting the whole
   * reservation would double-count a class that is already using it and would deadlock the
   * global pool as soon as several classes were busy.
   */
  const reservedElsewhere = WORK_CLASSES.filter((c) => c !== candidate.class).reduce(
    (sum, c) => sum + Math.max(0, policy.classes[c].reserved - state.active[c]),
    0,
  );

  const classSlots = caps.maxConcurrent - activeInClass;
  /*
   * A class drawing WITHIN its own reservation is never refused for global pressure: that
   * is what reserving it means. Only draws ABOVE the reservation compete for the shared
   * pool, and only the UNUSED part of another class's reservation is withheld from it.
   */
  const withinOwnReservation = activeInClass < caps.reserved;
  const globalSlots = withinOwnReservation
    ? policy.globalMaxConcurrent - globalActive
    : policy.globalMaxConcurrent - globalActive - reservedElsewhere;
  const slotsAvailable = Math.min(classSlots, globalSlots);

  // A lapsed window has already refilled the budget; the caller resets `computeSpent`.
  const computeSpent = windowElapsed ? 0 : state.computeSpent[candidate.class];

  const evidence: AllocationEvidence = {
    policyVersion: policy.version,
    class: candidate.class,
    activeInClass,
    maxConcurrent: caps.maxConcurrent,
    reservedElsewhere,
    globalActive,
    globalMax: policy.globalMaxConcurrent,
    slotsAvailable,
    computeSpent,
    computeBudget: caps.computeBudgetUnits,
    computeRequested: candidate.computeUnits,
    windowEndsAt: windowEndsAt.toISOString(),
  };

  if (classSlots < 1) {
    return {
      admit: false,
      defer: true,
      reason: "CLASS_CONCURRENCY",
      retryAfterMs: policy.deferBackoffMs,
      evidence,
    };
  }
  if (globalSlots < 1) {
    return {
      admit: false,
      defer: true,
      reason: "GLOBAL_CONCURRENCY",
      retryAfterMs: policy.deferBackoffMs,
      evidence,
    };
  }
  if (computeSpent + candidate.computeUnits > caps.computeBudgetUnits) {
    return {
      admit: false,
      defer: true,
      reason: "COMPUTE_BUDGET",
      // Wait for the budget to refill, not a fixed backoff that would just re-defer.
      retryAfterMs: Math.max(0, windowEndsAt.getTime() - now.getTime()),
      evidence,
    };
  }

  return { admit: true, evidence };
}
