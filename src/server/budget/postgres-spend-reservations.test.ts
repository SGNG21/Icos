import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { Attribution, BudgetCap } from "@/core/budget/contracts";

import type { BudgetCapResolver, SpendEntry } from "./ports";
import { PostgresSpendReservations, type TxCapable } from "./postgres-spend-reservations";

/**
 * Preuves SANS base de données : la FORME de la réservation (verrou pris AVANT toute lecture,
 * prédicats de tenant, fermeture sur erreur, refus de construction sans tenant).
 *
 * La propriété qui compte vraiment — quatre workers simultanés ne dépassent jamais le plafond —
 * ne peut PAS être prouvée ici : elle est une propriété de PostgreSQL, et la prouver contre un
 * faux `execute` ne prouverait que la fidélité du faux. Elle est donc dans
 * `postgres-spend-reservations.integration.test.ts`, contre une vraie base.
 */

const dialect = new PgDialect();
const G1: Attribution = { goalId: "g1" };
const TOKENS: BudgetCap = { kind: "CAPPED", maxTotalTokens: 1_000 };

const entry = (total: number): SpendEntry => ({
  modelId: "test/model",
  usage: {
    kind: "METERED",
    usage: { promptTokens: total, completionTokens: 0, totalTokens: total },
  },
  attribution: G1,
  at: "2026-10-02T00:00:00.000Z",
});

/**
 * Faux `transaction` : exécute le corps en enregistrant chaque requête dans l'ordre. Les
 * réponses sont pilotées par un gabarit reconnu dans le SQL émis — aucune des assertions de ce
 * fichier ne porte sur la concurrence, seulement sur la forme et l'ordre.
 */
class FakeTxDb {
  readonly sqlSeen: string[] = [];
  readonly params: unknown[][] = [];
  constructor(
    private readonly held = 0,
    private readonly settled = true,
    private readonly fail?: Error,
  ) {}

  private readonly execute = async (query: SQL): Promise<unknown> => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    this.sqlSeen.push(text);
    this.params.push(params);
    if (this.fail) throw this.fail;
    if (text.includes("sum(reserved_tokens)")) return [{ held: String(this.held) }];
    if (text.includes("from spend_ledger")) return [];
    if (text.includes("update spend_reservations")) return this.settled ? [{ id: "r1" }] : [];
    return [];
  };

  readonly transaction = async <T>(
    fn: (tx: { execute: (query: SQL) => Promise<unknown> }) => Promise<T>,
  ) => fn({ execute: this.execute });
}

const store = (db: FakeTxDb, caps: BudgetCapResolver = async () => TOKENS) =>
  new PostgresSpendReservations({
    db: db as unknown as TxCapable,
    tenantId: "default",
    caps,
    priceTable: {},
    newId: () => "fixe",
  });

describe("PostgresSpendReservations — forme et fermeture", () => {
  it("refuse d'exister sans tenant : pas de tenant, pas de budget", () => {
    expect(
      () =>
        new PostgresSpendReservations({
          db: new FakeTxDb() as unknown as TxCapable,
          tenantId: "   ",
          caps: async () => TOKENS,
        }),
    ).toThrow(/tenantId/);
  });

  it("refuse un bail non exploitable", () => {
    for (const leaseMs of [0, -1, Number.NaN]) {
      expect(
        () =>
          new PostgresSpendReservations({
            db: new FakeTxDb() as unknown as TxCapable,
            tenantId: "default",
            caps: async () => TOKENS,
            leaseMs,
          }),
      ).toThrow(/leaseMs/);
    }
  });

  it("prend le VERROU EN PREMIER, avant toute lecture : c'est l'ordre qui fait l'atomicité", async () => {
    const db = new FakeTxDb();
    await store(db).reserve(G1, 10);
    expect(db.sqlSeen[0]).toContain("pg_advisory_xact_lock");
    /* Puis seulement : la dépense réelle, puis les engagements vivants, puis l'insertion. */
    expect(db.sqlSeen[1]).toContain("from spend_ledger");
    expect(db.sqlSeen[2]).toContain("sum(reserved_tokens)");
    expect(db.sqlSeen[3]).toContain("insert into spend_reservations");
  });

  it("verrouille la clé d'imputation DU TENANT, pas une clé globale", async () => {
    const db = new FakeTxDb();
    await store(db).reserve(G1, 10);
    expect(db.params[0]).toEqual(["icos.budget:default|goal=g1"]);
  });

  it("ne somme que les engagements VIVANTS d'un seul tenant et d'une seule imputation", async () => {
    const db = new FakeTxDb();
    await store(db).reserve(G1, 10);
    expect(db.sqlSeen[2]).toContain("lease_until");
    expect(db.sqlSeen[2]).toContain("tenant_id");
    expect(db.sqlSeen[2]).toContain("attribution_key");
    expect(db.params[2]).toEqual(["default", "goal=g1"]);
  });

  it("compte les engagements existants et REFUSE au lieu de rogner", async () => {
    const outcome = await store(new FakeTxDb(900)).reserve(G1, 200);
    expect(outcome).toMatchObject({ kind: "DENY", reason: "RESERVATION_EXCEEDS_CAP" });
  });

  it("une base illisible est un REFUS, jamais une autorisation", async () => {
    const outcome = await store(new FakeTxDb(0, true, new Error("base indisponible"))).reserve(
      G1,
      10,
    );
    expect(outcome).toMatchObject({ kind: "DENY", reason: "UNUSABLE_WINDOW" });
  });

  it("un plafond non résolu est un REFUS", async () => {
    const outcome = await store(new FakeTxDb(), async () => {
      throw new Error("plafond introuvable");
    }).reserve(G1, 10);
    expect(outcome).toMatchObject({ kind: "DENY", reason: "UNUSABLE_WINDOW" });
  });

  it("n'insère RIEN quand la réservation est refusée", async () => {
    const db = new FakeTxDb(1_000);
    expect(await store(db).reserve(G1, 10)).toMatchObject({ kind: "DENY" });
    expect(db.sqlSeen.some((s) => s.includes("insert into spend_reservations"))).toBe(false);
  });

  it("écrit la dépense RÉELLE au journal AVANT de clore, et dit le reliquat", async () => {
    const db = new FakeTxDb();
    const outcome = await store(db).settle(
      { id: "r1", ownerToken: "o1", reservedTokens: 1_000 },
      entry(400),
    );
    expect(db.sqlSeen[0]).toContain("insert into spend_ledger");
    expect(db.sqlSeen[1]).toContain("update spend_reservations");
    expect(outcome).toEqual({
      reservedTokens: 1_000,
      actualTokens: 400,
      releasedTokens: 600,
      overrunTokens: 0,
      closed: true,
    });
  });

  it("ENREGISTRE QUAND MÊME la dépense d'une réservation qu'il ne peut plus clore", async () => {
    /* Bail expiré ou mauvais jeton : l'appel a coûté de vrais tokens, les taire serait un blanchiment. */
    const db = new FakeTxDb(0, false);
    const outcome = await store(db).settle(
      { id: "r1", ownerToken: "périmé", reservedTokens: 100 },
      entry(500),
    );
    expect(db.sqlSeen[0]).toContain("insert into spend_ledger");
    expect(outcome).toMatchObject({ closed: false, overrunTokens: 400, actualTokens: 500 });
  });

  it("solde sous le jeton de FENCING du porteur et son propre tenant", async () => {
    const db = new FakeTxDb();
    await store(db).settle({ id: "r1", ownerToken: "o1", reservedTokens: 10 }, entry(5));
    expect(db.sqlSeen[1]).toContain("owner_token");
    expect(db.params[1]).toEqual(["r1", "default", "o1"]);
  });
});
