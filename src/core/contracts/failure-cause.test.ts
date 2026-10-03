import { describe, expect, it } from "vitest";

import {
  categoryOf,
  describeFailure,
  failureCauseOf,
  rootCauseOf,
  ROOT_CAUSES,
  type RootCause,
} from "./failure-cause";

/**
 * LA CAUSE RACINE NE DOIT PAS ÊTRE REPLIÉE EN `PROVIDER_FAILURE`.
 *
 * Mesuré avant d'être corrigé : une relecture refusée par le budget remontait comme « échec
 * du fournisseur », et la vraie cause (`BUDGET_DENIED:NO_ENFORCEABLE_CAP`) n'était visible
 * qu'en ajoutant un log temporaire. Un opérateur serait allé inspecter OmniRoute alors que
 * le problème était une variable de configuration. Ces preuves verrouillent la distinction.
 */

describe("rootCauseOf — cinq causes qui appellent cinq actions différentes", () => {
  it("un refus de budget n'est JAMAIS un échec de fournisseur", () => {
    const cases: ReadonlyArray<readonly [string, RootCause]> = [
      ["BUDGET_DENIED:NO_ENFORCEABLE_CAP plafond CAPPED sans rien", "NO_ENFORCEABLE_CAP"],
      ["BUDGET_DENIED:INVALID_CAP maxTotalTokens inexploitable", "NO_ENFORCEABLE_CAP"],
      ["BUDGET_DENIED:TOKEN_CAP_REACHED 1000 pour 1000", "BUDGET_EXHAUSTED"],
      ["BUDGET_DENIED:MONEY_CAP_REACHED", "BUDGET_EXHAUSTED"],
      ["BUDGET_DENIED:RESERVATION_EXCEEDS_CAP 2323 demandés", "BUDGET_EXHAUSTED"],
      ["BUDGET_DENIED:UNPRICED_RESERVATION", "UNPRICED_USAGE"],
      ["BUDGET_DENIED:UNMETERED_USAGE_IN_WINDOW", "UNPRICED_USAGE"],
      ["BUDGET_DENIED:UNBOUNDED_REQUEST corps illisible", "UNBOUNDED_REQUEST"],
      ["BUDGET_DENIED:RESERVATION_LEASE_LOST", "LEASE_LOST"],
    ];
    for (const [message, expected] of cases) {
      expect(rootCauseOf(new Error(message)), message).toBe(expected);
    }
  });

  it("distingue troncature, bail perdu, annulation, délai et configuration", () => {
    expect(rootCauseOf(new Error("ICOS_PLANNER_ERROR:OUTPUT_TRUNCATED"))).toBe("OUTPUT_TRUNCATED");
    expect(rootCauseOf(new Error("RESERVATION_LEASE_LOST"))).toBe("LEASE_LOST");
    expect(rootCauseOf(new Error("ICOS_REVIEWER_ERROR:ABORTED"))).toBe("CANCELLED");
    expect(rootCauseOf(new Error("ICOS_REVIEWER_ERROR:TIMEOUT"))).toBe("TIMEOUT");
    expect(rootCauseOf(new Error("CONFIGURATION_INCOMPLETE"))).toBe("CONFIGURATION_INCOMPLETE");
  });

  it("une cause INCONNUE est avouée, pas rangée de force ailleurs", () => {
    /*
     * `PROVIDER_FAILURE` reste le « je ne sais pas » honnête. Ce qui est interdit, c'est
     * qu'une cause CONNUE vienne s'y perdre — l'inverse resterait un mensonge utile.
     */
    expect(rootCauseOf(new Error("ECONNRESET"))).toBe("PROVIDER_FAILURE");
    expect(rootCauseOf(undefined)).toBe("PROVIDER_FAILURE");
    expect(rootCauseOf("quelque chose d'étrange")).toBe("PROVIDER_FAILURE");
  });

  it("une raison de refus inconnue ne devient pas un faux problème de budget", () => {
    expect(rootCauseOf(new Error("BUDGET_DENIED:UNE_RAISON_INEDITE"))).toBe("PROVIDER_FAILURE");
  });

  it("chaque cause racine a une catégorie, et une seule", () => {
    for (const cause of ROOT_CAUSES) expect(categoryOf(cause)).toBeTruthy();
    expect(categoryOf("NO_ENFORCEABLE_CAP")).toBe("BUDGET");
    expect(categoryOf("OUTPUT_TRUNCATED")).toBe("OUTPUT");
    expect(categoryOf("LEASE_LOST")).toBe("LIFECYCLE");
    expect(categoryOf("PROVIDER_FAILURE")).toBe("PROVIDER");
  });
});

describe("failureCauseOf — l'opérateur sait DE QUOI on parle", () => {
  it("porte catégorie, cause, fournisseur, modèle et identifiants", () => {
    const cause = failureCauseOf(new Error("BUDGET_DENIED:NO_ENFORCEABLE_CAP rien à appliquer"), {
      goalId: "g-1",
      missionId: "m-1",
      taskId: "t-1",
      reviewId: "r-1",
      provider: "omniroute",
      model: "reviewer-1",
    });
    expect(cause.category).toBe("BUDGET");
    expect(cause.rootCause).toBe("NO_ENFORCEABLE_CAP");
    const line = describeFailure(cause);
    for (const token of ["BUDGET", "NO_ENFORCEABLE_CAP", "g-1", "m-1", "t-1", "r-1", "omniroute"]) {
      expect(line, token).toContain(token);
    }
  });

  it("n'invente aucun identifiant qu'on ne lui a pas donné", () => {
    const line = describeFailure(failureCauseOf(new Error("boom")));
    expect(line).not.toMatch(/goalId=|missionId=|undefined/);
  });

  it("la ligne destinée à l'opérateur ne porte aucun secret", () => {
    /* Le détail vient d'un message de REFUS, jamais d'un corps de requête ou d'un en-tête. */
    const line = describeFailure(
      failureCauseOf(new Error("BUDGET_DENIED:TOKEN_CAP_REACHED 1000/1000"), {
        provider: "omniroute",
      }),
    );
    expect(line).not.toMatch(/sk-|Bearer|password|secret/i);
  });
});
