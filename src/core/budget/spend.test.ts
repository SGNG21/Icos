import { describe, expect, it } from "vitest";

import { BUDGET_CURRENCY, UNMETERED, UNPRICED, type BudgetCap } from "./contracts";
import { accumulate, decide, emptyWindow, type SpendObservation } from "./spend";

const metered = (prompt: number, completion: number, amount?: number): SpendObservation => ({
  modelId: "test/model",
  usage: {
    kind: "METERED",
    usage: {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
    },
  },
  ...(amount === undefined
    ? { cost: { kind: UNPRICED, modelId: "test/model", reason: "table vide" } as const }
    : { cost: { kind: "COST", currency: BUDGET_CURRENCY, amount } as const }),
});

const unmeteredCall: SpendObservation = {
  modelId: "test/model",
  usage: { kind: UNMETERED, reason: "NON_JSON_BODY" },
};

const capped = (over: Partial<Extract<BudgetCap, { kind: "CAPPED" }>>): BudgetCap => ({
  kind: "CAPPED",
  ...over,
});

const windowOf = (...observations: SpendObservation[]) =>
  observations.reduce(accumulate, emptyWindow());

describe("emptyWindow / accumulate", () => {
  it("part d'une fenêtre vide explicite", () => {
    expect(emptyWindow()).toEqual({
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      currency: BUDGET_CURRENCY,
      amount: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      unmeteredCalls: 0,
      saturated: false,
    });
  });

  it("additionne les tokens et les coûts chiffrés", () => {
    const w = windowOf(metered(100, 50, 1.5), metered(10, 5, 0.25));
    expect(w.calls).toBe(2);
    expect(w.promptTokens).toBe(110);
    expect(w.completionTokens).toBe(55);
    expect(w.totalTokens).toBe(165);
    expect(w.amount).toBeCloseTo(1.75, 10);
    expect(w.pricedCalls).toBe(2);
    expect(w.unpricedCalls).toBe(0);
    expect(w.unmeteredCalls).toBe(0);
  });

  it("compte un appel non chiffré sans ajouter 0 EUR à l'addition", () => {
    const w = windowOf(metered(100, 50));
    expect(w.totalTokens).toBe(150);
    expect(w.amount).toBe(0);
    expect(w.unpricedCalls).toBe(1);
    expect(w.pricedCalls).toBe(0);
  });

  it("compte un appel non mesuré sans inventer de tokens", () => {
    const w = windowOf(unmeteredCall);
    expect(w.calls).toBe(1);
    expect(w.totalTokens).toBe(0);
    expect(w.unmeteredCalls).toBe(1);
  });

  it("NE BLANCHIT PAS une observation mesurée arrivée sans coût", () => {
    // Sans garde, les tokens s'accumulaient tandis que `amount`, `pricedCalls` et
    // `unpricedCalls` restaient intacts : la fenêtre paraissait propre et `decide` déclarait
    // n'importe quel maxAmount satisfait.
    const costless: SpendObservation = {
      modelId: "test/model",
      usage: {
        kind: "METERED",
        usage: { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 },
      },
    };

    const w = windowOf(costless);
    expect(w.totalTokens).toBe(2_000_000);
    expect(w.amount).toBe(0);
    expect(w.pricedCalls).toBe(0);
    expect(w.unpricedCalls).toBe(1);
    expect(decide(w, capped({ maxAmount: 10 }))).toMatchObject({
      kind: "DENY",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
  });

  it("ne mute pas la fenêtre d'entrée", () => {
    const before = emptyWindow();
    accumulate(before, metered(10, 10, 1));
    expect(before).toEqual(emptyWindow());
  });

  it("sature au lieu de déborder ou de produire NaN", () => {
    const huge: SpendObservation = {
      modelId: "test/model",
      usage: {
        kind: "METERED",
        usage: {
          promptTokens: Number.MAX_SAFE_INTEGER,
          completionTokens: Number.MAX_SAFE_INTEGER,
          totalTokens: Number.MAX_SAFE_INTEGER,
        },
      },
      cost: { kind: "COST", currency: BUDGET_CURRENCY, amount: Number.MAX_VALUE },
    };
    const w = windowOf(huge, huge);
    expect(w.saturated).toBe(true);
    expect(Number.isFinite(w.totalTokens)).toBe(true);
    expect(Number.isNaN(w.amount)).toBe(false);
  });

  it("refuse un coût non fini et le traite comme saturé", () => {
    const w = windowOf({
      modelId: "test/model",
      usage: { kind: "METERED", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      cost: { kind: "COST", currency: BUDGET_CURRENCY, amount: Number.NaN },
    });
    expect(w.saturated).toBe(true);
    expect(Number.isNaN(w.amount)).toBe(false);
  });
});

describe("decide", () => {
  it("autorise seulement si l'absence de plafond a été choisie explicitement", () => {
    expect(decide(windowOf(metered(10, 10)), { kind: "UNCAPPED" })).toEqual({ kind: "ALLOW" });
  });

  it("refuse un CAPPED sans aucun plafond : rien n'est applicable", () => {
    const d = decide(emptyWindow(), capped({}));
    expect(d).toMatchObject({ kind: "DENY", reason: "NO_ENFORCEABLE_CAP" });
  });

  it.each([
    ["plafond monétaire nul", capped({ maxAmount: 0 })],
    ["plafond monétaire négatif", capped({ maxAmount: -5 })],
    ["plafond monétaire non fini", capped({ maxAmount: Number.NaN })],
    ["plafond de tokens non entier", capped({ maxTotalTokens: 1.5 })],
    ["plafond de tokens nul", capped({ maxTotalTokens: 0 })],
  ])("refuse un plafond invalide : %s", (_label, cap) => {
    expect(decide(emptyWindow(), cap)).toMatchObject({ kind: "DENY", reason: "INVALID_CAP" });
  });

  it("autorise sous un plafond monétaire quand tout est chiffré", () => {
    expect(decide(windowOf(metered(100, 100, 4)), capped({ maxAmount: 10 }))).toEqual({
      kind: "ALLOW",
    });
  });

  it("refuse dès que le plafond monétaire est atteint, avant l'appel suivant", () => {
    expect(decide(windowOf(metered(100, 100, 10)), capped({ maxAmount: 10 }))).toMatchObject({
      kind: "DENY",
      reason: "MONEY_CAP_REACHED",
    });
  });

  it("NE LAISSE PAS un appel non chiffré passer pour satisfaisant un plafond monétaire", () => {
    // Le cas de blanchiment : 0 EUR comptabilisé, mais un appel dont le coût est inconnu.
    const w = windowOf(metered(1_000_000, 1_000_000));
    expect(w.amount).toBe(0);
    const d = decide(w, capped({ maxAmount: 10 }));
    expect(d).toMatchObject({ kind: "DENY", reason: "UNPRICED_USAGE_IN_WINDOW" });
    if (d.kind !== "DENY") throw new Error("attendu DENY");
    expect(d.detail).toContain("1");
  });

  it("applique un plafond de tokens sans aucune table de prix", () => {
    const w = windowOf(metered(600, 500));
    expect(decide(w, capped({ maxTotalTokens: 1000 }))).toMatchObject({
      kind: "DENY",
      reason: "TOKEN_CAP_REACHED",
    });
    expect(decide(windowOf(metered(100, 100)), capped({ maxTotalTokens: 1000 }))).toEqual({
      kind: "ALLOW",
    });
  });

  it("refuse quand un appel de la fenêtre n'a pas pu être mesuré", () => {
    for (const cap of [capped({ maxTotalTokens: 1_000_000 }), capped({ maxAmount: 1_000 })]) {
      expect(decide(windowOf(metered(1, 1, 0.01), unmeteredCall), cap)).toMatchObject({
        kind: "DENY",
        reason: "UNMETERED_USAGE_IN_WINDOW",
      });
    }
  });

  it("refuse une fenêtre saturée plutôt que de la comparer", () => {
    const saturated = { ...emptyWindow(), saturated: true };
    expect(decide(saturated, capped({ maxTotalTokens: 10 }))).toMatchObject({
      kind: "DENY",
      reason: "UNUSABLE_WINDOW",
    });
  });

  it("ignore un plafond saturé même en UNCAPPED : UNCAPPED reste UNCAPPED", () => {
    const saturated = { ...emptyWindow(), saturated: true };
    expect(decide(saturated, { kind: "UNCAPPED" })).toEqual({ kind: "ALLOW" });
  });

  it("porte toujours un motif typé et un détail non vide sur un refus", () => {
    const d = decide(windowOf(unmeteredCall), capped({ maxAmount: 1 }));
    if (d.kind !== "DENY") throw new Error("attendu DENY");
    expect(d.detail.trim().length).toBeGreaterThan(0);
  });
});
