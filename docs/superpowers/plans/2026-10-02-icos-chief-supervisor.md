# ICOS Chief Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ICOS cross-objective ordering, bounded admission, and a truthful objective-level read model, as pure policy over the existing scheduler, runner and control plane.

**Architecture:** Three pure modules in `src/core/supervisor/` (priority scoring, portfolio allocation, objective-state derivation) plus a thin `ObjectiveCoordinator` and a read-model projection in `src/server/supervisor/`. The coordinator loads facts, calls the pure functions, and enqueues the existing `start_mission` job with a `priority` and an optional deferred `runAt`. Nothing is persisted that is not already persisted.

**Tech Stack:** TypeScript, Zod, Vitest, Drizzle (read-only use), Next.js route handlers.

**Spec:** `docs/superpowers/specs/2026-10-02-icos-chief-supervisor-design.md`

## Global Constraints

- `ObjectiveCoordinator` is a thin coordinator: no loop, no lease, no retry, no state between calls.
- `RuntimeControlGuard` remains the only authority that holds running work.
- No new scheduler loop; the Durable Scheduler is the only job runner.
- No persisted objective lifecycle; objective state is derived on every read.
- No duplicate review, recovery or escalation authority.
- Portfolio allocation applies only at the existing mission launch point.
- Missing business evidence is reported as missing/`UNKNOWN`; never inferred, never defaulted to a plausible number.
- No new table, no migration, no change under `drizzle/`.
- No live DB. Integration tests, if any, run against an isolated `*_test` database only.
- Pure modules under `src/core/**` import nothing from `src/server/**`, Next.js, Drizzle or PostgreSQL.
- Tests are co-located `*.test.ts`, run by `pnpm vitest run`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Review Focus

Five conditions the spec implies but which no obvious task exercises. Each has a test assigned to the task that owns the code.

1. **A `SELF_IMPROVEMENT` goal with every factor maximised must still rank below a `USER` goal with every factor minimised.** Band arithmetic is the only thing preventing doctrine inversion; an off-by-one in `maxFactorBonus` silently breaks it. → Task 2, `test: band spacing cannot be crossed by factors`.
2. **A class whose `active` count already exceeds its `reserved` must not keep reserving slots it is not using.** Naïve `Σ reserved` arithmetic double-counts and deadlocks the global pool once several classes are busy. → Task 3, `test: reservations already consumed do not block the global pool`.
3. **A mission id that cannot be read must not render as `RECEIVED`.** A missing row and an un-launched goal are different facts; conflating them reports an objective as not started when it may be running. → Task 4, `test: unreadable mission degrades, never reports RECEIVED`.
4. **An objective whose goal metadata names an unknown client must score without a client factor, not with a zero-weight client factor.** A silently-zeroed factor is indistinguishable from a client of no importance. → Task 2, `test: unweighted client is missing, not zero`.
5. **Two objectives identical in every scored field must still order deterministically across process restarts.** Map iteration order and `Array.sort` stability are not a total order; a flapping order makes the scheduler non-reproducible. → Task 2, `test: identical objectives order by goalId`.

---

### Task 1: Supervisor core contracts

**Files:**
- Create: `src/core/supervisor/contracts.ts`
- Test: `src/core/supervisor/contracts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WORK_CLASSES`, `WorkClass`, `OBJECTIVE_STATES`, `ObjectiveState`, `UNKNOWN`, `Unknown`, `Maybe<T>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/core/supervisor/contracts.test.ts
import { describe, expect, it } from "vitest";

import { OBJECTIVE_STATES, UNKNOWN, WORK_CLASSES } from "./contracts";

describe("supervisor contracts", () => {
  it("names the seven doctrine work classes in doctrine order", () => {
    expect(WORK_CLASSES).toEqual([
      "USER",
      "CLIENT",
      "REVENUE",
      "SECURITY",
      "MAINTENANCE",
      "SELF_IMPROVEMENT",
      "RESEARCH",
    ]);
  });

  it("covers every objective state the design declares", () => {
    expect(new Set(OBJECTIVE_STATES)).toEqual(
      new Set([
        "RECEIVED",
        "CONTEXTUALIZED",
        "PLANNING",
        "DELEGATING",
        "EXECUTING",
        "REVIEWING",
        "REPAIRING",
        "DECISION_READY",
        "COMPLETED",
        "BLOCKED",
        "WAITING_FOR_HUMAN",
        "DEGRADED",
        "RECOVERING",
        "CANCELLED",
        "FAILED",
      ]),
    );
  });

  it("exposes one sentinel for absent evidence", () => {
    expect(UNKNOWN).toBe("UNKNOWN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/supervisor/contracts.test.ts`
Expected: FAIL — cannot resolve `./contracts`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/supervisor/contracts.ts
/**
 * CHIEF SUPERVISOR vocabulary (decision 0065). Pure: no Next.js, Drizzle or PostgreSQL.
 *
 * This layer adds NO entity. A work class and an objective state are both DERIVED
 * descriptions of a Goal that other subsystems already own.
 */

/** ICOS doctrine order. Index 0 outranks index 1, and so on. */
export const WORK_CLASSES = [
  "USER",
  "CLIENT",
  "REVENUE",
  "SECURITY",
  "MAINTENANCE",
  "SELF_IMPROVEMENT",
  "RESEARCH",
] as const;
export type WorkClass = (typeof WORK_CLASSES)[number];

export const OBJECTIVE_STATES = [
  "RECEIVED",
  "CONTEXTUALIZED",
  "PLANNING",
  "DELEGATING",
  "EXECUTING",
  "REVIEWING",
  "REPAIRING",
  "DECISION_READY",
  "COMPLETED",
  "BLOCKED",
  "WAITING_FOR_HUMAN",
  "DEGRADED",
  "RECOVERING",
  "CANCELLED",
  "FAILED",
] as const;
export type ObjectiveState = (typeof OBJECTIVE_STATES)[number];

/**
 * The ONLY way this layer reports a fact it does not hold. Never 0, never "", never
 * a plausible substitute: a reader must be able to tell absent from measured.
 */
export const UNKNOWN = "UNKNOWN" as const;
export type Unknown = typeof UNKNOWN;
export type Maybe<T> = T | Unknown;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/supervisor/contracts.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/supervisor/contracts.ts src/core/supervisor/contracts.test.ts
git commit -m "feat(supervisor): work classes, objective states, one UNKNOWN sentinel"
```

---

### Task 2: Priority Governor

**Files:**
- Create: `src/core/supervisor/priority.ts`
- Test: `src/core/supervisor/priority.test.ts`

**Interfaces:**
- Consumes: `WorkClass`, `WORK_CLASSES` from Task 1; `HighLevelGoal` from `@/core/contracts/high-level-goal`.
- Produces:
  - `PRIORITY_FACTORS: readonly PriorityFactorName[]`
  - `type PriorityFactorName`
  - `interface ClassificationRule { class: WorkClass; when: { metadataKey: string; equals?: string } }`
  - `interface PriorityPolicy { version, classBase, classification, defaultClass, weights, clientWeights, maxFactorBonus }`
  - `DEFAULT_PRIORITY_POLICY: PriorityPolicy`
  - `interface ObjectiveFacts { now: Date; blockedObjectiveCount?: number }`
  - `interface PriorityFactorEvidence { name, raw, normalized, weight, contribution, evidence }`
  - `interface PriorityResult { priority, class, classSource, policyVersion, factors, missing }`
  - `classifyObjective(policy, goal): { class: WorkClass; classSource: "rule" | "default" }`
  - `scoreObjective(policy, goal, facts): PriorityResult`
  - `compareScored(a, b): number` over `{ goal: HighLevelGoal; result: PriorityResult }`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/supervisor/priority.test.ts
import { describe, expect, it } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import {
  DEFAULT_PRIORITY_POLICY,
  classifyObjective,
  compareScored,
  scoreObjective,
} from "./priority";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const goal = (over: Partial<HighLevelGoal> = {}): HighLevelGoal => ({
  id: "g-1",
  title: "t",
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

describe("classifyObjective", () => {
  it("classifies a conversation-launched goal as USER", () => {
    const g = goal({ metadata: { source: "cognitive_conversation" } });
    expect(classifyObjective(DEFAULT_PRIORITY_POLICY, g)).toEqual({
      class: "USER",
      classSource: "rule",
    });
  });

  it("classifies a client-scoped goal as CLIENT", () => {
    const g = goal({ metadata: { clientId: "lds" } });
    expect(classifyObjective(DEFAULT_PRIORITY_POLICY, g)).toEqual({
      class: "CLIENT",
      classSource: "rule",
    });
  });

  it("falls back to the policy default and says so", () => {
    expect(classifyObjective(DEFAULT_PRIORITY_POLICY, goal())).toEqual({
      class: "RESEARCH",
      classSource: "default",
    });
  });
});

describe("scoreObjective", () => {
  it("records the policy version with every decision", () => {
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, goal(), { now: NOW });
    expect(r.policyVersion).toBe(DEFAULT_PRIORITY_POLICY.version);
  });

  it("reports absent business evidence as missing, never as zero", () => {
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, goal(), { now: NOW });
    expect(r.missing).toEqual(
      expect.arrayContaining([
        "deadlinePressure",
        "cost",
        "clientImportance",
        "urgency",
        "businessImpact",
        "expectedValue",
        "dependencyBlocking",
      ]),
    );
    expect(r.factors.map((f) => f.name)).not.toContain("businessImpact");
  });

  it("marks an unweighted client as missing, not zero", () => {
    const g = goal({ metadata: { clientId: "unknown-client" } });
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    expect(r.missing).toContain("clientImportance");
    expect(r.factors.find((f) => f.name === "clientImportance")).toBeUndefined();
  });

  it("states that a default priority of 3 is indistinguishable from unset", () => {
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, goal({ priority: 3 }), { now: NOW });
    const f = r.factors.find((x) => x.name === "userPriority");
    expect(f?.evidence).toContain("indistinguishable from unset");
  });

  it("reconstructs the score from its own evidence", () => {
    const g = goal({
      metadata: { source: "cognitive_conversation" },
      deadline: "2026-10-02T13:00:00.000Z",
      priority: 5,
    });
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    const bonus = r.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(r.priority).toBe(
      Math.round(DEFAULT_PRIORITY_POLICY.classBase[r.class] + bonus),
    );
  });

  it("is deterministic", () => {
    const g = goal({ metadata: { clientId: "lds" }, deadline: "2026-10-03T00:00:00.000Z" });
    const a = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    const b = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    expect(a).toEqual(b);
  });

  it("band spacing cannot be crossed by factors", () => {
    const best = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({
        id: "self",
        metadata: { source: "self_development", businessImpact: "1", expectedValue: "1" },
        priority: 5,
        riskLevel: "read_only",
        deadline: NOW.toISOString(),
        budget: 0,
      }),
      { now: NOW, blockedObjectiveCount: 50 },
    );
    const worst = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({
        id: "user",
        metadata: { source: "cognitive_conversation" },
        priority: 1,
        riskLevel: "sensitive",
      }),
      { now: NOW },
    );
    expect(best.class).toBe("SELF_IMPROVEMENT");
    expect(worst.class).toBe("USER");
    expect(worst.priority).toBeGreaterThan(best.priority);
  });

  it("SUPERVISOR_PRIORITY_USER_OVER_SELF", () => {
    const user = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "u", metadata: { source: "cognitive_conversation" } }),
      { now: NOW },
    );
    const self = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "s", metadata: { source: "self_development" } }),
      { now: NOW },
    );
    expect(user.priority).toBeGreaterThan(self.priority);
  });

  it("SUPERVISOR_CLIENT_OVER_SELF", () => {
    const client = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "c", metadata: { clientId: "lds" } }),
      { now: NOW },
    );
    const self = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "s", metadata: { source: "self_development" } }),
      { now: NOW },
    );
    expect(client.priority).toBeGreaterThan(self.priority);
  });

  it("clamps into the scheduler's accepted range", () => {
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, goal(), { now: NOW });
    expect(r.priority).toBeGreaterThanOrEqual(-100);
    expect(r.priority).toBeLessThanOrEqual(100);
  });
});

describe("compareScored", () => {
  const scored = (g: HighLevelGoal) => ({
    goal: g,
    result: scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW }),
  });

  it("orders by score, then earliest deadline, then createdAt, then id", () => {
    const a = scored(goal({ id: "a", metadata: { source: "cognitive_conversation" } }));
    const b = scored(goal({ id: "b", metadata: { source: "self_development" } }));
    expect(compareScored(a, b)).toBeLessThan(0);
  });

  it("puts an objective without a deadline after one of equal score", () => {
    /*
     * Scores are pinned by hand: a real deadline also moves `deadlinePressure`, so two
     * goals that differ only by having a deadline never tie. The comparator's deadline
     * rung is only reachable on an exact score tie, which is what is exercised here.
     */
    const tie = scoreObjective(DEFAULT_PRIORITY_POLICY, goal({ id: "a" }), { now: NOW });
    const withDeadline = {
      goal: goal({ id: "a", deadline: "2026-10-05T00:00:00.000Z" }),
      result: tie,
    };
    const without = { goal: goal({ id: "a", deadline: undefined }), result: tie };
    expect(compareScored(withDeadline, without)).toBeLessThan(0);
    expect(compareScored(without, withDeadline)).toBeGreaterThan(0);
  });

  it("identical objectives order by goalId", () => {
    const a = scored(goal({ id: "aaa" }));
    const b = scored(goal({ id: "bbb" }));
    expect(compareScored(a, b)).toBeLessThan(0);
    expect(compareScored(b, a)).toBeGreaterThan(0);
    expect(compareScored(a, a)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/supervisor/priority.test.ts`
Expected: FAIL — cannot resolve `./priority`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/supervisor/priority.ts
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
  classification: [
    { class: "USER", when: { metadataKey: "source", equals: "cognitive_conversation" } },
    { class: "SECURITY", when: { metadataKey: "domain", equals: "security" } },
    { class: "REVENUE", when: { metadataKey: "domain", equals: "revenue" } },
    { class: "MAINTENANCE", when: { metadataKey: "domain", equals: "maintenance" } },
    { class: "SELF_IMPROVEMENT", when: { metadataKey: "source", equals: "self_development" } },
    { class: "CLIENT", when: { metadataKey: "clientId" } },
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
  const factors: PriorityFactorEvidence[] = [];
  const missing: PriorityFactorName[] = [];

  const add = (name: PriorityFactorName, normalized: number, raw: number | string, evidence: string) => {
    const weight = policy.weights[name];
    factors.push({
      name,
      raw,
      normalized: clamp(normalized, -1, 1),
      weight,
      contribution: 0, // replaced below, once the normaliser is known
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
    add("deadlinePressure", pressure * 2 - 1, goal.deadline, `deadline in ${Math.round(msLeft / 60_000)} min, horizon ${policy.deadlineHorizonMs / 60_000} min`);
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
    add("cost", goal.budget === 0 ? 1 : -clamp(Math.log10(goal.budget + 1) / 4, 0, 1), goal.budget, `goal.budget=${goal.budget}`);
  } else {
    missing.push("cost");
  }

  const clientId = goal.metadata.clientId;
  const clientWeight = clientId === undefined ? undefined : policy.clientWeights[clientId];
  if (clientWeight !== undefined) {
    add("clientImportance", clientWeight * 2 - 1, clientId as string, `clientWeights[${clientId}]=${clientWeight}`);
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
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const scored: PriorityFactorEvidence[] = factors.map((f) => ({
    ...f,
    contribution:
      totalWeight === 0 ? 0 : (f.normalized * f.weight * policy.maxFactorBonus) / totalWeight,
  }));

  const { class: workClass, classSource } = classifyObjective(policy, goal);
  const bonus = scored.reduce((sum, f) => sum + f.contribution, 0);
  const priority = clamp(Math.round(policy.classBase[workClass] + bonus), -100, 100);

  return {
    priority,
    class: workClass,
    classSource,
    policyVersion: policy.version,
    factors: scored,
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/supervisor/priority.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/supervisor/priority.ts src/core/supervisor/priority.test.ts
git commit -m "feat(supervisor): doctrine-banded priority governor with factor evidence"
```

---

### Task 3: Portfolio Governor

**Files:**
- Create: `src/core/supervisor/portfolio.ts`
- Test: `src/core/supervisor/portfolio.test.ts`

**Interfaces:**
- Consumes: `WorkClass`, `WORK_CLASSES` from Task 1.
- Produces:
  - `interface ClassCaps { maxConcurrent, reserved, computeBudgetUnits }`
  - `interface PortfolioPolicy { version, classes, globalMaxConcurrent, windowMs, deferBackoffMs }`
  - `DEFAULT_PORTFOLIO_POLICY: PortfolioPolicy`
  - `interface PortfolioState { windowStartedAt: Date; active: Record<WorkClass, number>; computeSpent: Record<WorkClass, number> }`
  - `interface AllocationCandidate { class: WorkClass; computeUnits: number }`
  - `type AllocationDecision` (admit | defer with `reason` and `retryAfterMs`)
  - `allocate(policy, state, candidate, now): AllocationDecision`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/supervisor/portfolio.test.ts
import { describe, expect, it } from "vitest";

import { WORK_CLASSES, type WorkClass } from "./contracts";
import {
  DEFAULT_PORTFOLIO_POLICY,
  allocate,
  type PortfolioPolicy,
  type PortfolioState,
} from "./portfolio";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const zeroed = (): Record<WorkClass, number> =>
  Object.fromEntries(WORK_CLASSES.map((c) => [c, 0])) as Record<WorkClass, number>;

const state = (over: Partial<PortfolioState> = {}): PortfolioState => ({
  windowStartedAt: NOW,
  active: zeroed(),
  computeSpent: zeroed(),
  ...over,
});

describe("allocate", () => {
  it("admits into an idle portfolio and shows its arithmetic", () => {
    const d = allocate(DEFAULT_PORTFOLIO_POLICY, state(), { class: "USER", computeUnits: 1 }, NOW);
    expect(d.admit).toBe(true);
    expect(d.evidence.policyVersion).toBe(DEFAULT_PORTFOLIO_POLICY.version);
    expect(d.evidence.slotsAvailable).toBeGreaterThan(0);
  });

  it("defers, never rejects, when a class is at its concurrency cap", () => {
    const active = zeroed();
    active.RESEARCH = DEFAULT_PORTFOLIO_POLICY.classes.RESEARCH.maxConcurrent;
    const d = allocate(
      DEFAULT_PORTFOLIO_POLICY,
      state({ active }),
      { class: "RESEARCH", computeUnits: 1 },
      NOW,
    );
    expect(d.admit).toBe(false);
    if (d.admit) throw new Error("unreachable");
    expect(d.defer).toBe(true);
    expect(d.reason).toBe("CLASS_CONCURRENCY");
    expect(d.retryAfterMs).toBeGreaterThan(0);
  });

  it("SUPERVISOR_BUDGET_EXHAUSTION defers to the next window boundary", () => {
    const computeSpent = zeroed();
    computeSpent.USER = DEFAULT_PORTFOLIO_POLICY.classes.USER.computeBudgetUnits;
    const halfway = new Date(NOW.getTime() + DEFAULT_PORTFOLIO_POLICY.windowMs / 2);
    const d = allocate(
      DEFAULT_PORTFOLIO_POLICY,
      state({ computeSpent }),
      { class: "USER", computeUnits: 1 },
      halfway,
    );
    expect(d.admit).toBe(false);
    if (d.admit) throw new Error("unreachable");
    expect(d.reason).toBe("COMPUTE_BUDGET");
    expect(d.retryAfterMs).toBe(DEFAULT_PORTFOLIO_POLICY.windowMs / 2);
  });

  it("never starves a lower class: reserved slots are not takeable", () => {
    // Fill the global pool with USER work, leaving only other classes' reservations.
    const policy: PortfolioPolicy = {
      ...DEFAULT_PORTFOLIO_POLICY,
      globalMaxConcurrent: 8,
    };
    const reservedElsewhere = WORK_CLASSES.filter((c) => c !== "USER").reduce(
      (sum, c) => sum + policy.classes[c].reserved,
      0,
    );
    const active = zeroed();
    active.USER = policy.globalMaxConcurrent - reservedElsewhere;

    const user = allocate(policy, state({ active }), { class: "USER", computeUnits: 1 }, NOW);
    expect(user.admit).toBe(false);
    if (user.admit) throw new Error("unreachable");
    expect(user.reason).toBe("GLOBAL_CONCURRENCY");

    const security = allocate(policy, state({ active }), { class: "SECURITY", computeUnits: 1 }, NOW);
    expect(security.admit).toBe(true);
  });

  it("reservations already consumed do not block the global pool", () => {
    const policy: PortfolioPolicy = { ...DEFAULT_PORTFOLIO_POLICY, globalMaxConcurrent: 8 };
    // Every other class is already using its reservation; nothing is held back for them.
    const active = zeroed();
    for (const c of WORK_CLASSES) {
      if (c !== "USER") active[c] = policy.classes[c].reserved;
    }
    const totalActive = WORK_CLASSES.reduce((s, c) => s + active[c], 0);
    const d = allocate(policy, state({ active }), { class: "USER", computeUnits: 1 }, NOW);
    expect(totalActive).toBeLessThan(policy.globalMaxConcurrent);
    expect(d.admit).toBe(true);
  });

  it("is deterministic", () => {
    const s = state();
    const a = allocate(DEFAULT_PORTFOLIO_POLICY, s, { class: "CLIENT", computeUnits: 2 }, NOW);
    const b = allocate(DEFAULT_PORTFOLIO_POLICY, s, { class: "CLIENT", computeUnits: 2 }, NOW);
    expect(a).toEqual(b);
  });

  it("gives every class a reserved slot, so none can be squeezed out by policy", () => {
    for (const c of WORK_CLASSES) {
      expect(DEFAULT_PORTFOLIO_POLICY.classes[c].reserved).toBeGreaterThanOrEqual(1);
    }
  });

  it("resets the compute window once it has elapsed", () => {
    const computeSpent = zeroed();
    computeSpent.USER = DEFAULT_PORTFOLIO_POLICY.classes.USER.computeBudgetUnits;
    const afterWindow = new Date(NOW.getTime() + DEFAULT_PORTFOLIO_POLICY.windowMs + 1);
    const d = allocate(
      DEFAULT_PORTFOLIO_POLICY,
      state({ computeSpent }),
      { class: "USER", computeUnits: 1 },
      afterWindow,
    );
    expect(d.admit).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/supervisor/portfolio.test.ts`
Expected: FAIL — cannot resolve `./portfolio`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/supervisor/portfolio.ts
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
  globalMaxConcurrent: 10,
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
  const globalSlots = policy.globalMaxConcurrent - globalActive - reservedElsewhere;
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/supervisor/portfolio.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/supervisor/portfolio.ts src/core/supervisor/portfolio.test.ts
git commit -m "feat(supervisor): portfolio governor defers, never rejects, and never starves"
```

---

### Task 4: Objective state derivation

**Files:**
- Create: `src/core/supervisor/objective-state.ts`
- Test: `src/core/supervisor/objective-state.test.ts`

**Interfaces:**
- Consumes: `ObjectiveState` from Task 1.
- Produces:
  - `interface ObjectiveStateInput { goalStatus, missionId, mission, tasks, runtime, pendingApproval, controlHeld, tasksAwaitingRepair }`
  - `interface ObjectiveStateResult { state, phase, blockedReason, unknown }`
  - `deriveObjectiveState(input): ObjectiveStateResult`

- [ ] **Step 1: Write the failing test**

```ts
// src/core/supervisor/objective-state.test.ts
import { describe, expect, it } from "vitest";

import { deriveObjectiveState, type ObjectiveStateInput } from "./objective-state";

const input = (over: Partial<ObjectiveStateInput> = {}): ObjectiveStateInput => ({
  goalStatus: "pending",
  missionId: null,
  mission: null,
  tasks: null,
  runtime: null,
  pendingApproval: false,
  controlHeld: false,
  tasksAwaitingRepair: null,
  ...over,
});

const task = (status: string) => ({ status });

describe("deriveObjectiveState", () => {
  it("RECEIVED when a goal exists and no mission does", () => {
    expect(deriveObjectiveState(input()).state).toBe("RECEIVED");
  });

  it("CONTEXTUALIZED when the mission exists but is still a draft", () => {
    const r = deriveObjectiveState(
      input({ missionId: "m", mission: { status: "draft" }, tasks: [] }),
    );
    expect(r.state).toBe("CONTEXTUALIZED");
  });

  it("PLANNING while the mission is planning", () => {
    expect(
      deriveObjectiveState(input({ missionId: "m", mission: { status: "planning" }, tasks: [] })).state,
    ).toBe("PLANNING");
  });

  it("DELEGATING when tasks are queued and none is running", () => {
    expect(
      deriveObjectiveState(
        input({ missionId: "m", mission: { status: "ready" }, tasks: [task("queued")] }),
      ).state,
    ).toBe("DELEGATING");
  });

  it("EXECUTING when a task is running", () => {
    expect(
      deriveObjectiveState(
        input({ missionId: "m", mission: { status: "running" }, tasks: [task("running")] }),
      ).state,
    ).toBe("EXECUTING");
  });

  it("REVIEWING when a task is under review", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("running"), task("review_pending")],
        }),
      ).state,
    ).toBe("REVIEWING");
  });

  it("REPAIRING when a non-terminal task carries a changes-requested review", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("queued")],
          tasksAwaitingRepair: 1,
        }),
      ).state,
    ).toBe("REPAIRING");
  });

  it("DECISION_READY when every task is settled but the mission is not", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("succeeded"), task("succeeded")],
        }),
      ).state,
    ).toBe("DECISION_READY");
  });

  it("WAITING_FOR_HUMAN on a pending approval request", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("running")],
          pendingApproval: true,
        }),
      ).state,
    ).toBe("WAITING_FOR_HUMAN");
  });

  it("WAITING_FOR_HUMAN when the mission itself awaits approval", () => {
    expect(
      deriveObjectiveState(
        input({ missionId: "m", mission: { status: "awaiting_approval" }, tasks: [task("queued")] }),
      ).state,
    ).toBe("WAITING_FOR_HUMAN");
  });

  it("BLOCKED with a reason when a control hold is in force", () => {
    const r = deriveObjectiveState(
      input({
        missionId: "m",
        mission: { status: "running" },
        tasks: [task("running")],
        controlHeld: true,
      }),
    );
    expect(r.state).toBe("BLOCKED");
    expect(r.blockedReason).toBe("control_hold");
  });

  it("BLOCKED with a reason when the mission is blocked", () => {
    const r = deriveObjectiveState(
      input({ missionId: "m", mission: { status: "blocked" }, tasks: [task("queued")] }),
    );
    expect(r.state).toBe("BLOCKED");
    expect(r.blockedReason).toBe("mission_blocked");
  });

  it("RECOVERING when the runtime says so", () => {
    expect(
      deriveObjectiveState(
        input({
          missionId: "m",
          mission: { status: "running" },
          tasks: [task("queued")],
          runtime: { state: "recovering" },
        }),
      ).state,
    ).toBe("RECOVERING");
  });

  it.each([
    ["succeeded", "COMPLETED"],
    ["failed", "FAILED"],
    ["cancelled", "CANCELLED"],
  ])("maps terminal mission %s to %s", (missionStatus, expected) => {
    expect(
      deriveObjectiveState(input({ missionId: "m", mission: { status: missionStatus }, tasks: [] }))
        .state,
    ).toBe(expected);
  });

  it("unreadable mission degrades, never reports RECEIVED", () => {
    const r = deriveObjectiveState(input({ missionId: "m-gone", mission: null }));
    expect(r.state).toBe("DEGRADED");
    expect(r.unknown).toContain("mission");
    expect(r.state).not.toBe("RECEIVED");
  });

  it("names tasks as unknown when the mission is readable but its tasks are not", () => {
    const r = deriveObjectiveState(
      input({ missionId: "m", mission: { status: "running" }, tasks: null }),
    );
    expect(r.state).toBe("DEGRADED");
    expect(r.unknown).toContain("tasks");
  });

  it("names repairState as unknown when review history is unavailable", () => {
    const r = deriveObjectiveState(
      input({
        missionId: "m",
        mission: { status: "running" },
        tasks: [task("queued")],
        tasksAwaitingRepair: null,
      }),
    );
    expect(r.unknown).toContain("repairState");
    expect(r.state).not.toBe("REPAIRING");
  });

  it("is a pure function of its input", () => {
    const i = input({ missionId: "m", mission: { status: "running" }, tasks: [task("running")] });
    expect(deriveObjectiveState(i)).toEqual(deriveObjectiveState(i));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/core/supervisor/objective-state.test.ts`
Expected: FAIL — cannot resolve `./objective-state`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/core/supervisor/objective-state.ts
import type { ObjectiveState } from "./contracts";

/**
 * Derived objective lifecycle (decision 0065). PURE and PERSISTED NOWHERE.
 *
 * Every call recomputes the state from the rows that other subsystems own, so there is no
 * second lifecycle to reconcile after a restart and no way for this layer's view to drift
 * from the mission's. `null` means "could not be read" and produces DEGRADED with the
 * field named in `unknown` — never a plausible substitute, and never RECEIVED, which is a
 * different fact (nothing has been launched yet).
 */

export interface ObjectiveStateInput {
  readonly goalStatus: string;
  readonly missionId: string | null;
  /** `null` with a non-null `missionId` ⇒ the mission row could not be read. */
  readonly mission: { readonly status: string } | null;
  /** `null` ⇒ the task rows could not be read. */
  readonly tasks: readonly { readonly status: string }[] | null;
  readonly runtime: { readonly state: string } | null;
  readonly pendingApproval: boolean;
  readonly controlHeld: boolean;
  /**
   * Non-terminal tasks carrying a REQUEST_CHANGES/RETRY review decision. `null` ⇒ review
   * history unavailable, so REPAIRING is never claimed.
   */
  readonly tasksAwaitingRepair: number | null;
}

export interface ObjectiveStateResult {
  readonly state: ObjectiveState;
  readonly phase: string;
  readonly blockedReason: string | null;
  readonly unknown: readonly string[];
}

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "superseded"]);
const RECOVERING_RUNTIME_STATES = new Set(["recovering", "recovery", "resuming"]);

export function deriveObjectiveState(input: ObjectiveStateInput): ObjectiveStateResult {
  const unknown: string[] = [];
  const done = (state: ObjectiveState, phase: string, blockedReason: string | null = null) => ({
    state,
    phase,
    blockedReason,
    unknown,
  });

  if (input.missionId === null) {
    return done("RECEIVED", "intake");
  }

  if (input.mission === null) {
    unknown.push("mission");
    return done("DEGRADED", "unknown", "mission_unreadable");
  }

  if (input.mission.status === "succeeded") return done("COMPLETED", "settled");
  if (input.mission.status === "failed") return done("FAILED", "settled");
  if (input.mission.status === "cancelled") return done("CANCELLED", "settled");

  if (input.tasks === null) {
    unknown.push("tasks");
    return done("DEGRADED", "unknown", "tasks_unreadable");
  }
  if (input.tasksAwaitingRepair === null) unknown.push("repairState");

  // A hold outranks every running description: the work is stopped, whatever it was doing.
  if (input.controlHeld) return done("BLOCKED", "held", "control_hold");
  if (input.mission.status === "blocked") return done("BLOCKED", "blocked", "mission_blocked");

  if (input.pendingApproval || input.mission.status === "awaiting_approval") {
    return done("WAITING_FOR_HUMAN", "approval");
  }

  if (input.runtime && RECOVERING_RUNTIME_STATES.has(input.runtime.state)) {
    return done("RECOVERING", "recovery");
  }

  if (input.mission.status === "draft") return done("CONTEXTUALIZED", "contextualisation");
  if (input.mission.status === "planning") return done("PLANNING", "planning");

  if (input.tasks.some((t) => t.status === "review_pending")) return done("REVIEWING", "review");
  if ((input.tasksAwaitingRepair ?? 0) > 0) return done("REPAIRING", "repair");
  if (input.tasks.some((t) => t.status === "running")) return done("EXECUTING", "execution");

  if (input.tasks.length > 0 && input.tasks.every((t) => TERMINAL_TASK_STATUSES.has(t.status))) {
    return done("DECISION_READY", "settlement");
  }

  return done("DELEGATING", "delegation");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/core/supervisor/objective-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/supervisor/objective-state.ts src/core/supervisor/objective-state.test.ts
git commit -m "feat(supervisor): objective state is derived, and unreadable truth degrades"
```

---

### Task 5: `GoalRepository.list()`

**Files:**
- Modify: `src/server/repositories/ports.ts:140-147`
- Modify: `src/server/services/in-memory/goal-repository.ts`
- Modify: `src/server/repositories/postgres/goal-repository.ts`
- Test: `src/server/repositories/goal-repository-list.test.ts`

**Interfaces:**
- Consumes: `HighLevelGoal`, `GoalPlanPreview`.
- Produces: `interface GoalRecord { goal: HighLevelGoal; status: string; resultingMissionId: string | null; convertedAt: string | null }` and `GoalRepository.list(filter?: { status?: string; limit?: number }): Promise<GoalRecord[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/repositories/goal-repository-list.test.ts
import { describe, expect, it } from "vitest";

import type { GoalPlanPreview, HighLevelGoal } from "@/core/contracts/high-level-goal";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryGoalRepository } from "@/server/services/in-memory/goal-repository";

const goal = (id: string, createdAt: string): HighLevelGoal => ({
  id,
  title: id,
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt,
});

const preview = (id: string): GoalPlanPreview => ({
  goalId: id,
  missionTitle: id,
  missionObjective: "o",
  tasks: [],
});

describe("GoalRepository.list", () => {
  it("returns goals newest first with their status and mission lineage", async () => {
    const repo = new InMemoryGoalRepository(new InMemoryAuditLog());
    await repo.create(goal("g-old", "2026-10-01T00:00:00.000Z"), preview("g-old"));
    await repo.create(goal("g-new", "2026-10-02T00:00:00.000Z"), preview("g-new"));
    await repo.setConverted("g-old", "m-1");

    const all = await repo.list();
    expect(all.map((r) => r.goal.id)).toEqual(["g-new", "g-old"]);
    expect(all[1]).toMatchObject({ status: "converted", resultingMissionId: "m-1" });
    expect(all[0]).toMatchObject({ status: "pending", resultingMissionId: null });
  });

  it("filters by status and honours a limit", async () => {
    const repo = new InMemoryGoalRepository(new InMemoryAuditLog());
    await repo.create(goal("a", "2026-10-01T00:00:00.000Z"), preview("a"));
    await repo.create(goal("b", "2026-10-02T00:00:00.000Z"), preview("b"));
    await repo.setConverted("b", "m-2");

    expect((await repo.list({ status: "converted" })).map((r) => r.goal.id)).toEqual(["b"]);
    expect(await repo.list({ limit: 1 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/repositories/goal-repository-list.test.ts`
Expected: FAIL — `repo.list is not a function`.

If `InMemoryAuditLog` is not the exported name at `@/server/audit/in-memory-audit-log`, open that file and use the exported class; do not create a second audit log.

- [ ] **Step 3: Write minimal implementation**

In `src/server/repositories/ports.ts`, beside the existing `GoalRepository`:

```ts
/** A goal plus the columns `rowToGoal` drops: the read model needs lineage, not just intent. */
export interface GoalRecord {
  goal: HighLevelGoal;
  status: string;
  resultingMissionId: string | null;
  convertedAt: string | null;
}
```

and add to `interface GoalRepository`:

```ts
  /** Newest first. Read-only; no new table, these are existing columns. */
  list(filter?: { status?: string; limit?: number }): Promise<GoalRecord[]>;
```

In `src/server/services/in-memory/goal-repository.ts`:

```ts
  async list(filter?: { status?: string; limit?: number }): Promise<GoalRecord[]> {
    const rows = [...this.goals.values()]
      .filter((e) => filter?.status === undefined || e.status === filter.status)
      .map((e) => ({
        goal: e.goal,
        status: e.status,
        resultingMissionId: e.resultingMissionId ?? null,
        convertedAt: e.convertedAt ?? null,
      }))
      // Newest first, id as the tie-break: the same total order as PostgreSQL.
      .sort(
        (a, b) =>
          new Date(b.goal.createdAt).getTime() - new Date(a.goal.createdAt).getTime() ||
          (a.goal.id < b.goal.id ? -1 : a.goal.id > b.goal.id ? 1 : 0),
      );
    return filter?.limit === undefined ? rows : rows.slice(0, filter.limit);
  }
```

Add `import type { GoalRecord, GoalRepository } from "@/server/repositories/ports";` to that file's existing type import.

In `src/server/repositories/postgres/goal-repository.ts`:

```ts
  async list(filter?: { status?: string; limit?: number }): Promise<GoalRecord[]> {
    const base = this.db.select().from(goals);
    const scoped = filter?.status === undefined ? base : base.where(eq(goals.status, filter.status));
    const ordered = scoped.orderBy(desc(goals.createdAt), asc(goals.id));
    const rows = await (filter?.limit === undefined ? ordered : ordered.limit(filter.limit));

    return rows.map((row) => ({
      goal: rowToGoal(row),
      status: row.status,
      resultingMissionId: row.resultingMissionId ?? null,
      convertedAt: row.convertedAt ? row.convertedAt.toISOString() : null,
    }));
  }
```

Extend that file's drizzle import to `import { and, asc, desc, eq } from "drizzle-orm";` and its ports import to include `GoalRecord`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/repositories/goal-repository-list.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck, because two implementations must satisfy one port**

Run: `pnpm exec tsc --noEmit`
Expected: no error in `goal-repository.ts` or `ports.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/server/repositories/ports.ts src/server/services/in-memory/goal-repository.ts src/server/repositories/postgres/goal-repository.ts src/server/repositories/goal-repository-list.test.ts
git commit -m "feat(goals): read-only list() over existing columns, same order in both stores"
```

---

### Task 6: ObjectiveCoordinator

**Files:**
- Create: `src/server/supervisor/objective-coordinator.ts`
- Test: `src/server/supervisor/objective-coordinator.test.ts`

**Interfaces:**
- Consumes: `scoreObjective`, `DEFAULT_PRIORITY_POLICY`, `PriorityPolicy`, `PriorityResult` (Task 2); `allocate`, `DEFAULT_PORTFOLIO_POLICY`, `PortfolioPolicy`, `PortfolioState` (Task 3); `GoalRecord` (Task 5); `SchedulerService` from `@/server/scheduler/scheduler-service`.
- Produces:
  - `interface ObjectiveCoordinatorDeps { scheduler; goals; missions; priorityPolicy?; portfolioPolicy?; now? }`
  - `class ObjectiveCoordinator { admit(input): Promise<AdmissionResult> }`
  - `interface AdmitInput { goal: HighLevelGoal; idempotencyKey: string; title: string; objective: string }`
  - `type AdmissionResult = { outcome: "enqueued"; jobId; missionId; priority; evidence } | { outcome: "deferred"; jobId; missionId; retryAfterMs; reason; evidence }`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/supervisor/objective-coordinator.test.ts
import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { DEFAULT_PORTFOLIO_POLICY } from "@/core/supervisor/portfolio";

import { ObjectiveCoordinator } from "./objective-coordinator";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const goal = (over: Partial<HighLevelGoal> = {}): HighLevelGoal => ({
  id: "g-1",
  title: "Improve the Mécène",
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => {
  const enqueue = vi.fn(async (input: Record<string, unknown>) => ({
    job: { id: "job-1", missionId: "m-1", ...input },
    created: true,
  }));
  return {
    enqueue,
    deps: {
      scheduler: { enqueue } as never,
      goals: { list: vi.fn(async () => []) } as never,
      missions: { list: vi.fn(async () => []) } as never,
      now: () => NOW,
      ...over,
    },
  };
};

describe("ObjectiveCoordinator", () => {
  it("enqueues the existing start_mission job with a scored priority", async () => {
    const { enqueue, deps: d } = deps();
    const c = new ObjectiveCoordinator(d);

    const r = await c.admit({
      goal: goal({ metadata: { source: "cognitive_conversation" } }),
      idempotencyKey: "k-1",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("enqueued");
    const call = enqueue.mock.calls[0][0];
    expect(call.kind).toBe("start_mission");
    expect(call.idempotencyKey).toBe("k-1");
    expect(call.priority).toBeGreaterThan(80);
    expect(call.runAt).toBeUndefined();
  });

  it("uses only the existing job kind — it never invents a second one", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(enqueue.mock.calls.every(([c]) => c.kind === "start_mission")).toBe(true);
  });

  it("defers by setting runAt on the same job, never by rejecting", async () => {
    // Saturate RESEARCH, which the default policy caps at 1 concurrent objective.
    const active = Array.from({ length: DEFAULT_PORTFOLIO_POLICY.classes.RESEARCH.maxConcurrent });
    const { enqueue, deps: d } = deps({
      goals: {
        list: vi.fn(async () =>
          active.map((_, i) => ({
            goal: goal({ id: `running-${i}` }),
            status: "converted",
            resultingMissionId: `m-${i}`,
            convertedAt: NOW.toISOString(),
          })),
        ),
      },
      missions: {
        list: vi.fn(async () =>
          active.map((_, i) => ({ id: `m-${i}`, status: "running" })),
        ),
      },
    });

    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-new" }),
      idempotencyKey: "k-2",
      title: "t",
      objective: "o",
    });

    expect(r.outcome).toBe("deferred");
    if (r.outcome !== "deferred") throw new Error("unreachable");
    expect(r.reason).toBe("CLASS_CONCURRENCY");
    const call = enqueue.mock.calls[0][0];
    expect(call.kind).toBe("start_mission");
    expect((call.runAt as Date).getTime()).toBe(NOW.getTime() + r.retryAfterMs);
  });

  it("carries the priority and allocation evidence on the result", async () => {
    const { deps: d } = deps();
    const r = await new ObjectiveCoordinator(d).admit({
      goal: goal(),
      idempotencyKey: "k-3",
      title: "t",
      objective: "o",
    });
    expect(r.evidence.priority.policyVersion).toMatch(/^priority\//);
    expect(r.evidence.allocation.policyVersion).toMatch(/^portfolio\//);
    expect(r.evidence.priority.missing.length).toBeGreaterThan(0);
  });

  it("holds no state between calls", async () => {
    const { deps: d } = deps();
    const c = new ObjectiveCoordinator(d);
    const a = await c.admit({ goal: goal(), idempotencyKey: "k", title: "t", objective: "o" });
    const b = await c.admit({ goal: goal(), idempotencyKey: "k", title: "t", objective: "o" });
    expect(a.evidence).toEqual(b.evidence);
  });

  it("passes the caller's goalId through unchanged", async () => {
    const { enqueue, deps: d } = deps();
    await new ObjectiveCoordinator(d).admit({
      goal: goal({ id: "g-abc" }),
      idempotencyKey: "k",
      title: "t",
      objective: "o",
    });
    expect(enqueue.mock.calls[0][0].payload).toEqual({ title: "t", objective: "o", goalId: "g-abc" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/supervisor/objective-coordinator.test.ts`
Expected: FAIL — cannot resolve `./objective-coordinator`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/supervisor/objective-coordinator.ts
import type { HighLevelGoal } from "@/core/contracts/high-level-goal";
import { WORK_CLASSES, type WorkClass } from "@/core/supervisor/contracts";
import {
  DEFAULT_PRIORITY_POLICY,
  classifyObjective,
  scoreObjective,
  type PriorityPolicy,
  type PriorityResult,
} from "@/core/supervisor/priority";
import {
  DEFAULT_PORTFOLIO_POLICY,
  allocate,
  type AllocationEvidence,
  type DeferReason,
  type PortfolioPolicy,
  type PortfolioState,
} from "@/core/supervisor/portfolio";
import type { Mission } from "@/core/mission/contracts";
import type { MissionRepository } from "@/server/mission/ports";
import type { GoalRecord, GoalRepository } from "@/server/repositories/ports";
import type { SchedulerService } from "@/server/scheduler/scheduler-service";

/**
 * CHIEF SUPERVISOR — objective admission (decision 0065).
 *
 * A THIN coordinator: it reads facts, calls two pure functions, and enqueues the EXISTING
 * `start_mission` job. It owns no loop, no lease, no retry and no state between calls.
 * Remove it and launches revert to priority 0 and unbounded admission — today's behaviour.
 *
 * It decides ADMISSION only. Work already running is held, paused or cancelled by
 * RuntimeControlGuard and the control plane; this class has no reference to either and
 * cannot stand in for them.
 */

export interface ObjectiveCoordinatorDeps {
  readonly scheduler: Pick<SchedulerService, "enqueue">;
  readonly goals: Pick<GoalRepository, "list">;
  readonly missions: Pick<MissionRepository, "list">;
  readonly priorityPolicy?: PriorityPolicy;
  readonly portfolioPolicy?: PortfolioPolicy;
  readonly now?: () => Date;
}

export interface AdmitInput {
  readonly goal: HighLevelGoal;
  readonly idempotencyKey: string;
  readonly title: string;
  readonly objective: string;
}

export interface AdmissionEvidence {
  readonly priority: PriorityResult;
  readonly allocation: AllocationEvidence;
}

export type AdmissionResult =
  | {
      readonly outcome: "enqueued";
      readonly jobId: string;
      readonly missionId: string | undefined;
      readonly created: boolean;
      readonly priority: number;
      readonly evidence: AdmissionEvidence;
    }
  | {
      readonly outcome: "deferred";
      readonly jobId: string;
      readonly missionId: string | undefined;
      readonly created: boolean;
      readonly priority: number;
      readonly retryAfterMs: number;
      readonly reason: DeferReason;
      readonly evidence: AdmissionEvidence;
    };

/** Missions that still occupy a portfolio slot. */
const ACTIVE_MISSION_STATUSES = new Set<Mission["status"]>([
  "draft",
  "planning",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
]);

const zeroedByClass = (): Record<WorkClass, number> =>
  Object.fromEntries(WORK_CLASSES.map((c) => [c, 0])) as Record<WorkClass, number>;

export class ObjectiveCoordinator {
  constructor(private readonly deps: ObjectiveCoordinatorDeps) {}

  private get priorityPolicy(): PriorityPolicy {
    return this.deps.priorityPolicy ?? DEFAULT_PRIORITY_POLICY;
  }

  private get portfolioPolicy(): PortfolioPolicy {
    return this.deps.portfolioPolicy ?? DEFAULT_PORTFOLIO_POLICY;
  }

  /**
   * Counts the objectives currently occupying a slot, per work class.
   *
   * Compute spend is NOT tracked: no execution record carries a cost today (see the read
   * model's UNKNOWN cost). Reporting 0 spent would be a fabricated measurement, so the
   * window simply starts now and the budget gate is inert until costs exist.
   */
  private async observePortfolio(now: Date): Promise<PortfolioState> {
    const [goals, missions] = await Promise.all([
      this.deps.goals.list({ status: "converted" }),
      this.deps.missions.list(),
    ]);

    const activeMissionIds = new Set(
      missions.filter((m) => ACTIVE_MISSION_STATUSES.has(m.status)).map((m) => m.id),
    );

    const active = zeroedByClass();
    for (const record of goals as readonly GoalRecord[]) {
      if (!record.resultingMissionId || !activeMissionIds.has(record.resultingMissionId)) continue;
      active[classifyObjective(this.priorityPolicy, record.goal).class] += 1;
    }

    return { windowStartedAt: now, active, computeSpent: zeroedByClass() };
  }

  async admit(input: AdmitInput): Promise<AdmissionResult> {
    const now = this.deps.now?.() ?? new Date();

    const priority = scoreObjective(this.priorityPolicy, input.goal, { now });
    const state = await this.observePortfolio(now);
    const decision = allocate(
      this.portfolioPolicy,
      state,
      { class: priority.class, computeUnits: 1 },
      now,
    );

    const evidence: AdmissionEvidence = { priority, allocation: decision.evidence };

    /*
     * Deferral is `runAt` on the SAME durable job: the existing scheduler already orders,
     * leases and retries it. Nothing new holds the objective, and the caller still gets a
     * durable job id and mission id, so a deferred launch is never lost.
     */
    const { job, created } = await this.deps.scheduler.enqueue({
      kind: "start_mission",
      idempotencyKey: input.idempotencyKey,
      payload: { title: input.title, objective: input.objective, goalId: input.goal.id },
      priority: priority.priority,
      ...(decision.admit ? {} : { runAt: new Date(now.getTime() + decision.retryAfterMs) }),
    });

    if (decision.admit) {
      return {
        outcome: "enqueued",
        jobId: job.id,
        missionId: job.missionId,
        created,
        priority: priority.priority,
        evidence,
      };
    }

    return {
      outcome: "deferred",
      jobId: job.id,
      missionId: job.missionId,
      created,
      priority: priority.priority,
      retryAfterMs: decision.retryAfterMs,
      reason: decision.reason,
      evidence,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/supervisor/objective-coordinator.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/supervisor/objective-coordinator.ts src/server/supervisor/objective-coordinator.test.ts
git commit -m "feat(supervisor): ObjectiveCoordinator scores, allocates, and enqueues the existing job"
```

---

### Task 7: Objective read model

**Files:**
- Create: `src/server/supervisor/objective-read-model.ts`
- Test: `src/server/supervisor/objective-read-model.test.ts`

**Interfaces:**
- Consumes: `deriveObjectiveState` (Task 4), `scoreObjective` (Task 2), `GoalRecord` (Task 5).
- Produces:
  - `interface ObjectiveView { ... }`
  - `interface ObjectiveReadModelDeps { goals; missions; reviews; runtimes; controlHolds; priorityPolicy?; now? }`
  - `buildObjectiveReadModel(deps, options?): Promise<ObjectiveView[]>`

- [ ] **Step 1: Write the failing test**

```ts
// src/server/supervisor/objective-read-model.test.ts
import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import { buildObjectiveReadModel } from "./objective-read-model";

const NOW = new Date("2026-10-02T12:00:00.000Z");

const goal = (over: Partial<HighLevelGoal> = {}): HighLevelGoal => ({
  id: "g-1",
  title: "Occupe-toi de LDS",
  objective: "o",
  rawInput: "o",
  normalizedIntent: "o",
  constraints: [],
  successCriteria: [],
  priority: 3,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

const deps = (over: Record<string, unknown> = {}) => ({
  goals: { list: vi.fn(async () => []) },
  missions: { findById: vi.fn(async () => null), listTasks: vi.fn(async () => []) },
  reviews: { listByMissionId: vi.fn(async () => []) },
  runtimes: { get: vi.fn(async () => null) },
  controlHolds: { isHeld: vi.fn(async () => false) },
  now: () => NOW,
  ...over,
});

describe("buildObjectiveReadModel", () => {
  it("reports a goal with no mission as RECEIVED with UNKNOWN progress", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          { goal: goal(), status: "pending", resultingMissionId: null, convertedAt: null },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.state).toBe("RECEIVED");
    expect(view.progress).toBe("UNKNOWN");
    expect(view.assignedWorkers).toBe("UNKNOWN");
  });

  it("reports cost as UNKNOWN, because no execution record carries one", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          { goal: goal(), status: "pending", resultingMissionId: null, convertedAt: null },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);
    expect(view.cost).toBe("UNKNOWN");
  });

  it("carries the priority decision with its policy version and missing evidence", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal({ metadata: { source: "cognitive_conversation" } }),
            status: "pending",
            resultingMissionId: null,
            convertedAt: null,
          },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.priority.class).toBe("USER");
    expect(view.priority.classSource).toBe("rule");
    expect(view.priority.policyVersion).toMatch(/^priority\//);
    expect(view.priority.missing.length).toBeGreaterThan(0);
  });

  it("degrades when a converted goal names a mission that cannot be read", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-gone",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      missions: { findById: vi.fn(async () => null), listTasks: vi.fn(async () => []) },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.state).toBe("DEGRADED");
    expect(view.degraded?.unknown).toContain("mission");
    expect(view.blockedReason).toBe("mission_unreadable");
  });

  it("counts progress and names the workers a running mission has assigned", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-1",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      missions: {
        findById: vi.fn(async () => ({ id: "m-1", status: "running" })),
        listTasks: vi.fn(async () => [
          { taskId: "t1", status: "succeeded", workerKind: "engineering" },
          { taskId: "t2", status: "running", workerKind: "seo" },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.state).toBe("EXECUTING");
    expect(view.progress).toEqual({ tasksTotal: 2, tasksSettled: 1 });
    expect(view.assignedWorkers).toEqual(["engineering", "seo"]);
  });

  it("surfaces the latest review verdict and flags a human decision", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-1",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      missions: {
        findById: vi.fn(async () => ({ id: "m-1", status: "running" })),
        listTasks: vi.fn(async () => [
          { taskId: "t1", status: "awaiting_approval", workerKind: null },
        ]),
      },
      reviews: {
        listByMissionId: vi.fn(async () => [
          {
            taskId: "t1",
            decision: "REQUEST_CHANGES",
            reasons: ["scope"],
            createdAt: "2026-10-02T11:00:00.000Z",
          },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    expect(view.reviewState).toBe("REQUEST_CHANGES");
    expect(view.humanDecisionRequired).toBe(true);
    expect(view.state).toBe("WAITING_FOR_HUMAN");
    expect(view.latestMeaningfulResult).toContain("REQUEST_CHANGES");
  });

  it("SUPERVISOR_STALE_MEMORY_NOT_LIVE_AUTHORITY: an old review never overrides live rows", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal(),
            status: "converted",
            resultingMissionId: "m-1",
            convertedAt: NOW.toISOString(),
          },
        ]),
      },
      missions: {
        findById: vi.fn(async () => ({ id: "m-1", status: "succeeded" })),
        listTasks: vi.fn(async () => [{ taskId: "t1", status: "succeeded", workerKind: "eng" }]),
      },
      reviews: {
        listByMissionId: vi.fn(async () => [
          {
            taskId: "t1",
            decision: "BLOCK",
            reasons: ["an older verdict"],
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ]),
      },
    });
    const [view] = await buildObjectiveReadModel(d as never);

    // The live mission row says succeeded. A stale BLOCK is reported, never obeyed.
    expect(view.state).toBe("COMPLETED");
    expect(view.reviewState).toBe("BLOCK");
  });

  it("orders objectives by the priority governor's total order", async () => {
    const d = deps({
      goals: {
        list: vi.fn(async () => [
          {
            goal: goal({ id: "research" }),
            status: "pending",
            resultingMissionId: null,
            convertedAt: null,
          },
          {
            goal: goal({ id: "user", metadata: { source: "cognitive_conversation" } }),
            status: "pending",
            resultingMissionId: null,
            convertedAt: null,
          },
        ]),
      },
    });
    const views = await buildObjectiveReadModel(d as never);
    expect(views.map((v) => v.objectiveId)).toEqual(["user", "research"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/supervisor/objective-read-model.test.ts`
Expected: FAIL — cannot resolve `./objective-read-model`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/server/supervisor/objective-read-model.ts
import { UNKNOWN, type Maybe, type ObjectiveState } from "@/core/supervisor/contracts";
import { deriveObjectiveState } from "@/core/supervisor/objective-state";
import {
  DEFAULT_PRIORITY_POLICY,
  compareScored,
  scoreObjective,
  type PriorityPolicy,
  type PriorityResult,
} from "@/core/supervisor/priority";
import type { GoalRepository } from "@/server/repositories/ports";

/**
 * OBJECTIVE READ MODEL (decision 0065). READ-ONLY and DERIVED.
 *
 * It answers "what is ICOS doing?" without the reader knowing worker internals. It holds
 * no rule of its own and writes nothing: every field is read from a canonical row or is
 * UNKNOWN. A field is UNKNOWN when the source truth does not exist or cannot be read —
 * never 0, never "", never a plausible stand-in.
 */

export interface ObjectiveProgress {
  readonly tasksTotal: number;
  readonly tasksSettled: number;
}

export interface ObjectiveView {
  readonly objectiveId: string;
  readonly title: string;
  readonly missionId: string | null;
  readonly state: ObjectiveState;
  readonly phase: string;
  readonly priority: PriorityResult;
  readonly progress: Maybe<ObjectiveProgress>;
  readonly assignedWorkers: Maybe<readonly string[]>;
  readonly reviewState: Maybe<string>;
  readonly blockedReason: string | null;
  readonly humanDecisionRequired: boolean;
  readonly cost: Maybe<number>;
  readonly elapsedMs: number;
  readonly latestMeaningfulResult: Maybe<string>;
  readonly degraded: { readonly unknown: readonly string[] } | null;
}

interface MissionRow {
  readonly id: string;
  readonly status: string;
}
interface MissionTaskRow {
  readonly taskId: string;
  readonly status: string;
  readonly workerKind?: string | null;
}
interface ReviewRow {
  readonly taskId: string;
  readonly decision: string;
  readonly reasons: readonly string[];
  readonly createdAt: string;
}

export interface ObjectiveReadModelDeps {
  readonly goals: Pick<GoalRepository, "list">;
  readonly missions: {
    findById(id: string): Promise<MissionRow | null>;
    listTasks(missionId: string): Promise<readonly MissionTaskRow[]>;
  };
  readonly reviews: { listByMissionId(missionId: string): Promise<readonly ReviewRow[]> };
  readonly runtimes: { get(missionId: string): Promise<{ state: string } | null> };
  /**
   * The CANONICAL control authority, read-only. This layer asks RuntimeControlGuard
   * whether a mission is held; it never decides, and never holds anything itself.
   */
  readonly controlHolds: { isHeld(missionId: string): Promise<boolean> };
  readonly priorityPolicy?: PriorityPolicy;
  readonly now?: () => Date;
}

const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "cancelled", "superseded"]);
/** A verdict that sends work back is what puts an objective in REPAIRING. */
const REPAIR_DECISIONS = new Set(["REQUEST_CHANGES", "RETRY"]);

/** Reading a side fact must never fail the whole projection: an error IS an unknown. */
const soften = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch {
    return null;
  }
};

export async function buildObjectiveReadModel(
  deps: ObjectiveReadModelDeps,
  options: { limit?: number } = {},
): Promise<ObjectiveView[]> {
  const now = deps.now?.() ?? new Date();
  const policy = deps.priorityPolicy ?? DEFAULT_PRIORITY_POLICY;
  const records = await deps.goals.list({ limit: options.limit });

  const views = await Promise.all(
    records.map(async (record) => {
      const priority = scoreObjective(policy, record.goal, { now });
      const missionId = record.resultingMissionId;

      if (!missionId) {
        const derived = deriveObjectiveState({
          goalStatus: record.status,
          missionId: null,
          mission: null,
          tasks: null,
          runtime: null,
          pendingApproval: false,
          controlHeld: false,
          tasksAwaitingRepair: null,
        });
        return {
          goal: record.goal,
          result: priority,
          view: baseView(record.goal, null, derived, priority, now),
        };
      }

      const mission = await soften(() => deps.missions.findById(missionId));
      const [tasks, reviews, runtime, controlHeld] = await Promise.all([
        mission ? soften(() => deps.missions.listTasks(missionId)) : Promise.resolve(null),
        soften(() => deps.reviews.listByMissionId(missionId)),
        soften(() => deps.runtimes.get(missionId)),
        soften(() => deps.controlHolds.isHeld(missionId)),
      ]);

      /*
       * Mission-level approval IS `mission.status === "awaiting_approval"` (see
       * /api/missions/[id]/approval); a task waits via its own status. There is no
       * separate per-mission pending-approval store to consult, so none is invented.
       */
      const pendingApproval = (tasks ?? []).some((t) => t.status === "awaiting_approval");

      const latestByTask = new Map<string, ReviewRow>();
      for (const r of reviews ?? []) {
        const seen = latestByTask.get(r.taskId);
        if (!seen || new Date(r.createdAt) > new Date(seen.createdAt)) latestByTask.set(r.taskId, r);
      }

      const tasksAwaitingRepair =
        tasks === null || reviews === null
          ? null
          : tasks.filter(
              (t) =>
                !TERMINAL_TASK_STATUSES.has(t.status) &&
                REPAIR_DECISIONS.has(latestByTask.get(t.taskId)?.decision ?? ""),
            ).length;

      const derived = deriveObjectiveState({
        goalStatus: record.status,
        missionId,
        mission: mission ? { status: mission.status } : null,
        tasks: tasks ? tasks.map((t) => ({ status: t.status })) : null,
        runtime,
        pendingApproval,
        controlHeld: controlHeld ?? false,
        tasksAwaitingRepair,
      });

      const latestReview = [...latestByTask.values()].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];

      const view: ObjectiveView = {
        ...baseView(record.goal, missionId, derived, priority, now),
        progress: tasks
          ? {
              tasksTotal: tasks.length,
              tasksSettled: tasks.filter((t) => TERMINAL_TASK_STATUSES.has(t.status)).length,
            }
          : UNKNOWN,
        assignedWorkers: tasks
          ? [...new Set(tasks.map((t) => t.workerKind).filter((k): k is string => Boolean(k)))].sort()
          : UNKNOWN,
        reviewState: latestReview ? latestReview.decision : UNKNOWN,
        humanDecisionRequired: pendingApproval || derived.state === "WAITING_FOR_HUMAN",
        latestMeaningfulResult: latestReview
          ? `${latestReview.decision}: ${latestReview.reasons.join("; ")}`
          : UNKNOWN,
      };

      return { goal: record.goal, result: priority, view };
    }),
  );

  return views.sort((a, b) => compareScored(a, b)).map((v) => v.view);
}

function baseView(
  goal: { id: string; title: string; createdAt: string },
  missionId: string | null,
  derived: ReturnType<typeof deriveObjectiveState>,
  priority: PriorityResult,
  now: Date,
): ObjectiveView {
  return {
    objectiveId: goal.id,
    title: goal.title,
    missionId,
    state: derived.state,
    phase: derived.phase,
    priority,
    progress: UNKNOWN,
    assignedWorkers: UNKNOWN,
    reviewState: UNKNOWN,
    blockedReason: derived.blockedReason,
    humanDecisionRequired: derived.state === "WAITING_FOR_HUMAN",
    /*
     * No CORE3 execution record carries a cost today (there is no cost column on
     * task_execution_results). Reporting 0 would be a fabricated measurement.
     */
    cost: UNKNOWN,
    elapsedMs: now.getTime() - new Date(goal.createdAt).getTime(),
    latestMeaningfulResult: UNKNOWN,
    degraded: derived.unknown.length > 0 ? { unknown: derived.unknown } : null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/supervisor/objective-read-model.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server/supervisor/objective-read-model.ts src/server/supervisor/objective-read-model.test.ts
git commit -m "feat(supervisor): objective read model, UNKNOWN where truth is absent"
```

---

### Task 8: Wire admission into the two launch points

**Files:**
- Modify: `src/server/cognitive/mission-gateway.ts:91-97`
- Modify: `src/app/api/missions/autonomous/route.ts:84-100`
- Modify: `src/server/container.ts` (expose `objectiveCoordinator` and `controlGuard`)
- Test: `src/server/cognitive/mission-gateway-admission.test.ts`

**Interfaces:**
- Consumes: `ObjectiveCoordinator`, `AdmissionResult` (Task 6).
- Produces: `CanonicalGoalLauncher` accepting an optional `objectiveCoordinator` dep; `AppContainer.objectiveCoordinator: ObjectiveCoordinator`; `AppContainer.controlGuard: RuntimeControlGuard`.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/cognitive/mission-gateway-admission.test.ts
import { describe, expect, it, vi } from "vitest";

import { CanonicalGoalLauncher } from "./mission-gateway";

const proposal = {
  id: "p-1",
  title: "Trouve-moi des clients",
  objective: "prospect",
  constraints: [],
  successCriteria: [],
  riskLevel: "reversible" as const,
};

const request = {
  refId: "ref-1",
  conversationId: "c-1",
  turnId: "t-1",
  approvedBy: "geoffrey",
  clientId: null,
  projectId: null,
};

const launcher = (coordinator?: unknown) => {
  const enqueue = vi.fn(async () => ({ job: { id: "j", missionId: "m" }, created: true }));
  const goal = {
    id: "g-1",
    title: proposal.title,
    objective: proposal.objective,
    rawInput: proposal.objective,
    normalizedIntent: proposal.objective,
    constraints: [],
    successCriteria: [],
    priority: 3,
    riskLevel: "reversible",
    allowedCapabilities: [],
    forbiddenCapabilities: [],
    humanApprovalPolicy: "always",
    metadata: { source: "cognitive_conversation", conversationId: "c-1", turnId: "t-1", proposalRefId: "ref-1", approvedBy: "geoffrey" },
    createdAt: "2026-10-01T00:00:00.000Z",
  };
  return {
    enqueue,
    instance: new CanonicalGoalLauncher({
      goalNormalizer: { normalize: () => goal } as never,
      goalPlanner: { plan: () => ({ goalId: "g-1", missionTitle: "t", missionObjective: "o", tasks: [] }) } as never,
      goalPreviewStore: { store: vi.fn(async () => undefined) } as never,
      goalRepository: { getById: vi.fn(async () => null) } as never,
      scheduler: { enqueue } as never,
      objectiveCoordinator: coordinator as never,
    }),
  };
};

describe("CanonicalGoalLauncher admission", () => {
  it("routes the launch through the coordinator when one is composed", async () => {
    const admit = vi.fn(async () => ({
      outcome: "enqueued" as const,
      jobId: "j",
      missionId: "m",
      created: true,
      priority: 92,
      evidence: { priority: {}, allocation: {} },
    }));
    const { enqueue, instance } = launcher({ admit });

    const r = await instance.launch(proposal as never, request);

    expect(admit).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "launched", missionId: "m" });
  });

  it("reports a deferred launch as launched, because the job is durable", async () => {
    const admit = vi.fn(async () => ({
      outcome: "deferred" as const,
      jobId: "j",
      missionId: "m",
      created: true,
      priority: 5,
      retryAfterMs: 300_000,
      reason: "CLASS_CONCURRENCY" as const,
      evidence: { priority: {}, allocation: {} },
    }));
    const { instance } = launcher({ admit });

    const r = await instance.launch(proposal as never, request);
    expect(r).toMatchObject({ status: "launched", missionId: "m" });
  });

  it("falls back to the plain enqueue when no coordinator is composed", async () => {
    const { enqueue, instance } = launcher(undefined);
    const r = await instance.launch(proposal as never, request);

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ status: "launched" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/server/cognitive/mission-gateway-admission.test.ts`
Expected: FAIL — `admit` never called; the gateway still enqueues directly.

- [ ] **Step 3: Write minimal implementation**

In `src/server/cognitive/mission-gateway.ts`, add to the constructor deps object:

```ts
      /**
       * Objective admission (decision 0065). Optional: without it a launch enqueues at
       * priority 0 and unbounded, exactly as before this lane. The coordinator never
       * replaces the scheduler — it calls the same enqueue with a priority and runAt.
       */
      objectiveCoordinator?: {
        admit(input: {
          goal: HighLevelGoal;
          idempotencyKey: string;
          title: string;
          objective: string;
        }): Promise<{ jobId: string; missionId: string | undefined }>;
      };
```

add `import type { HighLevelGoal } from "@/core/contracts/high-level-goal";`, and replace the enqueue block:

```ts
    const idempotencyKey = launchIdempotencyKey(r.refId);
    const admitted = this.deps.objectiveCoordinator
      ? await this.deps.objectiveCoordinator.admit({
          goal,
          idempotencyKey,
          title: goal.title,
          objective: goal.objective,
        })
      : await this.deps.scheduler
          .enqueue({
            kind: "start_mission",
            idempotencyKey,
            payload: { title: goal.title, objective: goal.objective, goalId: goal.id },
          })
          .then(({ job }) => ({ jobId: job.id, missionId: job.missionId }));

    if (!admitted.missionId) return { status: "failed", reason: "scheduler_returned_no_mission_id" };
    /*
     * A DEFERRED admission is still `launched`: the durable job exists and the missionId is
     * fixed. Reporting a failure would push the caller to launch a second time.
     */
    return {
      status: "launched",
      goalId: goal.id,
      missionId: admitted.missionId,
      launchJobId: admitted.jobId,
    };
```

In `src/app/api/missions/autonomous/route.ts`, replace the `container.scheduler.enqueue({...})` call with:

```ts
      const idempotencyKey = `${RESERVED_KEY_PREFIX}${access.session.user.id}:${createHash("sha256")
        .update(callerKey ?? randomUUID())
        .digest("hex")}`;

      /*
       * Objective admission (decision 0065): the goal is SCORED and the portfolio is
       * consulted before the existing start_mission job is enqueued. A deferred admission
       * still returns 202 with a durable job and mission id — the scheduler brings it back.
       */
      const stored = await container.goalRepository.getById(parsed.data.goalId);
      const admitted = stored
        ? await container.objectiveCoordinator.admit({
            goal: stored.goal,
            idempotencyKey,
            title: parsed.data.title,
            objective: parsed.data.objective,
          })
        : null;

      const { job, created } = admitted
        ? { job: { id: admitted.jobId, missionId: admitted.missionId, payload: {} }, created: admitted.created }
        : await container.scheduler.enqueue({
            kind: "start_mission",
            payload: {
              title: parsed.data.title,
              objective: parsed.data.objective,
              goalId: parsed.data.goalId,
            },
            idempotencyKey,
          });
```

In `src/server/container.ts`: add `objectiveCoordinator: ObjectiveCoordinator;` to the container interface beside `scheduler`, import `ObjectiveCoordinator` from `@/server/supervisor/objective-coordinator`, and construct it in BOTH composition functions, immediately after the `scheduler` is built, as:

```ts
    objectiveCoordinator: new ObjectiveCoordinator({
      scheduler: <the scheduler built on the preceding line>,
      goals: goalRepository,
      missions: mission,
    }),
```

Also expose the control guard, which both composition functions already build as a local
`const controlGuard` but never surface. Add to the container interface beside `scheduler`:

```ts
  /** READ-ONLY for projections; the canonical authority over running work. */
  controlGuard: RuntimeControlGuard;
```

and add `controlGuard,` to both returned objects. `RuntimeControlGuard` is already
imported in `container.ts`.

Hoist the scheduler into a `const scheduler = new SchedulerService(scheduledJobs);` first where it is currently inlined, and pass `scheduler` to both fields. Then pass `objectiveCoordinator` into the `CanonicalGoalLauncher` construction wherever it is composed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/server/cognitive/mission-gateway-admission.test.ts src/server/container.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/server/cognitive/mission-gateway.ts src/app/api/missions/autonomous/route.ts src/server/container.ts src/server/cognitive/mission-gateway-admission.test.ts
git commit -m "feat(supervisor): both launch points score and allocate before enqueueing"
```

---

### Task 9: `GET /api/supervisor/objectives`

**Files:**
- Create: `src/app/api/supervisor/objectives/route.ts`
- Test: `src/app/api/supervisor/objectives/route.test.ts`

**Interfaces:**
- Consumes: `buildObjectiveReadModel` (Task 7), `protectRoute`, `getContainer`.
- Produces: an HTTP GET returning `{ objectives: ObjectiveView[] }`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/api/supervisor/objectives/route.test.ts
import { describe, expect, it, vi } from "vitest";

const protectRoute = vi.fn();
const getContainer = vi.fn();

vi.mock("@/server/http/protect-route", () => ({ protectRoute }));
vi.mock("@/server/container", () => ({ getContainer }));

const { GET } = await import("./route");

describe("GET /api/supervisor/objectives", () => {
  it("refuses before reading anything when the session fails the gate", async () => {
    const container = { goalRepository: { list: vi.fn() } };
    getContainer.mockResolvedValue(container);
    protectRoute.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    const res = await GET(new Request("http://localhost/api/supervisor/objectives"));

    expect(res.status).toBe(403);
    expect(container.goalRepository.list).not.toHaveBeenCalled();
  });

  it("requires cockpit.read", async () => {
    getContainer.mockResolvedValue({ goalRepository: { list: vi.fn(async () => []) } });
    protectRoute.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });

    await GET(new Request("http://localhost/api/supervisor/objectives"));

    expect(protectRoute).toHaveBeenCalledWith(
      expect.objectContaining({ permission: "cockpit.read", route: "api.supervisor.objectives" }),
    );
  });

  it("exposes no write verb", async () => {
    const mod = await import("./route");
    expect(mod).not.toHaveProperty("POST");
    expect(mod).not.toHaveProperty("PUT");
    expect(mod).not.toHaveProperty("PATCH");
    expect(mod).not.toHaveProperty("DELETE");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/supervisor/objectives/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/api/supervisor/objectives/route.ts
import { getContainer } from "@/server/container";
import { toErrorResponse } from "@/server/http/map-error";
import { protectRoute } from "@/server/http/protect-route";
import { json } from "@/server/http/respond";
import { buildObjectiveReadModel } from "@/server/supervisor/objective-read-model";

/**
 * Objective read model — READ-ONLY (decision 0065).
 *
 * Answers "what is ICOS doing?" at objective level. Derived on every request from
 * canonical rows: it writes nothing, holds no rule, and has no write verb. Fields whose
 * source truth is absent come back as UNKNOWN rather than as a plausible value.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    // Authorization FIRST (fail closed): nothing is read before the session is checked.
    const access = await protectRoute({
      container,
      request,
      route: "api.supervisor.objectives",
      permission: "cockpit.read",
    });
    if (!access.ok) return access.response;

    const objectives = await buildObjectiveReadModel({
      goals: container.goalRepository,
      missions: container.mission,
      reviews: container.reviewDecisions,
      runtimes: { get: (missionId) => container.autonomousRuntime.get(missionId) },
      controlHolds: {
        /*
         * The canonical control authority answers this, not a status heuristic. Read-only:
         * asking the guard whether NEW work is admissible for a mission is how a hold
         * becomes visible, and is the only contact this projection has with control.
         */
        async isHeld(missionId) {
          const decision = await container.controlGuard.dispatch(missionId);
          return !decision.allowed;
        },
      },
    });

    return json({ objectives });
  } catch (error) {
    return toErrorResponse(error);
  }
}
```

`container.mission` and `container.reviewDecisions` already exist on the container
interface. `container.controlGuard` is added in Task 8. Do not add a repository method
for this route and do not widen any existing port: a fact the container cannot supply
becomes a `soften`ed `null`, which the read model already renders as UNKNOWN.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/supervisor/objectives/route.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/supervisor/objectives/route.ts src/app/api/supervisor/objectives/route.test.ts
git commit -m "feat(api): read-only objective projection at /api/supervisor/objectives"
```

---

### Task 10: E2E simulation

**Files:**
- Create: `src/server/supervisor/objective-e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: nothing; this is the lane's end-to-end evidence.

- [ ] **Step 1: Write the failing test**

```ts
// src/server/supervisor/objective-e2e.test.ts
import { describe, expect, it, vi } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import { ObjectiveCoordinator } from "./objective-coordinator";
import { buildObjectiveReadModel } from "./objective-read-model";

/**
 * SUPERVISOR_E2E — one user objective, two workers, an independent review, one repair
 * cycle, a completed result. Entirely in memory: no live DB, no external call, no
 * destructive action. It proves the lane's own claim (admission + truthful projection)
 * against a simulated run of the canonical pipeline, not a reimplementation of it.
 */

const NOW = new Date("2026-10-02T12:00:00.000Z");

const userGoal: HighLevelGoal = {
  id: "g-lds",
  title: "Occupe-toi de LDS",
  objective: "audit and fix the LDS contact form",
  rawInput: "Occupe-toi de LDS",
  normalizedIntent: "audit and fix the LDS contact form",
  constraints: [],
  successCriteria: ["form submits"],
  priority: 4,
  riskLevel: "reversible",
  allowedCapabilities: [],
  forbiddenCapabilities: [],
  humanApprovalPolicy: "if_risky",
  metadata: { source: "cognitive_conversation" },
  createdAt: "2026-10-02T11:00:00.000Z",
};

describe("SUPERVISOR_E2E", () => {
  it("objective → admission → plan → 2 workers → review → repair → completed", async () => {
    // --- world -----------------------------------------------------------------
    let missionStatus = "planning";
    let tasks = [
      { taskId: "t-audit", status: "queued", workerKind: "research" },
      { taskId: "t-fix", status: "queued", workerKind: "engineering" },
    ];
    const reviews: { taskId: string; decision: string; reasons: string[]; createdAt: string }[] = [];
    let converted = false;

    const enqueued: Record<string, unknown>[] = [];
    const scheduler = {
      enqueue: vi.fn(async (input: Record<string, unknown>) => {
        enqueued.push(input);
        return { job: { id: "job-1", missionId: "m-lds" }, created: true };
      }),
    };

    const goals = {
      list: vi.fn(async (filter?: { status?: string }) => {
        const record = {
          goal: userGoal,
          status: converted ? "converted" : "pending",
          resultingMissionId: converted ? "m-lds" : null,
          convertedAt: converted ? NOW.toISOString() : null,
        };
        if (filter?.status && filter.status !== record.status) return [];
        return [record];
      }),
    };

    const missions = {
      list: vi.fn(async () => (converted ? [{ id: "m-lds", status: missionStatus }] : [])),
      findById: vi.fn(async (id: string) =>
        converted && id === "m-lds" ? { id: "m-lds", status: missionStatus } : null,
      ),
      listTasks: vi.fn(async () => tasks),
    };

    const readModel = () =>
      buildObjectiveReadModel({
        goals: goals as never,
        missions: missions as never,
        reviews: { listByMissionId: async () => reviews },
        runtimes: { get: async () => null },
        controlHolds: { isHeld: async () => false },
        now: () => NOW,
      });

    // --- 1. admission ----------------------------------------------------------
    const coordinator = new ObjectiveCoordinator({
      scheduler: scheduler as never,
      goals: goals as never,
      missions: missions as never,
      now: () => NOW,
    });

    const admission = await coordinator.admit({
      goal: userGoal,
      idempotencyKey: "e2e-1",
      title: userGoal.title,
      objective: userGoal.objective,
    });

    expect(admission.outcome).toBe("enqueued");
    expect(admission.evidence.priority.class).toBe("USER");
    expect(enqueued[0]).toMatchObject({ kind: "start_mission" });
    expect(enqueued[0].priority).toBeGreaterThan(80);
    // Exactly one job: no second scheduler, no second executor.
    expect(scheduler.enqueue).toHaveBeenCalledTimes(1);

    // --- 2. the canonical runner plans and the mission becomes real -------------
    converted = true;
    expect((await readModel())[0].state).toBe("PLANNING");

    // --- 3. two workers execute in parallel ------------------------------------
    missionStatus = "running";
    tasks = [
      { taskId: "t-audit", status: "running", workerKind: "research" },
      { taskId: "t-fix", status: "running", workerKind: "engineering" },
    ];
    const executing = (await readModel())[0];
    expect(executing.state).toBe("EXECUTING");
    expect(executing.assignedWorkers).toEqual(["engineering", "research"]);
    expect(executing.progress).toEqual({ tasksTotal: 2, tasksSettled: 0 });

    // --- 4. independent review asks for changes on one task --------------------
    tasks = [
      { taskId: "t-audit", status: "succeeded", workerKind: "research" },
      { taskId: "t-fix", status: "review_pending", workerKind: "engineering" },
    ];
    expect((await readModel())[0].state).toBe("REVIEWING");

    reviews.push({
      taskId: "t-fix",
      decision: "REQUEST_CHANGES",
      reasons: ["validation missing on the email field"],
      createdAt: "2026-10-02T11:40:00.000Z",
    });
    tasks = [
      { taskId: "t-audit", status: "succeeded", workerKind: "research" },
      { taskId: "t-fix", status: "queued", workerKind: "engineering" },
    ];

    // --- 5. one repair cycle ---------------------------------------------------
    const repairing = (await readModel())[0];
    expect(repairing.state).toBe("REPAIRING");
    expect(repairing.reviewState).toBe("REQUEST_CHANGES");
    expect(repairing.latestMeaningfulResult).toContain("validation missing");

    // --- 6. the repair is approved and the mission settles ---------------------
    reviews.push({
      taskId: "t-fix",
      decision: "APPROVE",
      reasons: ["validation added"],
      createdAt: "2026-10-02T11:55:00.000Z",
    });
    tasks = [
      { taskId: "t-audit", status: "succeeded", workerKind: "research" },
      { taskId: "t-fix", status: "succeeded", workerKind: "engineering" },
    ];
    expect((await readModel())[0].state).toBe("DECISION_READY");

    missionStatus = "succeeded";
    const completed = (await readModel())[0];
    expect(completed.state).toBe("COMPLETED");
    expect(completed.progress).toEqual({ tasksTotal: 2, tasksSettled: 2 });
    expect(completed.reviewState).toBe("APPROVE");
    // Cost is not measured anywhere in CORE3 today, and is reported as such.
    expect(completed.cost).toBe("UNKNOWN");
    expect(completed.degraded).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `pnpm vitest run src/server/supervisor/objective-e2e.test.ts`
Expected: PASS if Tasks 1–7 are correct. A failure here is a real defect in those tasks — fix the module, never the assertion.

- [ ] **Step 3: Commit**

```bash
git add src/server/supervisor/objective-e2e.test.ts
git commit -m "test(supervisor): E2E objective → 2 workers → review → repair → completed, in memory"
```

---

### Task 11: Evidence map and decision 0065

**Files:**
- Create: `docs/supervisor/evidence-map.md`
- Create: `docs/decisions/0065-objective-priority-and-portfolio-are-admission-time-policy.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the lane's governance artefacts.

- [ ] **Step 1: Verify every referenced test file exists before citing it**

```bash
for f in \
  src/server/supervisor/postgres-dag-multibranch.integration.test.ts \
  src/server/supervisor/postgres-mission-restart.integration.test.ts \
  src/server/supervisor/postgres-multiworker-concurrent.integration.test.ts \
  src/server/supervisor/postgres-concurrent-dispatch-recovery.integration.test.ts \
  src/server/supervisor/supervisor-dispatch-ledger.test.ts \
  src/server/supervisor/readiness.ts \
  src/server/autonomy/reviewer-independence.ts \
  src/server/usecases/quality-control-service.ts \
  src/core/workforce/delegation.test.ts \
  src/core/workforce/governance.test.ts \
  src/server/memory/recorders.ts ; do
  test -e "$f" && echo "OK   $f" || echo "MISS $f"
done
```

Expected: every line `OK`. Any `MISS` means the citation is wrong — find the real file with `rg` before writing the map. A map that points at a file that does not exist is worse than no map.

- [ ] **Step 2: Write the evidence map**

Create `docs/supervisor/evidence-map.md` with one row per brief scenario:
scenario name · owning subsystem · the test file(s) verified in Step 1 · one sentence
on what that test actually asserts. Scenarios to cover: `SINGLE_OBJECTIVE`,
`MULTI_TASK_DAG`, `PARALLEL_DELEGATION`, `DEPENDENCY_ORDER`, `WORKER_FAILURE`,
`MODEL_FAILURE`, `REASSIGNMENT`, `FAILED_REVIEW`, `REPAIR_CYCLE`,
`HUMAN_ESCALATION`, `HUMAN_RESUME`, `RESTART_RESUME`, `NO_DUPLICATE_EXECUTION`,
`NO_SELF_APPROVAL`, `NO_AUTHORITY_ESCALATION`, `MEMORY_WRITEBACK`.

Open the heading with the reason the map exists: re-asserting another subsystem's
invariant in this lane would make this lane a second authority over it, and the two
copies would drift.

For the scenarios this lane does own, point at `src/core/supervisor/*.test.ts` and
`src/server/supervisor/objective-e2e.test.ts`.

- [ ] **Step 3: Write decision 0065**

Create `docs/decisions/0065-objective-priority-and-portfolio-are-admission-time-policy.md`
following the structure of `docs/decisions/0060-proactive-supervisor.md` (read it first
for the house format). The decision to record:

> Ordering and bounding objectives is **admission-time policy over existing authorities**,
> not a new runtime.

Consequences to state explicitly:
- `ObjectiveCoordinator` is thin; removing it reverts to priority 0 and unbounded admission.
- `RuntimeControlGuard` stays the only authority over running work.
- Objective state is derived; there is no second lifecycle to reconcile after a restart.
- Class bands make doctrine inversion arithmetically impossible, not merely unlikely.
- `goals.priority` becomes a consumed field for the first time.
- Absent evidence is reported, never inferred.

Verify the number is still free before writing: `ls docs/decisions | tail -3`.

- [ ] **Step 4: Commit**

```bash
git add docs/supervisor/evidence-map.md docs/decisions/0065-objective-priority-and-portfolio-are-admission-time-policy.md
git commit -m "docs(decisions): 0065 — objective ordering is admission-time policy"
```

---

### Task 12: Gates

**Files:** none.

- [ ] **Step 1: Targeted supervisor tests**

Run: `pnpm vitest run src/core/supervisor src/server/supervisor`
Expected: PASS.

- [ ] **Step 2: Adjacent subsystems this lane touched**

Run: `pnpm vitest run src/server/cognitive src/server/scheduler src/server/repositories src/app/api/missions src/server/container.test.ts`
Expected: PASS. Any failure here is a regression this lane caused — fix it, do not weaken the test.

- [ ] **Step 3: Full unit suite**

Run: `pnpm vitest run`
Expected: PASS. Record any pre-existing failure separately, with evidence that it also fails on `660b41f`.

- [ ] **Step 4: Typecheck, lint, build, whitespace**

```bash
pnpm exec tsc --noEmit
pnpm lint
pnpm build
git diff --check 660b41f..HEAD
```

Expected: all clean.

- [ ] **Step 5: Confirm the lane changed nothing it must not**

```bash
git diff --stat 660b41f..HEAD -- drizzle/
git diff --stat 660b41f..HEAD -- src/server/autonomy/ src/server/control/ src/server/recovery/ src/server/review/
```

Expected: both empty. A non-empty result means an authority boundary was crossed; revert that file.

- [ ] **Step 6: Commit any gate fixes**

```bash
git add -A
git commit -m "chore(supervisor): gate fixes"
```
