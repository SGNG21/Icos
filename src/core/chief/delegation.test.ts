import { describe, expect, it } from "vitest";

import { classifyRawObjective, type ClassifiedObjective } from "./objective-classification";
import {
  DELEGATION_SHAPES,
  FORBIDDEN_CAPABILITY,
  INDEPENDENT_REVIEW_CAPABILITY,
  planObjectiveDelegation,
  type BrainDescriptor,
  type DelegationLimits,
} from "./delegation";

const brain = (over: Partial<BrainDescriptor> & { brainId: string }): BrainDescriptor => ({
  role: "FULLSTACK_ENGINEER",
  capabilities: ["code_write"],
  autonomyLevel: 2,
  status: "active",
  maxConcurrentAssignments: 1,
  reviewPolicy: "if_risky",
  ...over,
});

/*
 * LA VRAIE FLOTTE : les douze identités canoniques, avec les ids et les capacités que le
 * registre produit RÉELLEMENT (rôles de `bootstrap/roles.json` composés de leurs skills).
 *
 * Les fixtures d'origine inventaient des ids (`b-evolution`) et des capacités
 * (`implementation`, `recovery`, `memory_curation`, `self_improvement_planning`) qui
 * n'existent dans AUCUN skill. Elles prouvaient donc l'algorithme contre un monde qui
 * n'existe pas — et c'est très exactement pour ça que la table des formes n'avait jamais pu
 * router : elle nommait des capacités introuvables.
 *
 * Noter les collisions RÉELLES, qui sont tout l'intérêt : Builder, Recovery et Evolution
 * partagent FULLSTACK_ENGINEER (donc `code_write`), Research et Memory partagent RESEARCHER,
 * et SALES_DIRECTOR déclare `independent_review` comme le relecteur.
 */
const fullFleet = (): BrainDescriptor[] => [
  brain({
    brainId: "brain-chief",
    role: "ICOS_CENTRAL",
    capabilities: ["capability_decomposition", "orchestration", "synthesis"],
    autonomyLevel: 3,
  }),
  brain({
    brainId: "brain-planner",
    role: "OPERATIONS_MANAGER",
    capabilities: ["planning", "process_management"],
  }),
  brain({
    brainId: "brain-architect",
    role: "SOFTWARE_ARCHITECT",
    capabilities: ["architecture_design", "code_review"],
  }),
  brain({ brainId: "brain-builder", capabilities: ["code_review", "code_write", "testing"] }),
  brain({
    brainId: "brain-reviewer",
    role: "INDEPENDENT_REVIEWER",
    capabilities: ["evidence_verification", INDEPENDENT_REVIEW_CAPABILITY],
  }),
  brain({ brainId: "brain-recovery", capabilities: ["code_review", "code_write", "testing"] }),
  brain({
    brainId: "brain-research",
    role: "RESEARCHER",
    capabilities: ["lead_research", "market_research", "research", "synthesis"],
  }),
  brain({
    brainId: "brain-business",
    role: "SALES_DIRECTOR",
    capabilities: [
      "evidence_verification",
      INDEPENDENT_REVIEW_CAPABILITY,
      "pipeline_management",
      "sales_strategy",
    ],
  }),
  brain({
    brainId: "brain-delivery",
    role: "DEVOPS_ENGINEER",
    capabilities: ["ci_cd", "infrastructure_ops"],
  }),
  brain({
    brainId: "brain-growth",
    role: "SEO_SPECIALIST",
    capabilities: ["keyword_research", "seo_audit"],
  }),
  brain({
    brainId: "brain-memory",
    role: "RESEARCHER",
    capabilities: ["lead_research", "market_research", "research", "synthesis"],
  }),
  brain({ brainId: "brain-evolution", capabilities: ["code_review", "code_write", "testing"] }),
];

const LIMITS: DelegationLimits = { maxParallelAssignments: 10, maxAutonomyLevel: 3 };

const SELF_IMPROVEMENT = classifyRawObjective("Améliore ICOS.");

const expectOk = (outcome: ReturnType<typeof planObjectiveDelegation>) => {
  if (!outcome.ok) throw new Error(`expected a plan, got refusals ${outcome.refusals.join(",")}`);
  return outcome.plan;
};

describe("chief delegation — self-improvement fan-out", () => {
  it("routes Améliore ICOS to the Evolution brain first, then fans out", () => {
    const plan = expectOk(planObjectiveDelegation(SELF_IMPROVEMENT, fullFleet(), LIMITS));
    expect(plan.workClass).toBe("SELF_IMPROVEMENT");
    /* L'IDENTITÉ, pas le rôle : Builder, Recovery et Evolution partagent le même rôle. */
    expect(plan.assignments[0]).toMatchObject({ brainId: "brain-evolution", wave: 0 });
    expect(
      plan.assignments
        .filter((a) => a.wave === 1)
        .map((a) => a.brainId)
        .sort(),
    ).toEqual(["brain-architect", "brain-builder", "brain-memory", "brain-research"]);
    expect(plan.unmetNeeds).toEqual([]);
  });

  it("names the independent reviewer in a later wave than every implementer", () => {
    const plan = expectOk(planObjectiveDelegation(SELF_IMPROVEMENT, fullFleet(), LIMITS));
    expect(plan.review.brainId).toBe("brain-reviewer");
    expect(plan.review.wave).toBeGreaterThan(Math.max(...plan.assignments.map((a) => a.wave)));
  });

  it("is deterministic: same inputs, same plan", () => {
    const a = planObjectiveDelegation(SELF_IMPROVEMENT, fullFleet(), LIMITS);
    const b = planObjectiveDelegation(SELF_IMPROVEMENT, [...fullFleet()].reverse(), LIMITS);
    expect(a).toEqual(b);
  });

  it("refuses an objective that did not classify", () => {
    const outcome = planObjectiveDelegation(
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
      b.brainId === "brain-builder" ? { ...b, status: "suspended" as const } : b,
    );
    const plan = expectOk(planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    expect(plan.assignments.map((a) => a.brainId)).not.toContain("brain-builder");
    expect(plan.excludedBrains).toEqual([{ brainId: "brain-builder", status: "suspended" }]);
    /*
     * ET SURTOUT : aucun remplaçant. `brain-recovery` et `brain-evolution` déclarent
     * exactement les mêmes capacités que Builder ; sans l'étape NOMMÉE, l'un d'eux aurait
     * pris sa place en silence et un cerveau suspendu n'aurait rien suspendu du tout.
     */
    expect(plan.unmetNeeds).toEqual([
      { stage: "BUILDER", capability: "code_write", reason: "NO_ACTIVE_BRAIN_WITH_CAPABILITY" },
    ]);
  });

  it("reports an unmet capability instead of back-filling an arbitrary brain", () => {
    const fleet = fullFleet().filter((b) => b.brainId !== "brain-research");
    const plan = expectOk(planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
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
    const outcome = planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS);
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
      .filter((b) => b.brainId !== "brain-reviewer" && b.brainId !== "brain-business")
      .map((b) =>
        b.brainId === "brain-builder"
          ? { ...b, capabilities: [...b.capabilities, INDEPENDENT_REVIEW_CAPABILITY] }
          : b,
      );
    const outcome = planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toEqual(["REVIEWER_NOT_INDEPENDENT"]);
  });

  it("refuses when nobody at all declares the review capability", () => {
    /* `brain-business` en déclare une aussi (SALES_DIRECTOR) : il faut retirer les deux. */
    const fleet = fullFleet().filter(
      (b) => b.brainId !== "brain-reviewer" && b.brainId !== "brain-business",
    );
    const outcome = planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toEqual(["NO_INDEPENDENT_REVIEWER"]);
  });

  it("does not use a reviewer that is merely DEFERRED as an implementer", () => {
    const fleet = fullFleet()
      .filter((b) => b.brainId !== "brain-reviewer" && b.brainId !== "brain-business")
      .map((b) =>
        b.brainId === "brain-memory"
          ? { ...b, capabilities: [...b.capabilities, INDEPENDENT_REVIEW_CAPABILITY] }
          : b,
      );
    /* one parallel slot: b-memory ends up queued, not assigned — still not independent */
    const outcome = planObjectiveDelegation(SELF_IMPROVEMENT, fleet, {
      maxParallelAssignments: 1,
      maxAutonomyLevel: 3,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusals).toEqual(["REVIEWER_NOT_INDEPENDENT"]);
  });

  it("marks review as required for a brain whose reviewPolicy is always", () => {
    const fleet = fullFleet().map((b) =>
      b.brainId === "brain-builder" ? { ...b, reviewPolicy: "always" as const } : b,
    );
    const plan = expectOk(planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    expect(plan.assignments.find((a) => a.brainId === "brain-builder")?.reviewRequired).toBe(true);
    expect(plan.assignments.find((a) => a.brainId === "brain-research")?.reviewRequired).toBe(
      false,
    );
  });
});

describe("chief delegation — over-subscription defers, never drops", () => {
  it("defers the overflow of an overall parallelism limit and keeps every stage", () => {
    const plan = expectOk(
      planObjectiveDelegation(SELF_IMPROVEMENT, fullFleet(), {
        maxParallelAssignments: 2,
        maxAutonomyLevel: 3,
      }),
    );
    expect(plan.assignments).toHaveLength(2);
    expect(plan.deferred).toHaveLength(3);
    expect(plan.deferred.map((d) => d.reason)).toEqual(Array(3).fill("PARALLELISM_LIMIT"));
    /* nothing was dropped: every shape stage is accounted for exactly once */
    expect([...plan.assignments, ...plan.deferred].map((a) => a.stage).sort()).toEqual(
      DELEGATION_SHAPES.SELF_IMPROVEMENT!.map((s) => s.stage).sort(),
    );
  });

  it("defers a second part rather than exceeding a brain's maxConcurrentAssignments", () => {
    /* one brain holds two capabilities but only one slot */
    /*
     * Une forme SUR MESURE : un seul cerveau nommé sur deux étapes, avec un seul créneau.
     * Les étapes nommées rendent le cas explicite au lieu de dépendre d'une collision.
     */
    const fleet: BrainDescriptor[] = [
      brain({
        brainId: "b-omni",
        capabilities: ["code_write", "research"],
        maxConcurrentAssignments: 1,
      }),
      brain({
        brainId: "brain-reviewer",
        role: "INDEPENDENT_REVIEWER",
        capabilities: [INDEPENDENT_REVIEW_CAPABILITY],
      }),
    ];
    const plan = expectOk(
      planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS, [
        { stage: "EVOLUTION", capability: "code_write", wave: 0, brainId: "b-omni" },
        { stage: "RESEARCH", capability: "research", wave: 1, brainId: "b-omni" },
      ]),
    );
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
    const plan = expectOk(planObjectiveDelegation(SELF_IMPROVEMENT, fleet, LIMITS));
    for (const a of [...plan.assignments, plan.review]) expect(a.autonomyLevel).toBe(1);
  });

  it("never assigns above the ceiling the caller passed in", () => {
    const plan = expectOk(
      planObjectiveDelegation(SELF_IMPROVEMENT, fullFleet(), {
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
    const plan = expectOk(planObjectiveDelegation(objective, fullFleet(), LIMITS));
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
      planObjectiveDelegation(objective, fullFleet(), LIMITS, [
        { stage: "EVOLUTION", capability: "code_write", wave: 0, brainId: "brain-evolution" },
        { stage: "SHIPPER", capability: "deployment", wave: 1, brainId: "brain-delivery" },
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
