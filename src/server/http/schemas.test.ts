import { describe, expect, it } from "vitest";

import { createTaskBodySchema, transitionBodySchema } from "./schemas";

describe("createTaskBodySchema", () => {
  it("normalise le titre avec trim", () => {
    const result = createTaskBodySchema.safeParse({ title: "  Nouvelle tâche  " });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Nouvelle tâche");
    }
  });

  it("rejette un titre vide ou uniquement composé d'espaces", () => {
    expect(createTaskBodySchema.safeParse({ title: "" }).success).toBe(false);
    expect(createTaskBodySchema.safeParse({ title: "   " }).success).toBe(false);
  });

  it("rejette tout champ superflu", () => {
    const result = createTaskBodySchema.safeParse({ title: "Ok", surprise: true });
    expect(result.success).toBe(false);
  });
});

describe("transitionBodySchema", () => {
  it("accepte un statut cible connu", () => {
    expect(transitionBodySchema.safeParse({ to: "running" }).success).toBe(true);
  });

  it("rejette un statut cible inconnu", () => {
    expect(transitionBodySchema.safeParse({ to: "paused" }).success).toBe(false);
  });
});
