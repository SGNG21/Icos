import { describe, expect, it } from "vitest";

import { classifyRawObjective, type ClassifiedObjective } from "./objective-classification";
import {
  DELEGATION_SHAPES,
  FORBIDDEN_CAPABILITY,
  INDEPENDENT_REVIEW_CAPABILITY,
  planDelegation,
  type BrainDescriptor,
  type DelegationLimits,
} from "./delegation";

const brain = (over: Partial<BrainDescriptor> & { brainId: string }): BrainDescriptor => ({
  role: "BUILDER",
  capabilities: ["implementation"],
  autonomyLevel: 2,
  status: "active",
  maxConcurrentAssignments: 1,
  reviewPolicy: "if_risky",
  ...over,
});

/** One active brain per SELF_IMPROVEMENT stage, plus an independent reviewer. */
const fullFleet = (): BrainDescriptor[] => [
  brain({ brainId: "b-evolution", role: "EVOLUTION", capabilities: ["self_improvement_planning"] }),
  brain({ brainId: "b-architect", role: "ARCHITECT", capabilities: ["architecture_design"] }),
  brain({ brainId: "b-research", role: "RESEARCH", capabilities: ["research"] }),
  brain({ brainId: "b-builder", role: "BUILDER", capabilities: ["implementation"] }),
  brain({ brainId: "b-recovery", role: "RECOVERY", capabilities: ["recovery"] }),
  brain({ brainId: "b-memory", role: "MEMORY", capabilities: ["memory_curation"] }),
  brain({
    brainId: "b-reviewer",
    role: "REVIEWER",
    capabilities: [INDEPENDENT_REVIEW_CAPABILITY],
  }),
];

const LIMITS: DelegationLimits = { maxParallelAssignments: 10, maxAutonomyLevel: 3 };

const SELF_IMPROVEMENT = classifyRawObjective("Améliore ICOS.");

const expectOk = (outcome: ReturnType<typeof planDelegation>) => {
  if (!outcome.ok) throw new Error(`expected a plan, got refusals ${outcome.refusals.join(",")}`);
  return outcome.plan;
};

describe("chief delegation — self-improvement fan-out", () => {
  it("routes Améliore ICOS to the Evolution brain first, then fans out", () => {
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fullFleet(), LIMITS));
    expect(plan.workClass).toBe("SELF_IMPROVEMENT");
    expect(plan.assignments[0]).toMatchObject({ role: "EVOLUTION", wave: 0 });
    expect(
      plan.assignments
        .filter((a) => a.wave === 1)
        .map((a) => a.role)
        .sort(),
    ).toEqual(["ARCHITECT", "BUILDER", "MEMORY", "RECOVERY", "RESEARCH"]);
    expect(plan.unmetNeeds).toEqual([]);
  });

  it("names the independent reviewer in a later wave than every implementer", () => {
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fullFleet(), LIMITS));
    expect(plan.review.brainId).toBe("b-reviewer");
    expect(plan.review.wave).toBeGreaterThan(Math.max(...plan.assignments.map((a) => a.wave)));
  });

  it("is deterministic: same inputs, same plan", () => {
    const a = planDelegation(SELF_IMPROVEMENT, fullFleet(), LIMITS);
    const b = planDelegation(SELF_IMPROVEMENT, [...fullFleet()].reverse(), LIMITS);
    expect(a).toEqual(b);
  });

  it("refuses an objective that did not classify", () => {
    const outcome = planDelegation(
      classifyRawObjective("Quelle heure est-il ?"),
      fullFleet(),
      LIMITS,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toContain("OBJECTIVE_NOT_CLASSIFIED");
  });
});

describe("chief delegation — only active brains, and absences are reported", () => {
  it("never selects a suspended, retired or blocked brain and reports its exclusion", () => {
    const fleet = fullFleet().map((b) =>
      b.brainId === "b-builder" ? { ...b, status: "suspended" as const } : b,
    );
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    expect(plan.assignments.map((a) => a.brainId)).not.toContain("b-builder");
    expect(plan.excludedBrains).toEqual([{ brainId: "b-builder", status: "suspended" }]);
  });

  it("reports an unmet capability instead of back-filling an arbitrary brain", () => {
    const fleet = fullFleet().filter((b) => b.brainId !== "b-research");
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    expect(plan.unmetNeeds).toEqual([
      { stage: "RESEARCH", capability: "research", reason: "NO_ACTIVE_BRAIN_WITH_CAPABILITY" },
    ]);
    expect(plan.assignments.map((a) => a.capability)).not.toContain("research");
    /* no brain picked up a capability it does not declare */
    for (const a of plan.assignments) {
      const picked = fleet.find((b) => b.brainId === a.brainId)!;
      expect(picked.capabilities).toContain(a.capability);
    }
  });

  it("refuses when no active brain can take any part of the work", () => {
    const fleet = fullFleet().map((b) => ({ ...b, status: "retired" as const }));
    const outcome = planDelegation(SELF_IMPROVEMENT, fleet, LIMITS);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusals).toContain("NO_ELIGIBLE_BRAIN");
      expect(outcome.excludedBrains).toHaveLength(fleet.length);
    }
  });
});

describe("chief delegation — reviewer independence is owner policy", () => {
  it("refuses a plan whose only reviewer is also an implementer, instead of repairing it", () => {
    const fleet = fullFleet()
      .filter((b) => b.brainId !== "b-reviewer")
      .map((b) =>
        b.brainId === "b-builder"
          ? { ...b, capabilities: [...b.capabilities, INDEPENDENT_REVIEW_CAPABILITY] }
          : b,
      );
    const outcome = planDelegation(SELF_IMPROVEMENT, fleet, LIMITS);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toEqual(["REVIEWER_NOT_INDEPENDENT"]);
  });

  it("refuses when nobody at all declares the review capability", () => {
    const fleet = fullFleet().filter((b) => b.brainId !== "b-reviewer");
    const outcome = planDelegation(SELF_IMPROVEMENT, fleet, LIMITS);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toEqual(["NO_INDEPENDENT_REVIEWER"]);
  });

  it("does not use a reviewer that is merely DEFERRED as an implementer", () => {
    const fleet = fullFleet()
      .filter((b) => b.brainId !== "b-reviewer")
      .map((b) =>
        b.brainId === "b-memory"
          ? { ...b, capabilities: [...b.capabilities, INDEPENDENT_REVIEW_CAPABILITY] }
          : b,
      );
    /* one parallel slot: b-memory ends up queued, not assigned — still not independent */
    const outcome = planDelegation(SELF_IMPROVEMENT, fleet, {
      maxParallelAssignments: 1,
      maxAutonomyLevel: 3,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toEqual(["REVIEWER_NOT_INDEPENDENT"]);
  });

  it("marks review as required for a brain whose reviewPolicy is always", () => {
    const fleet = fullFleet().map((b) =>
      b.brainId === "b-builder" ? { ...b, reviewPolicy: "always" as const } : b,
    );
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    expect(plan.assignments.find((a) => a.brainId === "b-builder")?.reviewRequired).toBe(true);
    expect(plan.assignments.find((a) => a.brainId === "b-research")?.reviewRequired).toBe(false);
  });
});

describe("chief delegation — over-subscription defers, never drops", () => {
  it("defers the overflow of an overall parallelism limit and keeps every stage", () => {
    const plan = expectOk(
      planDelegation(SELF_IMPROVEMENT, fullFleet(), {
        maxParallelAssignments: 2,
        maxAutonomyLevel: 3,
      }),
    );
    expect(plan.assignments).toHaveLength(2);
    expect(plan.deferred).toHaveLength(4);
    expect(plan.deferred.map((d) => d.reason)).toEqual(Array(4).fill("PARALLELISM_LIMIT"));
    /* nothing was dropped: every shape stage is accounted for exactly once */
    expect([...plan.assignments, ...plan.deferred].map((a) => a.stage).sort()).toEqual(
      DELEGATION_SHAPES.SELF_IMPROVEMENT!.map((s) => s.stage).sort(),
    );
  });

  it("defers a second part rather than exceeding a brain's maxConcurrentAssignments", () => {
    /* one brain holds two capabilities but only one slot */
    const fleet: BrainDescriptor[] = [
      brain({
        brainId: "b-omni",
        role: "EVOLUTION",
        capabilities: ["self_improvement_planning", "research"],
        maxConcurrentAssignments: 1,
      }),
      brain({
        brainId: "b-reviewer",
        role: "REVIEWER",
        capabilities: [INDEPENDENT_REVIEW_CAPABILITY],
      }),
    ];
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    expect(plan.assignments.filter((a) => a.brainId === "b-omni")).toHaveLength(1);
    expect(plan.deferred).toEqual([
      expect.objectContaining({
        brainId: "b-omni",
        stage: "RESEARCH",
        reason: "BRAIN_AT_CAPACITY",
      }),
    ]);
  });
});

describe("chief delegation — no authority escalation", () => {
  it("never assigns a brain an autonomy level above its own", () => {
    const fleet = fullFleet().map((b) => ({ ...b, autonomyLevel: 1 as const }));
    const plan = expectOk(planDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    for (const a of [...plan.assignments, plan.review]) expect(a.autonomyLevel).toBe(1);
  });

  it("never assigns above the ceiling the caller passed in", () => {
    const plan = expectOk(
      planDelegation(SELF_IMPROVEMENT, fullFleet(), {
        maxParallelAssignments: 10,
        maxAutonomyLevel: 1,
      }),
    );
    for (const a of [...plan.assignments, plan.review])
      expect(a.autonomyLevel).toBeLessThanOrEqual(1);
  });

  it("sends deployment / credential / permission / policy work to the owner, and plans none of it", () => {
    const objective = classifyRawObjective(
      "Améliore ICOS, déploie en production avec une nouvelle API key, ouvre les permissions admin et désactive les tests.",
    );
    const plan = expectOk(planDelegation(objective, fullFleet(), LIMITS));
    expect(plan.humanApprovalRequired).toEqual([
      "DEPLOYMENT",
      "CREDENTIALS",
      "PERMISSIONS",
      "POLICY_DISABLING",
    ]);
    for (const a of [...plan.assignments, ...plan.deferred, plan.review]) {
      expect(FORBIDDEN_CAPABILITY.test(a.capability)).toBe(false);
    }
  });

  it("drops a forbidden stage from the shape table into human approval instead of planning it", () => {
    /* defence in depth: whoever edits DELEGATION_SHAPES later cannot smuggle deploy work in */
    const objective: ClassifiedObjective = { ...SELF_IMPROVEMENT, escalations: [] };
    const plan = expectOk(
      planDelegation(objective, fullFleet(), LIMITS, [
        { stage: "EVOLUTION", capability: "self_improvement_planning", wave: 0 },
        { stage: "SHIPPER", capability: "deployment", wave: 1 },
      ]),
    );
    expect(plan.assignments.map((a) => a.stage)).toEqual(["EVOLUTION"]);
    expect(plan.humanApprovalRequired).toContain("DEPLOYMENT");
  });

  it("declares no forbidden capability in any built-in shape", () => {
    for (const shape of Object.values(DELEGATION_SHAPES)) {
      for (const stage of shape ?? []) {
        expect(FORBIDDEN_CAPABILITY.test(stage.capability), stage.capability).toBe(false);
      }
    }
  });
});
