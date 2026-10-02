import { describe, expect, it } from "vitest";

import { BUDGET_CURRENCY, UNPRICED, type TokenUsage } from "./contracts";
import { ICOS_PRICE_TABLE, priceUsage, type PriceEntry } from "./price-table";

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

  it("ne propage jamais NaN dans un coût", () => {
    const table = { "test/model": entry() };
    const outcome = priceUsage(table, "test/model", usage(123, 456));
    if (outcome.kind !== "COST") throw new Error("attendu COST");
    expect(Number.isFinite(outcome.amount)).toBe(true);
  });
});
