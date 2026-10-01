import { describe, expect, it } from "vitest";

import { actionDecisionCommandSchema } from "./action-decision";

describe("actionDecisionCommandSchema", () => {
  it("accepte une approbation sans motif", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decision: "approved",
    });
    expect(result.success).toBe(true);
  });

  it("rejette un rejet sans motif", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decision: "rejected",
    });
    expect(result.success).toBe(false);
  });

  it("rejette un rejet dont le motif est vide ou uniquement des espaces", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decision: "rejected",
      reason: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("accepte un rejet avec motif", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decision: "rejected",
      reason: "hors périmètre",
    });
    expect(result.success).toBe(true);
  });

  it("rejette tout champ superflu injecté (agent, niveau)", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decision: "approved",
      agent: { id: "agent-ceo", authorizationLevel: 3 },
      authorizationLevel: 3,
    });
    expect(result.success).toBe(false);
  });

  /** FORGED_DECIDER_REJECTED — the caller cannot name the decider at all. */
  it("rejette toute tentative de nommer le décideur dans le corps", () => {
    for (const forged of [
      { decidedByLabel: "Opérateur" },
      { decidedByLabel: "owner@icos.test" },
      { decidedBy: "human-2" },
      { decider: { kind: "human", id: "human-2" } },
      { actor: { kind: "human", id: "human-2" } },
      { userId: "human-2" },
    ]) {
      const result = actionDecisionCommandSchema.safeParse({ decision: "approved", ...forged });
      expect(result.success, JSON.stringify(forged)).toBe(false);
    }
  });
});
