import { describe, expect, it } from "vitest";

import { UNKNOWN } from "@/core/supervisor/contracts";

import { classifyRawObjective } from "./objective-classification";

const KNOWN = { knownClients: ["LDS Renov"] };

describe("raw objective classification — work class", () => {
  it("classifies the owner's canonical sentence as SELF_IMPROVEMENT", () => {
    expect(classifyRawObjective("Améliore ICOS.").workClass).toBe("SELF_IMPROVEMENT");
  });

  it("classifies accent-stripped, lowercase and uppercase variants the same way", () => {
    for (const raw of [
      "améliore icos",
      "Ameliore ICOS",
      "AMÉLIORE ICOS",
      "ameliore   icos",
      "improve ICOS",
      "Optimize ICOS please",
      "self-improvement",
      "auto-amélioration",
    ]) {
      expect(classifyRawObjective(raw).workClass, raw).toBe("SELF_IMPROVEMENT");
    }
  });

  it("classifies the improvement verb after ICOS too", () => {
    expect(classifyRawObjective("ICOS doit s'améliorer en fiabilité.").workClass).toBe(
      "SELF_IMPROVEMENT",
    );
  });

  it("classifies a client audit as CLIENT when the client is known", () => {
    expect(
      classifyRawObjective("Audite LDS Renov et propose les actions prioritaires.", KNOWN)
        .workClass,
    ).toBe("CLIENT");
  });

  it("classifies on the explicit word client with no client list at all", () => {
    expect(classifyRawObjective("Prépare le rapport pour le client.").workClass).toBe("CLIENT");
  });

  /* FAIL CLOSED — the headline tests. */

  it("yields UNKNOWN for an unrelated sentence rather than guessing SELF_IMPROVEMENT", () => {
    for (const raw of [
      "Quelle heure est-il ?",
      "Commande des croissants pour demain.",
      "Audite LDS Renov et propose les actions prioritaires.", // no client list => not a client
      "Améliore le café de la cuisine.", // improvement, but not of ICOS
      "",
      "   ",
    ]) {
      expect(classifyRawObjective(raw).workClass, raw).toBe(UNKNOWN);
    }
  });

  it("yields UNKNOWN when self-improvement and client signals are both present", () => {
    const result = classifyRawObjective("Améliore ICOS et audite LDS Renov.", KNOWN);
    expect(result.workClass).toBe(UNKNOWN);
    expect(result.evidence.join(" ")).toContain("AMBIGUOUS");
  });
});

describe("raw objective classification — bounded parameters", () => {
  it("extracts an explicit duration in minutes", () => {
    expect(classifyRawObjective("Améliore ICOS pendant 2 heures.").durationMinutes).toBe(120);
    expect(classifyRawObjective("Améliore ICOS pendant 90 minutes.").durationMinutes).toBe(90);
    expect(classifyRawObjective("Improve ICOS for 1 day.").durationMinutes).toBe(1440);
  });

  it("leaves duration UNKNOWN when none is stated", () => {
    expect(classifyRawObjective("Améliore ICOS.").durationMinutes).toBe(UNKNOWN);
  });

  it("does not read a bare quantity as a duration", () => {
    expect(classifyRawObjective("Améliore ICOS. 2 heures de tests existent.").durationMinutes).toBe(
      UNKNOWN,
    );
  });

  it("extracts an explicit budget with its currency", () => {
    expect(classifyRawObjective("Améliore ICOS. Budget maximum 10 €.").budget).toEqual({
      amount: 10,
      currency: "EUR",
    });
    expect(classifyRawObjective("Améliore ICOS. Budget maximum de 10 EUR.").budget).toEqual({
      amount: 10,
      currency: "EUR",
    });
    expect(classifyRawObjective("Improve ICOS. Budget max $25.50.").budget).toEqual({
      amount: 25.5,
      currency: "USD",
    });
  });

  it("an ABSENT budget is an explicit unspecified state — never unlimited, never 0", () => {
    const result = classifyRawObjective("Améliore ICOS pendant 2 heures.");
    expect(result.budget).toBe(UNKNOWN);
    expect(result.budget).not.toBe(0);
    expect(result.budget).not.toBeNull();
    expect(result.budget).not.toBeUndefined();
    expect(result.evidence.join(" ")).toContain("budget not specified");
  });

  it("does not invent a budget from a money amount that is not a budget", () => {
    expect(classifyRawObjective("Améliore ICOS. La facture est de 10 EUR.").budget).toBe(UNKNOWN);
  });
});

describe("raw objective classification — prohibitions fail to the safe side", () => {
  it("requires deployment approval when the objective says so", () => {
    expect(
      classifyRawObjective("Améliore ICOS. Pas de déploiement sans mon accord.")
        .deploymentRequiresApproval,
    ).toBe(true);
  });

  it("requires deployment approval when the objective says NOTHING about it", () => {
    expect(classifyRawObjective("Améliore ICOS.").deploymentRequiresApproval).toBe(true);
  });

  it("drops the approval requirement only on explicit affirmative permission", () => {
    expect(
      classifyRawObjective("Améliore ICOS. Déploiement autorisé.").deploymentRequiresApproval,
    ).toBe(false);
    expect(classifyRawObjective("Improve ICOS. You may deploy.").deploymentRequiresApproval).toBe(
      false,
    );
  });

  it("keeps the requirement when permission and prohibition are both present", () => {
    expect(
      classifyRawObjective("Améliore ICOS. Déploiement autorisé, mais pas de déploiement en prod.")
        .deploymentRequiresApproval,
    ).toBe(true);
  });

  it("flags the escalation kinds the objective touches", () => {
    expect(classifyRawObjective("Améliore ICOS et déploie en production.").escalations).toContain(
      "DEPLOYMENT",
    );
    expect(classifyRawObjective("Améliore ICOS avec une nouvelle API key.").escalations).toContain(
      "CREDENTIALS",
    );
    expect(
      classifyRawObjective("Améliore ICOS en désactivant les tests.").escalations,
    ).toContain("POLICY_DISABLING");
    expect(classifyRawObjective("Améliore ICOS.").escalations).toEqual([]);
  });
});

describe("raw objective classification — determinism", () => {
  it("returns the same result for the same input", () => {
    const raw = "Améliore ICOS pendant 2 heures. Budget maximum 10 EUR. Pas de déploiement.";
    expect(classifyRawObjective(raw, KNOWN)).toEqual(classifyRawObjective(raw, KNOWN));
  });
});
