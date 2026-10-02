import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import type { WorkClass } from "./contracts";

/**
 * PRIORITY GOVERNOR (decision 0065). Pure, deterministic, no clock of its own.
 *
 * Doctrine lives in `classBase` as DATA. Factors can only reorder objectives WITHIN a
 * class: band spacing (>= 15) exceeds the maximum factor swing (2 * maxFactorBonus = 14),
 * so no amount of favourable evidence can lift self-improvement above user work. That is
 * arithmetic, not a convention someone must remember.
 *
 * A factor with no evidence contributes NOTHING and is named in `missing`. It is never
 * scored as zero: "no client importance recorded" and "a client of zero importance" are
 * different facts and a reader must be able to tell them apart.
 */

export const PRIORITY_FACTORS = [
  "userPriority",
  "deadlinePressure",
  "risk",
  "reversibility",
  "cost",
  "clientImportance",
  "urgency",
  "businessImpact",
  "expectedValue",
  "dependencyBlocking",
] as const;
export type PriorityFactorName = (typeof PRIORITY_FACTORS)[number];

/**
 * Metadata keys under this prefix are SERVER-ASSERTED. The HTTP intake strips them from
 * caller input (`stripUntrustedMetadata`), so only ICOS itself can write them.
 *
 * Classification reads nothing else. Without this, any caller holding `missions.write`
 * could post `source: "cognitive_conversation"` and buy themselves class USER, base 90,
 * at the top of the scheduler's ORDER BY — the band arithmetic is only as trustworthy as
 * the label it operates on.
 */
export const TRUSTED_METADATA_PREFIX = "icos.";

/**
 * Removes every reserved key from metadata that arrived from outside ICOS. Call this at
 * each trust boundary where caller-supplied metadata enters a goal.
 */
export function stripUntrustedMetadata(
  metadata: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !key.startsWith(TRUSTED_METADATA_PREFIX)),
  );
}

/** `equals` omitted ⇒ the rule matches when the key is present and non-empty. */
export interface ClassificationRule {
  readonly class: WorkClass;
  readonly when: { readonly metadataKey: string; readonly equals?: string };
}

export interface PriorityPolicy {
  readonly version: string;
  readonly classBase: Readonly<Record<WorkClass, number>>;
  /** Evaluated in array order; first match wins. */
  readonly classification: readonly ClassificationRule[];
  readonly defaultClass: WorkClass;
  readonly weights: Readonly<Record<PriorityFactorName, number>>;
  /** Importance in [0,1] per client id. An absent client is MISSING, not zero. */
  readonly clientWeights: Readonly<Record<string, number>>;
  /** Half the total band a factor may move an objective. */
  readonly maxFactorBonus: number;
  /** A deadline this far out or further scores no pressure. */
  readonly deadlineHorizonMs: number;
}

/**
 * Doctrine: Geoffrey > client/revenue > security incident > deadline/maintenance >
 * self-improvement > exploration. CLIENT and REVENUE share a band on purpose (one
 * doctrine rank); factors break that tie.
 */
export const DEFAULT_PRIORITY_POLICY: PriorityPolicy = {
  version: "priority/2026-10-02",
  classBase: {
    USER: 90,
    CLIENT: 75,
    REVENUE: 75,
    SECURITY: 60,
    MAINTENANCE: 40,
    SELF_IMPROVEMENT: 20,
    RESEARCH: 5,
  },
  /* Every key is under TRUSTED_METADATA_PREFIX: a class is asserted by ICOS, never by a caller. */
  classification: [
    { class: "USER", when: { metadataKey: "icos.source", equals: "cognitive_conversation" } },
    { class: "SECURITY", when: { metadataKey: "icos.domain", equals: "security" } },
    { class: "REVENUE", when: { metadataKey: "icos.domain", equals: "revenue" } },
    { class: "MAINTENANCE", when: { metadataKey: "icos.domain", equals: "maintenance" } },
    { class: "SELF_IMPROVEMENT", when: { metadataKey: "icos.source", equals: "self_development" } },
    { class: "CLIENT", when: { metadataKey: "icos.clientId" } },
  ],
  defaultClass: "RESEARCH",
  weights: {
    userPriority: 1.5,
    deadlinePressure: 1.5,
    risk: 0.75,
    reversibility: 0.5,
    cost: 0.5,
    clientImportance: 1,
    urgency: 1.25,
    businessImpact: 1.25,
    expectedValue: 1,
    dependencyBlocking: 0.75,
  },
  clientWeights: {},
  maxFactorBonus: 7,
  deadlineHorizonMs: 14 * 24 * 60 * 60_000,
};

export interface ObjectiveFacts {
  readonly now: Date;
  /** How many other objectives this one blocks. Absent ⇒ the factor is missing. */
  readonly blockedObjectiveCount?: number;
}

export interface PriorityFactorEvidence {
  readonly name: PriorityFactorName;
  readonly raw: number | string;
  /** [-1, 1]. */
  readonly normalized: number;
  readonly weight: number;
  readonly contribution: number;
  /** Human-readable provenance; enough to recompute `normalized` by hand. */
  readonly evidence: string;
}

export interface PriorityResult {
  readonly priority: number;
  readonly class: WorkClass;
  readonly classSource: "rule" | "default";
  readonly policyVersion: string;
  readonly factors: readonly PriorityFactorEvidence[];
  readonly missing: readonly PriorityFactorName[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const numeric = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Rejects a policy whose own numbers break the band guarantee. The containment proof
 * (|Σ nᵢwᵢ| ≤ Σwᵢ) needs every weight non-negative; one negative weight shrinks the
 * denominator and lets the bonus exceed maxFactorBonus, crossing a 15-point band. Called
 * at composition so a bad policy fails at wiring time, not as a silent mis-ordering.
 */
export function assertPriorityPolicyCoherent(policy: PriorityPolicy): void {
  for (const factor of PRIORITY_FACTORS) {
    const w = policy.weights[factor];
    if (!(w >= 0) || !Number.isFinite(w)) {
      throw new Error(`PRIORITY_POLICY_INCOHERENT: weight for ${factor} must be finite and >= 0`);
    }
  }
  const bases = Object.values(policy.classBase).sort((a, b) => a - b);
  const swing = 2 * policy.maxFactorBonus;
  for (let i = 1; i < bases.length; i += 1) {
    const gap = bases[i] - bases[i - 1];
    if (gap !== 0 && gap <= swing) {
      throw new Error(
        `PRIORITY_POLICY_INCOHERENT: class bands ${bases[i - 1]}/${bases[i]} are ${gap} apart, which factors (swing ${swing}) can cross`,
      );
    }
  }
}

export function classifyObjective(
  policy: PriorityPolicy,
  goal: HighLevelGoal,
): { class: WorkClass; classSource: "rule" | "default" } {
  for (const rule of policy.classification) {
    const value = goal.metadata[rule.when.metadataKey];
    if (value === undefined || value.trim() === "") continue;
    if (rule.when.equals !== undefined && value !== rule.when.equals) continue;
    return { class: rule.class, classSource: "rule" };
  }
  return { class: policy.defaultClass, classSource: "default" };
}

export function scoreObjective(
  policy: PriorityPolicy,
  goal: HighLevelGoal,
  facts: ObjectiveFacts,
): PriorityResult {
  const raw: Omit<PriorityFactorEvidence, "contribution">[] = [];
  const missing: PriorityFactorName[] = [];

  const add = (
    name: PriorityFactorName,
    normalized: number,
    rawValue: number | string,
    evidence: string,
  ) => {
    raw.push({
      name,
      raw: rawValue,
      normalized: clamp(normalized, -1, 1),
      weight: policy.weights[name],
      evidence,
    });
  };

  // userPriority: 1..5 -> [-1, 1]. 3 is the schema default and cannot be told from unset.
  add(
    "userPriority",
    (goal.priority - 3) / 2,
    goal.priority,
    goal.priority === 3
      ? "goal.priority=3 (indistinguishable from unset: NOT NULL DEFAULT 3)"
      : `goal.priority=${goal.priority}`,
  );

  if (goal.deadline) {
    const msLeft = new Date(goal.deadline).getTime() - facts.now.getTime();
    const pressure = 1 - clamp(msLeft / policy.deadlineHorizonMs, 0, 1);
    add(
      "deadlinePressure",
      pressure * 2 - 1,
      goal.deadline,
      `deadline in ${Math.round(msLeft / 60_000)} min, horizon ${policy.deadlineHorizonMs / 60_000} min`,
    );
  } else {
    missing.push("deadlinePressure");
  }

  // Risk raises attention; irreversibility lowers eagerness to run unattended.
  const riskNormalized = { read_only: -1, reversible: 0, sensitive: 1 }[goal.riskLevel];
  add("risk", riskNormalized, goal.riskLevel, `goal.riskLevel=${goal.riskLevel}`);
  add(
    "reversibility",
    goal.riskLevel === "sensitive" ? -1 : 1,
    goal.riskLevel,
    `goal.riskLevel=${goal.riskLevel} ⇒ ${goal.riskLevel === "sensitive" ? "not reversible" : "reversible"}`,
  );

  if (goal.budget !== undefined) {
    // Cheaper work is slightly preferred at equal value. 0 budget = cheapest.
    add(
      "cost",
      goal.budget === 0 ? 1 : -clamp(Math.log10(goal.budget + 1) / 4, 0, 1),
      goal.budget,
      `goal.budget=${goal.budget}`,
    );
  } else {
    missing.push("cost");
  }

  // Reserved key only: a caller-supplied clientId must not buy client importance either.
  const clientId = goal.metadata[`${TRUSTED_METADATA_PREFIX}clientId`];
  const clientWeight = clientId === undefined ? undefined : policy.clientWeights[clientId];
  if (clientWeight !== undefined && clientId !== undefined) {
    add("clientImportance", clientWeight * 2 - 1, clientId, `clientWeights[${clientId}]=${clientWeight}`);
  } else {
    missing.push("clientImportance");
  }

  const urgency = numeric(goal.metadata.urgency);
  if (urgency !== null) {
    add("urgency", clamp(urgency, 0, 1) * 2 - 1, urgency, `metadata.urgency=${urgency}`);
  } else {
    missing.push("urgency");
  }

  const impact = numeric(goal.metadata.businessImpact);
  if (impact !== null) {
    add("businessImpact", clamp(impact, 0, 1) * 2 - 1, impact, `metadata.businessImpact=${impact}`);
  } else {
    missing.push("businessImpact");
  }

  const value = numeric(goal.metadata.expectedValue);
  if (value !== null) {
    add("expectedValue", clamp(value, 0, 1) * 2 - 1, value, `metadata.expectedValue=${value}`);
  } else {
    missing.push("expectedValue");
  }

  if (facts.blockedObjectiveCount !== undefined) {
    add(
      "dependencyBlocking",
      clamp(facts.blockedObjectiveCount / 5, 0, 1) * 2 - 1,
      facts.blockedObjectiveCount,
      `blocks ${facts.blockedObjectiveCount} other objective(s)`,
    );
  } else {
    missing.push("dependencyBlocking");
  }

  /*
   * Normalise against the weight of the factors ACTUALLY PRESENT, so a goal missing half
   * its evidence is not implicitly penalised against one that has all of it. The bonus
   * stays inside +/- maxFactorBonus whatever the policy weights are, which is what keeps
   * the class bands uncrossable.
   */
  const totalWeight = raw.reduce((sum, f) => sum + f.weight, 0);
  const factors: PriorityFactorEvidence[] = raw.map((f) => ({
    ...f,
    contribution:
      totalWeight === 0 ? 0 : (f.normalized * f.weight * policy.maxFactorBonus) / totalWeight,
  }));

  const { class: workClass, classSource } = classifyObjective(policy, goal);
  const bonus = factors.reduce((sum, f) => sum + f.contribution, 0);
  const priority = clamp(Math.round(policy.classBase[workClass] + bonus), -100, 100);

  return {
    priority,
    class: workClass,
    classSource,
    policyVersion: policy.version,
    factors,
    missing,
  };
}

export interface ScoredObjective {
  readonly goal: HighLevelGoal;
  readonly result: PriorityResult;
}

const deadlineRank = (goal: HighLevelGoal): number =>
  goal.deadline ? new Date(goal.deadline).getTime() : Number.POSITIVE_INFINITY;

/**
 * Total order: score DESC, deadline ASC (absent last), createdAt ASC, goalId ASC.
 * Total, not merely consistent: two objectives compare 0 only when their ids match,
 * so the order survives a restart and a different map iteration order.
 */
export function compareScored(a: ScoredObjective, b: ScoredObjective): number {
  return (
    b.result.priority - a.result.priority ||
    deadlineRank(a.goal) - deadlineRank(b.goal) ||
    new Date(a.goal.createdAt).getTime() - new Date(b.goal.createdAt).getTime() ||
    (a.goal.id < b.goal.id ? -1 : a.goal.id > b.goal.id ? 1 : 0)
  );
}
