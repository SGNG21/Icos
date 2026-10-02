import { describe, expect, it } from "vitest";

import {
  attributionKey,
  BUDGET_CURRENCY,
  DENY_REASONS,
  UNATTRIBUTED,
  UNMETERED,
  UNMETERED_REASONS,
  UNPRICED,
  type Attribution,
} from "./contracts";

describe("budget contracts", () => {
  it("expose des sentinelles distinctes et lisibles", () => {
    expect(UNMETERED).toBe("UNMETERED");
    expect(UNPRICED).toBe("UNPRICED");
    expect(UNATTRIBUTED).toBe("UNATTRIBUTED");
    expect(new Set([UNMETERED, UNPRICED, UNATTRIBUTED]).size).toBe(3);
  });

  it("déclare une seule devise", () => {
    expect(BUDGET_CURRENCY).toBe("EUR");
  });

  it("n'a aucun code de refus ni de non-mesure vide ou dupliqué", () => {
    for (const codes of [UNMETERED_REASONS, DENY_REASONS]) {
      expect(codes.length).toBeGreaterThan(0);
      expect(new Set(codes).size).toBe(codes.length);
      for (const code of codes) expect(code.trim()).toBe(code);
    }
  });

  it("ne confond jamais une absence d'attribution avec une attribution", () => {
    expect(attributionKey(null)).toBe("UNATTRIBUTED");
    expect(attributionKey({})).toBe("UNATTRIBUTED");
    expect(attributionKey({ missionId: "   " })).toBe("UNATTRIBUTED");
  });

  it("produit une clé stable et indépendante de l'ordre des champs", () => {
    const a: Attribution = { missionId: "m1", goalId: "g1", brainId: "b1" };
    const b: Attribution = { brainId: "b1", goalId: "g1", missionId: "m1" };
    expect(attributionKey(a)).toBe(attributionKey(b));
    expect(attributionKey({ missionId: "m1" })).not.toBe(attributionKey({ goalId: "m1" }));
  });

  it("ne laisse pas une valeur fuir d'un champ vers un autre", () => {
    // Sans séparateur échappé, {missionId:"a|b"} et {missionId:"a",goalId:"b"} collisionnent.
    expect(attributionKey({ missionId: "a|goal=b" })).not.toBe(
      attributionKey({ missionId: "a", goalId: "b" }),
    );
  });
});
