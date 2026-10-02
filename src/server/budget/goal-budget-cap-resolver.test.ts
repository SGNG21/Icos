import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { MICROS_PER_EUR, type Attribution } from "@/core/budget/contracts";
import { decide, emptyWindow } from "@/core/budget/spend";

import { createGoalBudgetCapResolver, GOAL_BUDGET_UNITS_PER_EUR } from "./goal-budget-cap-resolver";
import { PostgresSpendLedger, type SqlExec } from "./postgres-spend-ledger";

/**
 * Le test phare du lot : `goals.budget` est NULLABLE, sans unité déclarée et sans colonne de
 * tokens compagnon. Un NULL ne doit devenir NI « sans plafond » NI 0, et un plafond de tokens
 * doit rester exprimable puisque la table de prix est vide.
 */

const dialect = new PgDialect();
const G1: Attribution = { goalId: "g1" };

/** Faux `execute` : rend des lignes figées et garde les paramètres reçus. */
class FakeGoalsDb implements SqlExec {
  readonly params: unknown[][] = [];
  constructor(
    private readonly rows: Record<string, unknown>[],
    private readonly fail?: Error,
  ) {}
  async execute(query: SQL): Promise<unknown> {
    this.params.push(dialect.sqlToQuery(query).params);
    if (this.fail) throw this.fail;
    return this.rows;
  }
}

const resolve = async (
  rows: Record<string, unknown>[],
  attribution: Attribution | null = G1,
  maxTotalTokensPerGoal?: number,
) => {
  const db = new FakeGoalsDb(rows);
  const cap = await createGoalBudgetCapResolver(
    maxTotalTokensPerGoal === undefined ? { db } : { db, maxTotalTokensPerGoal },
  )(attribution);
  return { cap, db };
};

describe("createGoalBudgetCapResolver — un budget NULL n'est ni sans plafond ni zéro", () => {
  it("ne rend JAMAIS UNCAPPED pour un budget NULL", async () => {
    const { cap } = await resolve([{ budget: null }]);
    expect(cap.kind).toBe("CAPPED");
    expect(cap.kind === "CAPPED" && cap.maxCostMicros).toBeUndefined();
    /* Ni 0, ni null, ni undefined déguisé en plafond. */
    expect(cap).toEqual({ kind: "CAPPED" });
  });

  it("un budget NULL sans plafond de tokens configuré REFUSE tout appel", async () => {
    const { cap } = await resolve([{ budget: null }]);
    expect(decide(emptyWindow(), cap)).toMatchObject({
      kind: "DENY",
      reason: "NO_ENFORCEABLE_CAP",
    });
  });

  it("un budget NULL reste gouverné par le plafond de TOKENS du propriétaire", async () => {
    const { cap } = await resolve([{ budget: null }], G1, 5_000);
    expect(cap).toEqual({ kind: "CAPPED", maxTotalTokens: 5_000 });
    expect(decide(emptyWindow(), cap)).toEqual({ kind: "ALLOW" });
  });
});

describe("createGoalBudgetCapResolver — l'unité est une hypothèse à source unique", () => {
  it("convertit via la seule constante d'unité", async () => {
    const { cap } = await resolve([{ budget: 12.5 }]);
    expect(cap).toEqual({
      kind: "CAPPED",
      maxCostMicros: (12.5 / GOAL_BUDGET_UNITS_PER_EUR) * MICROS_PER_EUR,
    });
  });

  it("lit une valeur rendue en texte par le pilote sans la perdre", async () => {
    const { cap } = await resolve([{ budget: "12.5" }]);
    expect(cap).toMatchObject({
      maxCostMicros: (12.5 / GOAL_BUDGET_UNITS_PER_EUR) * MICROS_PER_EUR,
    });
  });

  it("l'hypothèse d'unité est documentée et vaut 1 (EUR) aujourd'hui", () => {
    expect(GOAL_BUDGET_UNITS_PER_EUR).toBe(1);
  });

  it("ne rend JAMAIS un plafond monétaire flottant : c'est un ENTIER de micro-euros", async () => {
    /* P0-C : la frontière des unités est ici, et elle ne laisse passer que des entiers. */
    for (const budget of [12.5, 0.000_001, 1e6, "3.33"]) {
      const { cap } = await resolve([{ budget }]);
      if (cap.kind !== "CAPPED" || cap.maxCostMicros === undefined)
        throw new Error("attendu CAPPED");
      expect(Number.isInteger(cap.maxCostMicros)).toBe(true);
      expect(cap).not.toHaveProperty("maxAmount");
    }
  });

  it("un budget plus petit qu'un micro-euro REFUSE au lieu de s'arrondir à zéro", async () => {
    const { cap } = await resolve([{ budget: 1e-9 }], G1, 5_000);
    expect(cap).toMatchObject({ maxCostMicros: 0 });
    expect(decide(emptyWindow(), cap)).toMatchObject({ kind: "DENY", reason: "INVALID_CAP" });
  });
});

describe("createGoalBudgetCapResolver — fermé par défaut", () => {
  it("une imputation sans goal ne consulte pas la base et REFUSE", async () => {
    for (const attribution of [null, {}, { missionId: "m1" }, { goalId: "   " }]) {
      const { cap, db } = await resolve([{ budget: 10 }], attribution);
      expect(cap).toEqual({ kind: "CAPPED" });
      expect(db.params).toEqual([]);
      expect(decide(emptyWindow(), cap)).toMatchObject({ reason: "NO_ENFORCEABLE_CAP" });
    }
  });

  it("un goal inconnu REFUSE au lieu d'être supposé sans plafond", async () => {
    const { cap, db } = await resolve([], G1, 5_000);
    expect(cap).toEqual({ kind: "CAPPED" });
    expect(db.params).toEqual([["g1"]]);
    expect(decide(emptyWindow(), cap)).toMatchObject({ reason: "NO_ENFORCEABLE_CAP" });
  });

  it("un budget 0 persisté REFUSE, il n'est pas « corrigé » en absence de plafond", async () => {
    const { cap } = await resolve([{ budget: 0 }], G1, 5_000);
    expect(cap).toMatchObject({ maxCostMicros: 0 });
    expect(decide(emptyWindow(), cap)).toMatchObject({ kind: "DENY", reason: "INVALID_CAP" });
  });

  it("un budget négatif ou non fini REFUSE", async () => {
    for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { cap } = await resolve([{ budget }]);
      expect(decide(emptyWindow(), cap)).toMatchObject({ kind: "DENY", reason: "INVALID_CAP" });
    }
  });

  it("une base en erreur rejette, et le journal transforme ce rejet en REFUS", async () => {
    const db = new FakeGoalsDb([], new Error("goals indisponible"));
    await expect(createGoalBudgetCapResolver({ db })(G1)).rejects.toThrow("goals indisponible");

    /* Composé avec le journal : un plafond non résolu est un refus, jamais une autorisation. */
    const ledger = new PostgresSpendLedger({
      db: { execute: async () => [] },
      tenantId: "default",
      caps: createGoalBudgetCapResolver({ db }),
      priceTable: {},
    });
    expect(await ledger.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "NO_ENFORCEABLE_CAP",
    });
  });
});

describe("createGoalBudgetCapResolver — seul un plafond de tokens est applicable aujourd'hui", () => {
  const entry = (tokens: number) => ({
    modelId: "omniroute/unknown",
    usage: {
      kind: "METERED" as const,
      usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
    },
    attribution: G1,
    at: "2026-10-02T00:00:00.000Z",
  });

  /** Journal minimal en tableau : ce test porte sur le plafond, pas sur le SQL. */
  const ledgerOver = (rows: Record<string, unknown>[], goals: FakeGoalsDb, tokens?: number) =>
    new PostgresSpendLedger({
      db: {
        execute: async (query: SQL) => {
          const { sql: text, params } = dialect.sqlToQuery(query);
          if (/^\s*insert/i.test(text)) {
            const columns = /\(([^)]*)\)\s*values/i.exec(text)?.[1] ?? "";
            const row: Record<string, unknown> = {};
            columns.split(",").forEach((n, i) => (row[n.trim()] = params[i] ?? null));
            rows.push(row);
            return [];
          }
          return rows;
        },
      },
      tenantId: "default",
      caps: createGoalBudgetCapResolver(
        tokens === undefined ? { db: goals } : { db: goals, maxTotalTokensPerGoal: tokens },
      ),
      /* L'état réel du système : aucun prix connu. */
      priceTable: {},
    });

  it("un plafond MONÉTAIRE seul est insatisfiable : le premier appel chiffre UNPRICED", async () => {
    const goals = new FakeGoalsDb([{ budget: 100 }]);
    const ledger = ledgerOver([], goals);
    expect(await ledger.checkBudget(G1)).toEqual({ kind: "ALLOW" });
    await ledger.record(entry(10));
    expect(await ledger.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
  });

  it("un plafond de TOKENS, lui, s'applique vraiment et finit par arrêter la dépense", async () => {
    const goals = new FakeGoalsDb([{ budget: null }]);
    const ledger = ledgerOver([], goals, 1_000);
    await ledger.record(entry(600));
    expect(await ledger.checkBudget(G1)).toEqual({ kind: "ALLOW" });
    await ledger.record(entry(600));
    expect(await ledger.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "TOKEN_CAP_REACHED",
    });
  });
});
