import { describe, expect, it } from "vitest";

import { BUDGET_CURRENCY, MICROS_PER_EUR, UNMETERED, UNPRICED, type BudgetCap } from "./contracts";
import {
  accumulate,
  decide,
  decideReservation,
  emptyWindow,
  settleReservation,
  type SpendObservation,
} from "./spend";

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

const usageOf = (prompt: number, completion: number) => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion,
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

describe("decide — argent en micro-euros ENTIERS (P0-C)", () => {
  it("applique un plafond exprimé en micros, sans aucun flottant de plafond", () => {
    const w = windowOf(metered(100, 100, 4));
    expect(decide(w, capped({ maxCostMicros: 10 * MICROS_PER_EUR }))).toEqual({ kind: "ALLOW" });
    expect(decide(w, capped({ maxCostMicros: 4 * MICROS_PER_EUR }))).toMatchObject({
      kind: "DENY",
      reason: "MONEY_CAP_REACHED",
    });
  });

  it("les deux orthographes décident à l'identique (l'ancienne est normalisée)", () => {
    const w = windowOf(metered(100, 100, 4));
    expect(decide(w, capped({ maxAmount: 10 }))).toEqual(
      decide(w, capped({ maxCostMicros: 10 * MICROS_PER_EUR })),
    );
    expect(decide(w, capped({ maxAmount: 4 }))).toEqual(
      decide(w, capped({ maxCostMicros: 4 * MICROS_PER_EUR })),
    );
  });

  it("refuse les deux orthographes à la fois plutôt que d'en deviner une", () => {
    expect(
      decide(emptyWindow(), capped({ maxAmount: 10, maxCostMicros: 20 * MICROS_PER_EUR })),
    ).toMatchObject({ kind: "DENY", reason: "AMBIGUOUS_MONEY_CAP" });
  });

  it("ARRONDIT LA DÉPENSE VERS LE HAUT : un arrondi ne peut pas cacher une dépense", () => {
    /* 0,0000005 EUR -> 1 micro, pas 0 : la fraction de micro n'est jamais blanchie. */
    const w = windowOf(metered(1, 1, 0.000_000_5));
    expect(decide(w, capped({ maxCostMicros: 1 }))).toMatchObject({
      kind: "DENY",
      reason: "MONEY_CAP_REACHED",
    });
  });

  it.each([
    ["nul", 0],
    ["négatif", -5],
    ["non entier", 1.5],
    ["non fini", Number.NaN],
  ])("refuse un plafond en micros %s", (_label, maxCostMicros) => {
    expect(decide(emptyWindow(), capped({ maxCostMicros }))).toMatchObject({
      kind: "DENY",
      reason: "INVALID_CAP",
    });
  });

  it("un budget en TOKENS SEULS reste pleinement applicable sans aucun prix", () => {
    /* Le prix en euros n'est pas un prérequis de l'autonomie. */
    expect(decide(windowOf(metered(10, 10)), capped({ maxTotalTokens: 1_000 }))).toEqual({
      kind: "ALLOW",
    });
  });
});

describe("decideReservation — réservation AVANT dispatch (P0-D)", () => {
  const TOKENS = capped({ maxTotalTokens: 1_000 });

  it("autorise une réservation qui tient dans le reste", () => {
    expect(decideReservation(windowOf(metered(400, 0)), 100, 400, TOKENS)).toEqual({
      kind: "ALLOW",
    });
  });

  it("autorise une réservation qui remplit EXACTEMENT le plafond", () => {
    expect(decideReservation(emptyWindow(), 0, 1_000, TOKENS)).toEqual({ kind: "ALLOW" });
  });

  it("compte les réservations VIVANTES des autres appelants, pas seulement le dépensé", () => {
    /* 400 dépensés + 500 déjà réservés ailleurs + 200 demandés = 1100 > 1000. */
    expect(decideReservation(windowOf(metered(400, 0)), 500, 200, TOKENS)).toMatchObject({
      kind: "DENY",
      reason: "RESERVATION_EXCEEDS_CAP",
    });
    /* Sans la prise en compte des réservations, les 200 passeraient : c'est le défaut P0-D. */
    expect(decideReservation(windowOf(metered(400, 0)), 0, 200, TOKENS)).toEqual({ kind: "ALLOW" });
  });

  it("REFUSE au lieu de rogner : rien ne part avec un montant réduit en silence", () => {
    const d = decideReservation(emptyWindow(), 0, 1_001, TOKENS);
    if (d.kind !== "DENY") throw new Error("attendu DENY");
    expect(d.reason).toBe("RESERVATION_EXCEEDS_CAP");
    expect(d.detail).toContain("1001");
  });

  it.each([
    ["nul", 0],
    ["négatif", -1],
    ["non entier", 10.5],
    ["non fini", Number.POSITIVE_INFINITY],
  ])("refuse un montant demandé %s", (_label, requested) => {
    expect(decideReservation(emptyWindow(), 0, requested, TOKENS)).toMatchObject({
      kind: "DENY",
      reason: "INVALID_RESERVATION",
    });
  });

  it("refuse un total de réservations déjà inexploitable", () => {
    expect(decideReservation(emptyWindow(), Number.NaN, 10, TOKENS)).toMatchObject({
      kind: "DENY",
      reason: "UNUSABLE_WINDOW",
    });
  });

  it("hérite de TOUTES les fermetures du pré-vol (non mesuré, saturé, plafond invalide)", () => {
    expect(decideReservation(windowOf(unmeteredCall), 0, 1, TOKENS)).toMatchObject({
      kind: "DENY",
      reason: "UNMETERED_USAGE_IN_WINDOW",
    });
    expect(decideReservation({ ...emptyWindow(), saturated: true }, 0, 1, TOKENS)).toMatchObject({
      kind: "DENY",
      reason: "UNUSABLE_WINDOW",
    });
    expect(decideReservation(emptyWindow(), 0, 1, capped({}))).toMatchObject({
      kind: "DENY",
      reason: "NO_ENFORCEABLE_CAP",
    });
  });

  it("FERME un plafond MONÉTAIRE dont le prix est inconnu : jamais un prix inventé", () => {
    expect(
      decideReservation(emptyWindow(), 0, 100, capped({ maxCostMicros: 10 * MICROS_PER_EUR })),
    ).toMatchObject({ kind: "DENY", reason: "UNPRICED_RESERVATION" });
  });

  it("UNCAPPED reste UNCAPPED : une réservation valide passe", () => {
    expect(decideReservation(emptyWindow(), 0, 10, { kind: "UNCAPPED" })).toEqual({
      kind: "ALLOW",
    });
    /* Mais un montant absurde reste un montant absurde, même sans plafond. */
    expect(decideReservation(emptyWindow(), 0, 0, { kind: "UNCAPPED" })).toMatchObject({
      kind: "DENY",
      reason: "INVALID_RESERVATION",
    });
  });
});

describe("settleReservation — solde sur la consommation RÉELLE", () => {
  it("rend le reliquat non consommé", () => {
    expect(settleReservation(1_000, { kind: "METERED", usage: usageOf(300, 200) })).toEqual({
      reservedTokens: 1_000,
      actualTokens: 500,
      releasedTokens: 500,
      overrunTokens: 0,
    });
  });

  it("DIT le dépassement au lieu de le cacher", () => {
    expect(settleReservation(100, { kind: "METERED", usage: usageOf(300, 200) })).toEqual({
      reservedTokens: 100,
      actualTokens: 500,
      releasedTokens: 0,
      overrunTokens: 400,
    });
  });

  it("une consommation NON MESURÉE ne libère RIEN : l'absence n'est pas un zéro", () => {
    expect(settleReservation(1_000, { kind: UNMETERED, reason: "USAGE_ABSENT" })).toEqual({
      reservedTokens: 1_000,
      actualTokens: null,
      releasedTokens: 0,
      overrunTokens: 0,
    });
  });
});
