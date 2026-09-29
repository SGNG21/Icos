import { describe, expect, it } from "vitest";
import {
  tokenize,
  scoreCandidate,
  selectContext,
  memoryExclusion,
  maxSensitivityFor,
  type ContextCandidate,
  type ContextStage,
  type SelectionPolicy,
} from "./context-selection";
import type {
  CognitiveScope,
  Epistemic,
  OriginTrust,
  Sensitivity,
  ContextItemKind,
} from "./contracts";

type Rec = Parameters<typeof memoryExclusion>[0];

describe("context-selection", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const DAY_MS = 86_400_000; // copied from context-selection.ts

  describe("tokenize", () => {
    it("should remove accents and stopwords", () => {
      expect(tokenize("L'éléphant mange des pommes.")).toEqual(
        new Set(["elephant", "mange", "pommes"]),
      );
    });

    it("should ignore words shorter than 3 chars", () => {
      expect(tokenize("a bc de")).toEqual(new Set());
    });

    it("should handle mixed language stopwords", () => {
      expect(tokenize("the les and des pour")).toEqual(new Set());
    });
  });

  describe("scoreCandidate", () => {
    const baseCandidate: ContextCandidate = {
      stage: "semantic" as ContextStage,
      kind: "memory" as ContextItemKind,
      ref: "ref1",
      text: "test content",
      anchored: false,
      entityIds: [],
      occurredAt: now.toISOString(),
      confidence: 0.8,
      epistemic: null as unknown as Epistemic,
      trust: "trusted" as OriginTrust,
    };

    it("should score zero for irrelevant candidate", () => {
      const query = new Set(["unrelated"]);
      const focusEntityIds = new Set<string>();
      const { score, relevant, reason } = scoreCandidate(baseCandidate, query, focusEntityIds, now);
      expect(relevant).toBe(false);
      expect(reason).toBe("none");
      // STAGE_WEIGHT.semantic (0.3) + 0.1*confidence (0.08) + 0.1*recency (0.1) = 0.48
      expect(score).toBeCloseTo(0.48, 4);
    });

    it("should increase score with keyword overlap", () => {
      const query = new Set(["test"]);
      const focusEntityIds = new Set<string>();
      const { score, relevant, reason } = scoreCandidate(baseCandidate, query, focusEntityIds, now);
      expect(relevant).toBe(true);
      expect(reason).toBe("keywords:1");
      // STAGE_WEIGHT.semantic (0.3) + 0.5*overlap (0.5) + 0.1*confidence (0.08) + 0.1*recency (0.1) = 0.98
      expect(score).toBeCloseTo(0.98, 4);
    });

    it("should add anchored bonus", () => {
      const query = new Set(["test"]);
      const candidate = { ...baseCandidate, anchored: true };
      const focusEntityIds = new Set<string>();
      const { score } = scoreCandidate(candidate, query, focusEntityIds, now);
      // 0.3 + 0.5 + 0.3 + 0.08 + 0.1 = 1.28
      expect(score).toBeCloseTo(1.28, 4);
    });

    it("should add entity hit bonus", () => {
      const query = new Set(["test"]);
      const candidate = {
        ...baseCandidate,
        entityIds: ["e1"] as readonly string[],
      };
      const focusEntityIds = new Set<string>(["e1"]);
      const { score } = scoreCandidate(candidate, query, focusEntityIds, now);
      // 0.3 + 0.5 + 0.2 + 0.08 + 0.1 = 1.18
      expect(score).toBeCloseTo(1.18, 4);
    });

    it("should apply recency decay", () => {
      const query = new Set(["test"]);
      const oldDate = new Date(now.getTime() - 60 * DAY_MS); // 60 days ago
      const candidate = {
        ...baseCandidate,
        occurredAt: oldDate.toISOString(),
      };
      const focusEntityIds = new Set<string>();
      const { score } = scoreCandidate(candidate, query, focusEntityIds, now);
      // recency = 0.5^(60/30) = 0.5^2 = 0.25 => 0.1*0.25 = 0.025
      // STAGE_WEIGHT.semantic (0.3) + 0.5*overlap (0.5) + 0.1*confidence (0.08) + 0.1*recency (0.025) = 0.905
      expect(score).toBeCloseTo(0.905, 4);
    });

    it("should add authority bonus for USER_ASSERTED and TOOL_CONFIRMED", () => {
      const query = new Set(["test"]);
      const focusEntityIds = new Set<string>();
      for (const epistemic of ["USER_ASSERTED", "TOOL_CONFIRMED"] as const) {
        const candidate = {
          ...baseCandidate,
          epistemic: epistemic as Epistemic,
        };
        const { score } = scoreCandidate(candidate, query, focusEntityIds, now);
        // 0.3 + 0.5 + 0.05 (authority) + 0.08 + 0.1 = 1.03
        expect(score).toBeCloseTo(1.03, 4);
      }
    });

    it("should break ties by ref ascending", () => {
      const query = new Set(["test"]);
      const focusEntityIds = new Set<string>();
      const candA = {
        ...baseCandidate,
        ref: "aaa",
        text: "test",
      };
      const candB = {
        ...baseCandidate,
        ref: "aab",
        text: "test",
      };
      const scoreA = scoreCandidate(candA, query, focusEntityIds, now).score;
      const scoreB = scoreCandidate(candB, query, focusEntityIds, now).score;
      expect(scoreA).toBe(scoreB);
      // In selectContext, tie-breaking by ref ascending means aaa before aab
    });
  });

  describe("selectContext", () => {
    it("should exclude irrelevant candidates", () => {
      const candidates: ContextCandidate[] = [
        {
          stage: "semantic",
          kind: "memory",
          ref: "ir1",
          text: "unrelated",
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
        {
          stage: "semantic",
          kind: "memory",
          ref: "rel1",
          text: "keyword present",
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
      ];
      const policy: SelectionPolicy = { tokenBudget: 1000, maxSensitivity: "normal" };
      const focusEntityIds = new Set<string>();
      const turnText = "keyword";
      const { items, excluded } = selectContext(candidates, turnText, focusEntityIds, policy, now);
      expect(items).toHaveLength(1);
      expect(items[0].ref).toBe("rel1");
      expect(excluded).toHaveLength(1);
      expect(excluded[0].ref).toBe("ir1");
      expect(excluded[0].reason).toBe("irrelevant");
    });

    it("should keep anchored candidate without keywords", () => {
      const candidates: ContextCandidate[] = [
        {
          stage: "semantic",
          kind: "memory",
          ref: "anchored1",
          text: "some text",
          anchored: true,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
      ];
      const policy: SelectionPolicy = { tokenBudget: 1000, maxSensitivity: "normal" };
      const focusEntityIds = new Set<string>();
      const turnText = "unrelated";
      const { items } = selectContext(candidates, turnText, focusEntityIds, policy, now);
      expect(items).toHaveLength(1);
      expect(items[0].ref).toBe("anchored1");
      expect(items[0].reason).toBe("scope"); // anchored gives scope reason
    });

    it("should be deterministic: same inputs twice => identical items order and scores", () => {
      const candidates: ContextCandidate[] = [
        {
          stage: "semantic",
          kind: "memory",
          ref: "b",
          text: "keyword",
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
        {
          stage: "semantic",
          kind: "memory",
          ref: "a",
          text: "keyword",
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
      ];
      const policy: SelectionPolicy = { tokenBudget: 1000, maxSensitivity: "normal" };
      const focusEntityIds = new Set<string>();
      const turnText = "keyword";
      const first = selectContext(candidates, turnText, focusEntityIds, policy, now);
      const second = selectContext(candidates, turnText, focusEntityIds, policy, now);
      expect(first.items.map((i) => i.ref)).toEqual(second.items.map((i) => i.ref));
      expect(first.items.map((i) => i.score)).toEqual(second.items.map((i) => i.score));
      // Because of tie-breaking by ref, we expect order a then b
      expect(first.items[0].ref).toBe("a");
      expect(first.items[1].ref).toBe("b");
    });

    it("should break ties by ref ascending", () => {
      const candidates: ContextCandidate[] = [
        {
          stage: "semantic",
          kind: "memory",
          ref: "z",
          text: "keyword",
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
        {
          stage: "semantic",
          kind: "memory",
          ref: "a",
          text: "keyword",
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
      ];
      const policy: SelectionPolicy = { tokenBudget: 1000, maxSensitivity: "normal" };
      const focusEntityIds = new Set<string>();
      const turnText = "keyword";
      const { items } = selectContext(candidates, turnText, focusEntityIds, policy, now);
      expect(items[0].ref).toBe("a");
      expect(items[1].ref).toBe("z");
    });

    it("should trim by token budget with reason budget", () => {
      // Using texts that will actually be considered relevant
      const candidates: ContextCandidate[] = [
        {
          stage: "semantic",
          kind: "memory",
          ref: "small",
          text: "keyword", // 7 chars -> 2 tokens (estimateTokens: ceil(7/4)=2)
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
        {
          stage: "semantic",
          kind: "memory",
          ref: "large",
          text: "keyword ".repeat(100), // many chars -> many tokens
          anchored: false,
          entityIds: [],
          occurredAt: now.toISOString(),
          confidence: 0.8,
          epistemic: null,
          trust: "trusted",
        },
      ];
      const policy: SelectionPolicy = { tokenBudget: 10, maxSensitivity: "normal" };
      const focusEntityIds = new Set<string>();
      const turnText = "keyword";
      const { items, excluded } = selectContext(candidates, turnText, focusEntityIds, policy, now);
      // small text token = 2, large text token = ceil(700/4)=175
      // budget 10: small fits, large does not
      expect(items).toHaveLength(1);
      expect(items[0].ref).toBe("small");
      expect(excluded).toHaveLength(1);
      expect(excluded[0].ref).toBe("large");
      expect(excluded[0].reason).toBe("budget");
    });
  });

  describe("memoryExclusion", () => {
    const scope: CognitiveScope = {
      tenantId: "t1",
      userId: "u1",
      clientId: "c1",
      projectId: "p1",
    };
    const maxSensitivity: Sensitivity = "normal";
    const testNow = now;

    it("should return tenant_scope when tenantId mismatch", () => {
      const record: Rec = {
        tenantId: "t2",
        clientId: null,
        projectId: null,
        ownerUserId: null,
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("tenant_scope");
    });

    it("should return client_scope when clientId mismatch", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: "c2",
        projectId: null,
        ownerUserId: null,
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("client_scope");
    });

    it("should return project_scope when projectId mismatch", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: "p2",
        ownerUserId: null,
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("project_scope");
    });

    it("should return user_scope when ownerUserId mismatch", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: null,
        ownerUserId: "u2",
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("user_scope");
    });

    it("should return inactive when status not active", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: null,
        ownerUserId: null,
        status: "superseded",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("inactive");
    });

    it("should return expired when expiresAt in past", () => {
      const past = new Date(testNow.getTime() - DAY_MS).toISOString();
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: null,
        ownerUserId: null,
        status: "active",
        sensitivity: "normal",
        expiresAt: past,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("expired");
    });

    it("should return expired when validUntil in past", () => {
      const past = new Date(testNow.getTime() - DAY_MS).toISOString();
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: null,
        ownerUserId: null,
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: past,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("expired");
    });

    it("should return sensitivity when record sensitivity exceeds max", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: null,
        ownerUserId: null,
        status: "active",
        sensitivity: "restricted",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBe("sensitivity");
    });

    it("should return null for in-scope active record", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: "c1",
        projectId: "p1",
        ownerUserId: "u1",
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBeNull();
    });

    it("should return null when clientId is null but scope.clientId is not null? Actually condition: if (r.clientId !== null && r.clientId !== scope.clientId) -> if null, skip. So null clientId passes.", () => {
      const record: Rec = {
        tenantId: "t1",
        clientId: null,
        projectId: "p1",
        ownerUserId: "u1",
        status: "active",
        sensitivity: "normal",
        expiresAt: null,
        validUntil: null,
      };
      // clientId null passes, projectId matches, ownerUserId matches -> null
      expect(memoryExclusion(record, scope, maxSensitivity, testNow)).toBeNull();
    });
  });

  describe("maxSensitivityFor", () => {
    it("should return normal for viewer role", () => {
      expect(maxSensitivityFor(["viewer"])).toBe("normal");
    });

    it("should return sensitive for operator role", () => {
      expect(maxSensitivityFor(["operator"])).toBe("sensitive");
    });

    it("should return sensitive for admin role", () => {
      expect(maxSensitivityFor(["admin"])).toBe("sensitive");
    });

    it("should return sensitive for owner role", () => {
      expect(maxSensitivityFor(["owner"])).toBe("sensitive");
    });

    it("should return normal if no matching roles", () => {
      expect(maxSensitivityFor(["guest"])).toBe("normal");
    });

    it("should return sensitive if any role matches", () => {
      expect(maxSensitivityFor(["guest", "operator"])).toBe("sensitive");
    });
  });
});
