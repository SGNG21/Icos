import { describe, expect, it } from "vitest";

import type { Agent, AgentAction, AuthorizationLevel, RiskLevel } from "@/core/contracts";

import { decideExecution } from "./decide";

function makeAgent(authorizationLevel: AuthorizationLevel): Agent {
  return {
    id: "agent-test",
    name: "Agent de test",
    role: "Test",
    status: "available",
    authorizationLevel,
    description: "Agent utilisé par les tests.",
  };
}

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    id: "action-001",
    initiatedByAgentId: "agent-test",
    kind: "repository.read",
    risk: "read_only",
    requiresHumanApproval: false,
    approvalStatus: "not_required",
    requestedAt: "2026-07-21T08:00:00.000Z",
    ...overrides,
  };
}

describe("mapping niveaux d'autorisation × risques", () => {
  const cases: Array<{
    risk: RiskLevel;
    level: AuthorizationLevel;
    expected: "allowed" | "awaiting_approval" | "refused";
  }> = [
    { risk: "read_only", level: 0, expected: "allowed" },
    { risk: "read_only", level: 1, expected: "allowed" },
    { risk: "read_only", level: 2, expected: "allowed" },
    { risk: "read_only", level: 3, expected: "allowed" },
    { risk: "reversible", level: 0, expected: "refused" },
    { risk: "reversible", level: 1, expected: "refused" },
    { risk: "reversible", level: 2, expected: "allowed" },
    { risk: "reversible", level: 3, expected: "allowed" },
    { risk: "sensitive", level: 0, expected: "refused" },
    { risk: "sensitive", level: 1, expected: "refused" },
    { risk: "sensitive", level: 2, expected: "awaiting_approval" },
    { risk: "sensitive", level: 3, expected: "awaiting_approval" },
  ];

  for (const { risk, level, expected } of cases) {
    it(`risque ${risk} × niveau ${level} → ${expected}`, () => {
      const decision = decideExecution(makeAction({ risk }), makeAgent(level));
      expect(decision.outcome).toBe(expected);
    });
  }

  it("refuse par insuffisance avec la raison typée", () => {
    expect(decideExecution(makeAction({ risk: "reversible" }), makeAgent(1))).toEqual({
      outcome: "refused",
      reason: "insufficient_authorization",
    });
  });
});

describe("actions sensibles", () => {
  it("met en attente une action sensible sans approbation", () => {
    const decision = decideExecution(
      makeAction({ risk: "sensitive", requiresHumanApproval: true, approvalStatus: "pending" }),
      makeAgent(3),
    );
    expect(decision).toEqual({ outcome: "awaiting_approval", reason: "approval_required" });
  });

  it("autorise une action sensible approuvée", () => {
    const decision = decideExecution(
      makeAction({ risk: "sensitive", requiresHumanApproval: true, approvalStatus: "approved" }),
      makeAgent(2),
    );
    expect(decision).toEqual({ outcome: "allowed", reason: "authorized" });
  });

  it("exige l'approbation même si l'action déclare requiresHumanApproval: false", () => {
    const decision = decideExecution(
      makeAction({
        risk: "sensitive",
        requiresHumanApproval: false,
        approvalStatus: "not_required",
      }),
      makeAgent(3),
    );
    expect(decision).toEqual({ outcome: "awaiting_approval", reason: "approval_required" });
  });

  it("le niveau maximal ne contourne jamais l'approbation", () => {
    const decision = decideExecution(
      makeAction({ risk: "sensitive", requiresHumanApproval: false, approvalStatus: "pending" }),
      makeAgent(3),
    );
    expect(decision.outcome).toBe("awaiting_approval");
  });
});

describe("rejet explicite", () => {
  it("est prioritaire et définitif quel que soit le risque ou le niveau", () => {
    for (const risk of ["read_only", "reversible", "sensitive"] as const) {
      const decision = decideExecution(
        makeAction({ risk, approvalStatus: "rejected" }),
        makeAgent(3),
      );
      expect(decision).toEqual({ outcome: "refused", reason: "approval_rejected" });
    }
  });
});

describe("exigence supplémentaire requiresHumanApproval", () => {
  it("impose l'approbation sur une action réversible", () => {
    const decision = decideExecution(
      makeAction({
        risk: "reversible",
        requiresHumanApproval: true,
        approvalStatus: "not_required",
      }),
      makeAgent(2),
    );
    expect(decision).toEqual({ outcome: "awaiting_approval", reason: "approval_required" });
  });
});
