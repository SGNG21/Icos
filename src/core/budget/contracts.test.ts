import { describe, expect, it } from "vitest";

import {
  attributionFromKey,
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

  it("UN SEUL budget pour tout l'arbre du goal : la clé est le goal SEUL", () => {
    // P0-B. Deux missions, deux brains, un même goal : une seule fenêtre, donc un seul budget.
    const goalOnly = attributionKey({ goalId: "g1" });
    expect(attributionKey({ goalId: "g1", missionId: "m1" })).toBe(goalOnly);
    expect(attributionKey({ goalId: "g1", missionId: "m2" })).toBe(goalOnly);
    expect(attributionKey({ goalId: "g1", missionId: "m2", brainId: "b9" })).toBe(goalOnly);
    expect(goalOnly).toBe("goal=g1");
  });

  it("retombe sur la mission puis le brain quand aucun goal n'est imputé", () => {
    expect(attributionKey({ missionId: "m1", brainId: "b1" })).toBe("mission=m1");
    expect(attributionKey({ brainId: "b1" })).toBe("brain=b1");
  });

  it("deux goals distincts ne partagent JAMAIS de fenêtre", () => {
    expect(attributionKey({ goalId: "g1" })).not.toBe(attributionKey({ goalId: "g2" }));
  });

  it("ne laisse pas une valeur fuir d'un champ vers un autre", () => {
    // Sans séparateur échappé, {missionId:"a|b"} et {missionId:"a",goalId:"b"} collisionnent.
    expect(attributionKey({ missionId: "a|goal=b" })).not.toBe(
      attributionKey({ missionId: "a", goalId: "b" }),
    );
  });

  it("attributionFromKey est l'INVERSE exact de attributionKey (verrou C2)", () => {
    /*
     * Le solde d'une réservation relit l'imputation depuis la CLÉ stockée sur la ligne : si
     * l'aller-retour n'était pas exact, la dépense tomberait dans une autre fenêtre que celle
     * qui a été réservée, et le plafond cesserait de s'appliquer sans que rien ne le dise.
     */
    for (const attribution of [
      { goalId: "g1" },
      { missionId: "m1" },
      { brainId: "b1" },
      { goalId: "g1", missionId: "m1", brainId: "b1" },
      { goalId: "avec espace et = et |" },
      { goalId: "goal=piège" },
    ] satisfies Attribution[]) {
      const key = attributionKey(attribution);
      expect(attributionKey(attributionFromKey(key))).toBe(key);
    }
  });

  it("ne reconstruit JAMAIS une imputation à partir d'une clé qu'on n'a pas écrite", () => {
    for (const key of ["UNATTRIBUTED", "", "=g1", "inconnu=g1", "goal=", "goal=%E0%A4%A", "goal"]) {
      expect(attributionFromKey(key), key).toBeNull();
    }
  });
});
