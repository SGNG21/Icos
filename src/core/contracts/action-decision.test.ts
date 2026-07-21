import { describe, expect, it } from "vitest";

import { actionDecisionCommandSchema } from "./action-decision";

describe("actionDecisionCommandSchema", () => {
  it("accepte une approbation sans motif", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decidedByLabel: "Opérateur",
      decision: "approved",
    });
    expect(result.success).toBe(true);
  });

  it("rejette un rejet sans motif", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decidedByLabel: "Opérateur",
      decision: "rejected",
    });
    expect(result.success).toBe(false);
  });

  it("rejette un rejet dont le motif est vide ou uniquement des espaces", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decidedByLabel: "Opérateur",
      decision: "rejected",
      reason: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("accepte un rejet avec motif", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decidedByLabel: "Opérateur",
      decision: "rejected",
      reason: "hors périmètre",
    });
    expect(result.success).toBe(true);
  });

  it("rejette tout champ superflu injecté (agent, niveau)", () => {
    const result = actionDecisionCommandSchema.safeParse({
      decidedByLabel: "Opérateur",
      decision: "approved",
      agent: { id: "agent-ceo", authorizationLevel: 3 },
      authorizationLevel: 3,
    });
    expect(result.success).toBe(false);
  });
});
