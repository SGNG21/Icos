import { describe, expect, it } from "vitest";

import { UNMETERED, type Attribution, type BudgetCap } from "@/core/budget/contracts";
import type { PriceEntry, PriceTable } from "@/core/budget/price-table";

import { InMemorySpendLedger } from "./in-memory-spend-ledger";

const PRICED: PriceEntry = {
  modelId: "test/model",
  currency: "EUR",
  promptPerMillion: 1,
  completionPerMillion: 1,
  provenance: "fixture de test",
  asOf: "2026-10-02",
};
const table: PriceTable = { "test/model": PRICED };

const entry = (
  modelId: string,
  prompt: number,
  completion: number,
  attribution: Attribution | null,
) => ({
  modelId,
  usage: {
    kind: "METERED" as const,
    usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
  },
  attribution,
  at: "2026-10-02T00:00:00.000Z",
});

const ledger = (cap: BudgetCap, priceTable: PriceTable = table) =>
  new InMemorySpendLedger({ caps: async () => cap, priceTable });

describe("InMemorySpendLedger", () => {
  it("part d'une fenêtre vide et autorise sous le plafond", async () => {
    const l = ledger({ kind: "CAPPED", maxAmount: 10 });
    expect((await l.windowFor(null)).calls).toBe(0);
    expect(await l.checkBudget(null)).toEqual({ kind: "ALLOW" });
  });

  it("accumule et refuse une fois le plafond monétaire atteint", async () => {
    const l = ledger({ kind: "CAPPED", maxAmount: 10 });
    await l.record(entry("test/model", 6_000_000, 0, { goalId: "g1" }));
    expect(await l.checkBudget({ goalId: "g1" })).toEqual({ kind: "ALLOW" });
    await l.record(entry("test/model", 4_000_000, 0, { goalId: "g1" }));
    expect(await l.checkBudget({ goalId: "g1" })).toMatchObject({
      kind: "DENY",
      reason: "MONEY_CAP_REACHED",
    });
  });

  it("isole les imputations : un goal ne consomme pas le budget d'un autre", async () => {
    const l = ledger({ kind: "CAPPED", maxTotalTokens: 100 });
    await l.record(entry("test/model", 200, 0, { goalId: "g1" }));
    expect(await l.checkBudget({ goalId: "g1" })).toMatchObject({ kind: "DENY" });
    expect(await l.checkBudget({ goalId: "g2" })).toEqual({ kind: "ALLOW" });
  });

  it("enregistre un appel sans attribution comme non attribué, sans en inventer une", async () => {
    const l = ledger({ kind: "UNCAPPED" });
    await l.record(entry("test/model", 10, 10, null));
    expect((await l.windowFor(null)).totalTokens).toBe(20);
    expect((await l.windowFor({}))?.totalTokens).toBe(20);
    expect((await l.windowFor({ goalId: "g1" })).totalTokens).toBe(0);
  });

  it("compte un modèle hors table comme UNPRICED et non comme gratuit", async () => {
    const l = ledger({ kind: "CAPPED", maxAmount: 10 }, {});
    await l.record(entry("inconnu/modele", 1_000, 1_000, { goalId: "g1" }));
    const w = await l.windowFor({ goalId: "g1" });
    expect(w.unpricedCalls).toBe(1);
    expect(w.amount).toBe(0);
    expect(w.totalTokens).toBe(2_000);
    expect(await l.checkBudget({ goalId: "g1" })).toMatchObject({
      kind: "DENY",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
  });

  it("applique un plafond de tokens malgré une table de prix vide", async () => {
    const l = ledger({ kind: "CAPPED", maxTotalTokens: 1_500 }, {});
    await l.record(entry("inconnu/modele", 1_000, 1_000, { goalId: "g1" }));
    expect(await l.checkBudget({ goalId: "g1" })).toMatchObject({
      kind: "DENY",
      reason: "TOKEN_CAP_REACHED",
    });
  });

  it("n'essaie pas de chiffrer un appel non mesuré", async () => {
    const l = ledger({ kind: "CAPPED", maxTotalTokens: 1_000_000 });
    await l.record({
      modelId: "test/model",
      usage: { kind: UNMETERED, reason: "NON_JSON_BODY" },
      attribution: { goalId: "g1" },
      at: "2026-10-02T00:00:00.000Z",
    });
    const w = await l.windowFor({ goalId: "g1" });
    expect(w.unmeteredCalls).toBe(1);
    expect(w.unpricedCalls).toBe(0);
    expect(w.amount).toBe(0);
    expect(await l.checkBudget({ goalId: "g1" })).toMatchObject({
      kind: "DENY",
      reason: "UNMETERED_USAGE_IN_WINDOW",
    });
  });

  it("refuse quand le résolveur de plafond échoue, au lieu d'autoriser", async () => {
    const l = new InMemorySpendLedger({
      caps: async () => {
        throw new Error("source de plafond indisponible");
      },
      priceTable: table,
    });
    const decision = await l.checkBudget({ goalId: "g1" });
    expect(decision).toMatchObject({ kind: "DENY", reason: "NO_ENFORCEABLE_CAP" });
  });

  it("expose les entrées enregistrées pour inspection, sans les modifier", async () => {
    const l = ledger({ kind: "UNCAPPED" });
    await l.record(entry("test/model", 1, 2, { missionId: "m1" }));
    expect(l.entries()).toHaveLength(1);
    expect(l.entries()[0]?.modelId).toBe("test/model");
  });
});
