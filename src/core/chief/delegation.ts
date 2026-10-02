import { UNKNOWN, type WorkClass } from "@/core/supervisor/contracts";

import type { ClassifiedObjective, EscalationKind } from "./objective-classification";

/**
 * CHIEF → BRAIN DELEGATION POLICY. Pure and deterministic: no clock, no randomness, no
 * env, no database, no model call. Same inputs, same plan, forever.
 *
 * It answers ONE question — for this objective, which brain takes which part, what may
 * run in parallel, and who reviews — and it executes nothing. Dispatch, worktrees,
 * assignment records and model/provider choice belong to the workforce, the scheduler and
 * OmniRoute respectively; this module has no path to any of them.
 *
 * It deliberately does NOT import the workforce: `src/core/workforce/delegation.ts`
 * `planDelegation` is the AGENT-level authority (a supervisor's direct reports, a
 * `WorkAssignment` per request). This is the OBJECTIVE-level shape above it, over the
 * minimal `BrainDescriptor` view below, so the brain registry can be adapted onto it at
 * integration without this policy depending on its storage.
 *
 * Fail closed everywhere: no capability match means an explicit unmet need (never an
 * arbitrary stand-in), a non-active brain is excluded AND reported, over-subscription is
 * deferred (never dropped), and a plan that cannot find an independent reviewer is
 * refused rather than quietly repaired.
 */

export type AutonomyLevel = 0 | 1 | 2 | 3;

/**
 * The minimal structural view this policy needs of a brain. Field names are fixed by the
 * integration contract; the real registry is adapted onto this, not the other way round.
 */
export interface BrainDescriptor {
  readonly brainId: string;
  readonly role: string;
  readonly capabilities: readonly string[];
  readonly autonomyLevel: 0 | 1 | 2 | 3;
  readonly status: "active" | "suspended" | "retired" | "blocked";
  readonly maxConcurrentAssignments: number;
  readonly reviewPolicy: "never" | "if_risky" | "always";
}

/**
 * Same value as the workforce's own constant, by convention rather than by import: this
 * module stays free of workforce types. If the two ever diverge, the workforce wins.
 */
export const INDEPENDENT_REVIEW_CAPABILITY = "independent_review";

/** A part of an objective, and the capability a brain must declare to take it. */
export interface DelegationStage {
  readonly stage: string;
  readonly capability: string;
  /** Stages sharing a wave may run in parallel. Lower waves run first. */
  readonly wave: number;
}

/**
 * The fan-out shape per work class, as DATA. SELF_IMPROVEMENT enters through Evolution,
 * which then requests Architect / Research / Builder / Recovery / Memory in parallel;
 * review is independent and always last (see `pickReviewer`).
 *
 * A work class with no shape is refused, not improvised.
 */
export const DELEGATION_SHAPES: Readonly<
  Partial<Record<WorkClass, readonly DelegationStage[]>>
> = {
  SELF_IMPROVEMENT: [
    { stage: "EVOLUTION", capability: "self_improvement_planning", wave: 0 },
    { stage: "ARCHITECT", capability: "architecture_design", wave: 1 },
    { stage: "RESEARCH", capability: "research", wave: 1 },
    { stage: "BUILDER", capability: "implementation", wave: 1 },
    { stage: "RECOVERY", capability: "recovery", wave: 1 },
    { stage: "MEMORY", capability: "memory_curation", wave: 1 },
  ],
  CLIENT: [
    { stage: "CLIENT_LEAD", capability: "client_audit", wave: 0 },
    { stage: "RESEARCH", capability: "research", wave: 1 },
    { stage: "BUILDER", capability: "implementation", wave: 1 },
  ],
};

/**
 * Capabilities this layer refuses to schedule at all. Whoever edits a shape table later
 * cannot smuggle a deploy or a credential grant into an autonomous plan: the stage is
 * dropped and the matching escalation is raised to the owner instead.
 */
const FORBIDDEN_CAPABILITIES: readonly {
  readonly kind: EscalationKind;
  readonly match: RegExp;
}[] = [
  { kind: "DEPLOYMENT", match: /deploy|deploi|release|ship_to_prod|production/ },
  { kind: "CREDENTIALS", match: /credential|secret|api[_-]?key|token/ },
  { kind: "PERMISSIONS", match: /permission|grant|privilege|role[_-]?admin/ },
  { kind: "POLICY_DISABLING", match: /disabl|bypass|policy/ },
];

/** Union of the above; exported so a caller can assert its own shape table. */
export const FORBIDDEN_CAPABILITY = new RegExp(
  FORBIDDEN_CAPABILITIES.map((f) => f.match.source).join("|"),
);

export interface DelegationAssignment {
  readonly stage: string;
  readonly capability: string;
  readonly brainId: string;
  readonly role: string;
  readonly wave: number;
  /** Never above the brain's own level, never above the caller's ceiling. */
  readonly autonomyLevel: AutonomyLevel;
  readonly reviewRequired: boolean;
}

export type DeferralReason = "BRAIN_AT_CAPACITY" | "PARALLELISM_LIMIT";

/** Queued, NOT dropped: the work is still owed and the reason is stated. */
export interface DeferredAssignment extends DelegationAssignment {
  readonly reason: DeferralReason;
}

export interface UnmetNeed {
  readonly stage: string;
  readonly capability: string;
  readonly reason: "NO_ACTIVE_BRAIN_WITH_CAPABILITY";
}

export interface ExcludedBrain {
  readonly brainId: string;
  readonly status: BrainDescriptor["status"];
}

export interface DelegationLimits {
  /** Overall cap on assignments the plan may start concurrently. The reviewer is extra. */
  readonly maxParallelAssignments: number;
  /** Policy ceiling. The caller states it; silence is not a ceiling. */
  readonly maxAutonomyLevel: AutonomyLevel;
}

export interface DelegationPlan {
  readonly workClass: WorkClass;
  readonly assignments: readonly DelegationAssignment[];
  readonly deferred: readonly DeferredAssignment[];
  readonly unmetNeeds: readonly UnmetNeed[];
  readonly excludedBrains: readonly ExcludedBrain[];
  readonly review: DelegationAssignment;
  /** What the plan refuses to do by itself. Goes to Geoffrey, never to a brain. */
  readonly humanApprovalRequired: readonly EscalationKind[];
  readonly maxAutonomyLevel: AutonomyLevel;
}

export type DelegationRefusal =
  | "OBJECTIVE_NOT_CLASSIFIED"
  | "NO_SHAPE_FOR_WORK_CLASS"
  | "NO_ELIGIBLE_BRAIN"
  | "NO_INDEPENDENT_REVIEWER"
  | "REVIEWER_NOT_INDEPENDENT";

export type DelegationOutcome =
  | { readonly ok: true; readonly plan: DelegationPlan }
  | {
      readonly ok: false;
      readonly refusals: readonly DelegationRefusal[];
      readonly excludedBrains: readonly ExcludedBrain[];
    };

const byBrainId = (a: { brainId: string }, b: { brainId: string }) =>
  a.brainId.localeCompare(b.brainId);

const cap = (level: AutonomyLevel, ceiling: AutonomyLevel): AutonomyLevel =>
  (level < ceiling ? level : ceiling) as AutonomyLevel;

export function planDelegation(
  objective: ClassifiedObjective,
  brains: readonly BrainDescriptor[],
  limits: DelegationLimits,
  shapeOverride?: readonly DelegationStage[],
): DelegationOutcome {
  const excludedBrains: ExcludedBrain[] = brains
    .filter((b) => b.status !== "active")
    .map((b) => ({ brainId: b.brainId, status: b.status }))
    .sort(byBrainId);

  if (objective.workClass === UNKNOWN) {
    return { ok: false, refusals: ["OBJECTIVE_NOT_CLASSIFIED"], excludedBrains };
  }
  const shape = shapeOverride ?? DELEGATION_SHAPES[objective.workClass];
  if (!shape) return { ok: false, refusals: ["NO_SHAPE_FOR_WORK_CLASS"], excludedBrains };

  const active = brains.filter((b) => b.status === "active").sort(byBrainId);
  const risky = objective.escalations.length > 0;
  const humanApproval = new Set<EscalationKind>(objective.escalations);

  const assignments: DelegationAssignment[] = [];
  const deferred: DeferredAssignment[] = [];
  const unmetNeeds: UnmetNeed[] = [];
  /* Load accrues as the plan is built, so one brain is not booked twice over its cap. */
  const load = new Map<string, number>();
  const taken = (brainId: string) => load.get(brainId) ?? 0;

  for (const stage of [...shape].sort((a, b) => a.wave - b.wave)) {
    const forbidden = FORBIDDEN_CAPABILITIES.find((f) => f.match.test(stage.capability));
    if (forbidden) {
      humanApproval.add(forbidden.kind);
      continue;
    }

    /* Eligibility is DECLARED capability only. No permissive fallback, ever. */
    const eligible = active
      .filter((b) => b.capabilities.includes(stage.capability))
      .sort((a, b) => taken(a.brainId) - taken(b.brainId) || byBrainId(a, b));
    if (eligible.length === 0) {
      unmetNeeds.push({
        stage: stage.stage,
        capability: stage.capability,
        reason: "NO_ACTIVE_BRAIN_WITH_CAPABILITY",
      });
      continue;
    }

    const free = eligible.find((b) => taken(b.brainId) < b.maxConcurrentAssignments);
    const chosen = free ?? eligible[0];
    const item: DelegationAssignment = {
      stage: stage.stage,
      capability: stage.capability,
      brainId: chosen.brainId,
      role: chosen.role,
      wave: stage.wave,
      autonomyLevel: cap(chosen.autonomyLevel, limits.maxAutonomyLevel),
      reviewRequired:
        chosen.reviewPolicy === "always" || (chosen.reviewPolicy === "if_risky" && risky),
    };
    /* A deferred item still owes this brain a slot: count it either way. */
    load.set(chosen.brainId, taken(chosen.brainId) + 1);

    if (!free) deferred.push({ ...item, reason: "BRAIN_AT_CAPACITY" });
    else if (assignments.length >= limits.maxParallelAssignments)
      deferred.push({ ...item, reason: "PARALLELISM_LIMIT" });
    else assignments.push(item);
  }

  if (assignments.length === 0 && deferred.length === 0) {
    return { ok: false, refusals: ["NO_ELIGIBLE_BRAIN"], excludedBrains };
  }

  /*
   * Owner policy: no implementation worker reviews its own work as the only reviewer.
   * A queued implementer counts as an implementer — it will do the work later.
   */
  const implementers = new Set([...assignments, ...deferred].map((a) => a.brainId));
  const reviewCandidates = active.filter((b) =>
    b.capabilities.includes(INDEPENDENT_REVIEW_CAPABILITY),
  );
  if (reviewCandidates.length === 0) {
    return { ok: false, refusals: ["NO_INDEPENDENT_REVIEWER"], excludedBrains };
  }
  const reviewer = reviewCandidates.find((b) => !implementers.has(b.brainId));
  if (!reviewer) return { ok: false, refusals: ["REVIEWER_NOT_INDEPENDENT"], excludedBrains };

  const reviewWave = Math.max(...shape.map((s) => s.wave)) + 1;
  const review: DelegationAssignment = {
    stage: "REVIEWER",
    capability: INDEPENDENT_REVIEW_CAPABILITY,
    brainId: reviewer.brainId,
    role: reviewer.role,
    wave: reviewWave,
    autonomyLevel: cap(reviewer.autonomyLevel, limits.maxAutonomyLevel),
    reviewRequired:
      reviewer.reviewPolicy === "always" || (reviewer.reviewPolicy === "if_risky" && risky),
  };

  return {
    ok: true,
    plan: {
      workClass: objective.workClass,
      assignments,
      deferred,
      unmetNeeds,
      excludedBrains,
      review,
      /* Ordered by ESCALATION_KINDS, not by discovery, so the plan is comparable. */
      humanApprovalRequired: FORBIDDEN_CAPABILITIES.map((f) => f.kind).filter((k) =>
        humanApproval.has(k),
      ),
      maxAutonomyLevel: limits.maxAutonomyLevel,
    },
  };
}
