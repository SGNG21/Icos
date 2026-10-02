import { describe, expect, it } from "vitest";

import type { HighLevelGoal } from "@/core/contracts/high-level-goal";

import {
  DEFAULT_PRIORITY_POLICY,
  TRUSTED_METADATA_PREFIX,
  classifyObjective,
  compareScored,
  scoreObjective,
  stripUntrustedMetadata,
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
    const g = goal({ metadata: { "icos.source": "cognitive_conversation" } });
    expect(classifyObjective(DEFAULT_PRIORITY_POLICY, g)).toEqual({
      class: "USER",
      classSource: "rule",
    });
  });

  it("classifies a client-scoped goal as CLIENT", () => {
    const g = goal({ metadata: { "icos.clientId": "lds" } });
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
    const g = goal({ metadata: { "icos.clientId": "unknown-client" } });
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
      metadata: { "icos.source": "cognitive_conversation" },
      deadline: "2026-10-02T13:00:00.000Z",
      priority: 5,
    });
    const r = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    const bonus = r.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(r.priority).toBe(Math.round(DEFAULT_PRIORITY_POLICY.classBase[r.class] + bonus));
  });

  it("is deterministic", () => {
    const g = goal({ metadata: { "icos.clientId": "lds" }, deadline: "2026-10-03T00:00:00.000Z" });
    const a = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    const b = scoreObjective(DEFAULT_PRIORITY_POLICY, g, { now: NOW });
    expect(a).toEqual(b);
  });

  it("band spacing cannot be crossed by factors", () => {
    const best = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({
        id: "self",
        metadata: { "icos.source": "self_development", businessImpact: "1", expectedValue: "1" },
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
        metadata: { "icos.source": "cognitive_conversation" },
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
      goal({ id: "u", metadata: { "icos.source": "cognitive_conversation" } }),
      { now: NOW },
    );
    const self = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "s", metadata: { "icos.source": "self_development" } }),
      { now: NOW },
    );
    expect(user.priority).toBeGreaterThan(self.priority);
  });

  it("SUPERVISOR_CLIENT_OVER_SELF", () => {
    const client = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "c", metadata: { "icos.clientId": "lds" } }),
      { now: NOW },
    );
    const self = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "s", metadata: { "icos.source": "self_development" } }),
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
    const a = scored(goal({ id: "a", metadata: { "icos.source": "cognitive_conversation" } }));
    const b = scored(goal({ id: "b", metadata: { "icos.source": "self_development" } }));
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

describe("classification is server-asserted, never caller-asserted (review I2)", () => {
  it("ignores a caller-supplied `source`, which anyone posting a goal can set", () => {
    const g = goal({ metadata: { source: "cognitive_conversation" } });
    expect(classifyObjective(DEFAULT_PRIORITY_POLICY, g)).toEqual({
      class: "RESEARCH",
      classSource: "default",
    });
  });

  it("ignores a caller-supplied `clientId` and `domain`", () => {
    const spoofs: Record<string, string>[] = [
      { clientId: "lds" },
      { domain: "security" },
      { domain: "revenue" },
    ];
    for (const metadata of spoofs) {
      expect(classifyObjective(DEFAULT_PRIORITY_POLICY, goal({ metadata })).class).toBe("RESEARCH");
    }
  });

  it("honours the reserved, server-written namespace", () => {
    expect(
      classifyObjective(
        DEFAULT_PRIORITY_POLICY,
        goal({ metadata: { "icos.source": "cognitive_conversation" } }),
      ),
    ).toEqual({ class: "USER", classSource: "rule" });
    expect(
      classifyObjective(DEFAULT_PRIORITY_POLICY, goal({ metadata: { "icos.clientId": "lds" } }))
        .class,
    ).toBe("CLIENT");
  });

  it("every classification key lives under the reserved prefix", () => {
    for (const rule of DEFAULT_PRIORITY_POLICY.classification) {
      expect(rule.when.metadataKey.startsWith(TRUSTED_METADATA_PREFIX)).toBe(true);
    }
  });

  it("stripUntrustedMetadata removes reserved keys a caller tried to set", () => {
    expect(
      stripUntrustedMetadata({
        "icos.source": "cognitive_conversation",
        "icos.clientId": "acme",
        note: "keep me",
      }),
    ).toEqual({ note: "keep me" });
  });

  it("a caller cannot buy a higher band by asserting one", () => {
    const asserted = scoreObjective(
      DEFAULT_PRIORITY_POLICY,
      goal({ id: "a", metadata: { source: "cognitive_conversation", domain: "security" } }),
      { now: NOW },
    );
    const plain = scoreObjective(DEFAULT_PRIORITY_POLICY, goal({ id: "b" }), { now: NOW });
    expect(asserted.priority).toBe(plain.priority);
  });

  it("clientImportance reads the reserved client key, not the caller's", () => {
    const policy = { ...DEFAULT_PRIORITY_POLICY, clientWeights: { lds: 1 } };
    const spoofed = scoreObjective(policy, goal({ metadata: { clientId: "lds" } }), { now: NOW });
    expect(spoofed.missing).toContain("clientImportance");

    const real = scoreObjective(policy, goal({ metadata: { "icos.clientId": "lds" } }), {
      now: NOW,
    });
    expect(real.factors.find((f) => f.name === "clientImportance")).toBeDefined();
  });
});
