import { describe, expect, it } from "vitest";

import {
  ICOS_PRICE_REGISTRY,
  MICROS_PER_UNIT,
  staleAfterFrom,
  type PriceRecord,
} from "@/core/pricing/registry";

import { BUDGET_CURRENCY, UNPRICED, type TokenUsage } from "./contracts";
import { ICOS_PRICE_TABLE, priceTableFrom, priceUsage, type PriceEntry } from "./price-table";

const usage = (prompt: number, completion: number, total?: number): TokenUsage => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: total ?? prompt + completion,
});

const entry = (overrides: Partial<PriceEntry> = {}): PriceEntry => ({
  modelId: "test/model",
  currency: BUDGET_CURRENCY,
  promptPerMillion: 3,
  completionPerMillion: 15,
  provenance: "test fixture",
  asOf: "2026-10-02",
  ...overrides,
});

describe("ICOS_PRICE_TABLE", () => {
  it("est vide par défaut : aucun prix n'est inventé", () => {
    // Inventer un prix pour un vrai modèle serait une fabrication. La table est remplie
    // à partir d'une facture ou d'une page de tarif, pas de mémoire.
    expect(Object.keys(ICOS_PRICE_TABLE)).toEqual([]);
  });

  it("rend UNPRICED pour n'importe quel modèle réel tant qu'elle est vide", () => {
    const outcome = priceUsage(ICOS_PRICE_TABLE, "auto/best-chat", usage(1000, 1000));
    expect(outcome.kind).toBe(UNPRICED);
  });

  it("est la PROJECTION du registre, pas une seconde liste à remplir à la main", () => {
    // Le point de dépôt du propriétaire est `ICOS_PRICE_REGISTRY`, dont le type exige
    // effectiveAt et staleAfter. Si la table était une littérale distincte, un vrai tarif
    // pourrait y être écrit sans aucune date et ne jamais périmer.
    expect(ICOS_PRICE_TABLE).toEqual(priceTableFrom(ICOS_PRICE_REGISTRY));
  });

  it("est gelée : on ne peut pas y glisser un tarif à l'exécution", () => {
    expect(() => {
      (ICOS_PRICE_TABLE as Record<string, unknown>)["auto/best-chat"] = entry();
    }).toThrow();
    expect(Object.keys(ICOS_PRICE_TABLE)).toEqual([]);
  });
});

describe("priceTableFrom", () => {
  const record = (overrides: Partial<PriceRecord> = {}): PriceRecord => ({
    provider: "test",
    modelId: "test/model",
    currency: BUDGET_CURRENCY,
    promptMicrosPerMillion: 3 * MICROS_PER_UNIT,
    completionMicrosPerMillion: 15 * MICROS_PER_UNIT,
    provenance: "fixture de test",
    effectiveAt: "2026-09-01T00:00:00.000Z",
    staleAfter: staleAfterFrom("2026-09-01T00:00:00.000Z"),
    ...overrides,
  });
  const NOW = new Date("2026-10-02T12:00:00.000Z");

  it("reporte la fraîcheur du registre dans la table : un tarif périmé rend UNPRICED", () => {
    const table = priceTableFrom([record()]);
    expect(priceUsage(table, "test/model", usage(1_000_000, 0), NOW)).toEqual({
      kind: "COST",
      currency: BUDGET_CURRENCY,
      amount: 3,
    });
    // Même entrée, 100 jours plus tard : au-delà de l'horizon de fraîcheur, donc inutilisable.
    const later = priceUsage(table, "test/model", usage(1_000_000, 0), new Date("2027-01-15"));
    expect(later.kind).toBe(UNPRICED);
  });

  it("ne projette AUCUN des deux tarifs concurrents d'un même modèle", () => {
    const table = priceTableFrom([record(), record({ provenance: "autre facture" })]);
    expect(Object.keys(table)).toEqual([]);
  });
});

describe("priceUsage", () => {
  it("chiffre au prix par million de tokens", () => {
    const table = { "test/model": entry() };
    // 1 000 000 prompt * 3/1e6 + 500 000 completion * 15/1e6 = 3 + 7.5
    expect(priceUsage(table, "test/model", usage(1_000_000, 500_000))).toEqual({
      kind: "COST",
      currency: BUDGET_CURRENCY,
      amount: 10.5,
    });
  });

  it("chiffre une consommation nulle à 0 — une mesure, pas une absence", () => {
    const table = { "test/model": entry() };
    expect(priceUsage(table, "test/model", usage(0, 0))).toEqual({
      kind: "COST",
      currency: BUDGET_CURRENCY,
      amount: 0,
    });
  });

  it("REFUSE de chiffrer quand le fournisseur facture plus que prompt+completion", () => {
    // Correction d'une assertion qui bénissait un défaut : chiffrer 1 000 000 de tokens sur
    // 2 000 000 facturés rendait `{COST, 3}` et `unpricedCalls: 0`, donc un plafond monétaire
    // déclaré satisfait sur un total sous-évalué de moitié. Faute de prix pour le reste,
    // le coût n'est pas prouvable : UNPRICED.
    const table = { "test/model": entry() };
    const withExtra = priceUsage(table, "test/model", usage(1_000_000, 0, 2_000_000));
    expect(withExtra.kind).toBe(UNPRICED);
  });

  it("rend UNPRICED sur une consommation de raisonnement réaliste", () => {
    // 1k prompt + 1k completion mais 60k tokens facturés : 58k tokens de raisonnement/cache
    // sans prix propre. Les chiffrer à 0 EUR sous-évaluerait le total d'un ordre de grandeur.
    const table = { "test/model": entry() };
    const outcome = priceUsage(table, "test/model", usage(1_000, 1_000, 60_000));
    expect(outcome.kind).toBe(UNPRICED);
    if (outcome.kind !== UNPRICED) throw new Error("attendu UNPRICED");
    expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it("n'exige pas de total_tokens déclaré pour chiffrer un appel ordinaire", () => {
    const table = { "test/model": entry() };
    expect(priceUsage(table, "test/model", usage(1_000_000, 0))).toEqual({
      kind: "COST",
      currency: BUDGET_CURRENCY,
      amount: 3,
    });
  });

  it("NE REND PAS GRATUIT un modèle dont la ligne de prix est un placeholder à 0", () => {
    // Une ligne remplie à 0 (placeholder, faute de frappe) rendait `{COST, 0}` : le modèle
    // devenait gratuit pour toujours et aucun plafond monétaire ne pouvait plus mordre.
    const placeholder = { "test/model": entry({ promptPerMillion: 0, completionPerMillion: 0 }) };
    const outcome = priceUsage(placeholder, "test/model", usage(1_000_000, 1_000_000));
    expect(outcome.kind).toBe(UNPRICED);
  });

  it.each([
    ["modèle absent", { "other/model": entry({ modelId: "other/model" }) }, "autre/modele"],
    ["modèle vide", { "test/model": entry() }, ""],
  ])("rend UNPRICED : %s", (_label, table, modelId) => {
    const outcome = priceUsage(table, modelId, usage(10, 10));
    expect(outcome.kind).toBe(UNPRICED);
    if (outcome.kind !== UNPRICED) throw new Error("attendu UNPRICED");
    expect(outcome.modelId).toBe(modelId);
    expect(outcome.reason.length).toBeGreaterThan(0);
  });

  it.each([
    ["prix négatif", entry({ promptPerMillion: -1 })],
    ["prix de prompt nul", entry({ promptPerMillion: 0 })],
    ["prix de complétion nul", entry({ completionPerMillion: 0 })],
    ["prix non fini", entry({ completionPerMillion: Number.NaN })],
    ["prix infini", entry({ promptPerMillion: Number.POSITIVE_INFINITY })],
    ["provenance vide", entry({ provenance: "  " })],
    ["asOf vide", entry({ asOf: "" })],
    ["identifiant incohérent", entry({ modelId: "pas-la-meme-cle" })],
  ])("refuse une entrée invalide plutôt que de l'appliquer : %s", (_label, bad) => {
    const outcome = priceUsage({ "test/model": bad }, "test/model", usage(10, 10));
    expect(outcome.kind).toBe(UNPRICED);
  });

  it("REFUSE un tarif déclaré périmé plutôt que de rendre un montant presque juste", () => {
    const stale = {
      "test/model": entry({
        effectiveAt: "2026-01-01T00:00:00.000Z",
        staleAfter: "2026-04-01T00:00:00.000Z",
      }),
    };
    const outcome = priceUsage(stale, "test/model", usage(1_000_000, 0), new Date("2026-10-02"));
    expect(outcome.kind).toBe(UNPRICED);
  });

  it("REFUSE un tarif dont la date de constat est dans le futur", () => {
    // Un prix « constaté » demain n'a pas été constaté : il a été anticipé.
    const future = { "test/model": entry({ asOf: "2099-01-01" }) };
    const outcome = priceUsage(future, "test/model", usage(1_000_000, 0), new Date("2026-10-02"));
    expect(outcome.kind).toBe(UNPRICED);
  });

  it("chiffre en micros ENTIERS : un tarif plus fin que le micro est refusé, pas arrondi", () => {
    // 0,0000005 EUR par million de tokens n'est pas représentable en micros. L'arrondir
    // silencieusement fabriquerait un tarif que personne n'a saisi.
    const subMicro = { "test/model": entry({ promptPerMillion: 0.0000005 }) };
    expect(priceUsage(subMicro, "test/model", usage(1_000_000, 0)).kind).toBe(UNPRICED);
    // 0,5 EUR/Mtok vaut 500 000 micros : représentable, donc appliqué.
    const halfUnit = { "test/model": entry({ promptPerMillion: 0.5, completionPerMillion: 0.5 }) };
    expect(priceUsage(halfUnit, "test/model", usage(1_000_000, 0))).toEqual({
      kind: "COST",
      currency: BUDGET_CURRENCY,
      amount: 0.5,
    });
  });

  it("ne propage jamais NaN dans un coût", () => {
    const table = { "test/model": entry() };
    const outcome = priceUsage(table, "test/model", usage(123, 456));
    if (outcome.kind !== "COST") throw new Error("attendu COST");
    expect(Number.isFinite(outcome.amount)).toBe(true);
  });
});
