import { sql, type SQL } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { UNMETERED, type Attribution } from "@/core/budget/contracts";
import type { PriceEntry, PriceTable } from "@/core/budget/price-table";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { createGoalBudgetCapResolver } from "./goal-budget-cap-resolver";
import { PostgresSpendLedger } from "./postgres-spend-ledger";
import type { BudgetCapResolver, SpendEntry } from "./ports";

/**
 * Preuves PostgreSQL du journal de dépense durable (migration 0055_spend_ledger.sql) :
 * le SQL lui-même, les CHECK qui rendent « une absence n'est jamais un zéro » non
 * contournable, le trigger append-only, la durabilité à travers une connexion NEUVE, et la
 * borne de dépassement sous appels réellement simultanés contre une vraie base.
 *
 * `pnpm test` n'exécute PAS ce fichier (exclu par vitest.config.ts) : il est destiné à la
 * passe sérielle du coordinateur, qui est seule propriétaire de la base de test partagée.
 *
 * `truncateAll` de pg-support ne connaît pas `spend_ledger` : chaque test vide donc la table
 * lui-même. TRUNCATE n'est pas couvert par un trigger de ligne.
 *
 * HARNESS : la base de test LOCALE (`ICOS_TEST_DATABASE_URL`), et non Testcontainers. Le lot
 * d'origine avait copié le motif `describe.skipIf(!dockerAvailable)`, mais le démon Docker n'est
 * pas disponible sur cette machine : ces 13 fichiers-là se SAUTENT en silence, et la durabilité —
 * l'unique raison d'être de ce lot — n'était donc jamais prouvée. Les 74 autres fichiers
 * d'intégration utilisent la base locale et s'exécutent réellement. `createDatabase` applique
 * `assertSafeTestDatabaseUrl` sous VITEST, donc la base live reste inatteignable d'ici.
 */

const TENANT = "default";
const OTHER_TENANT = "autre-tenant";
const G1: Attribution = { goalId: "g1" };

const PRICED: PriceEntry = {
  modelId: "test/model",
  currency: "EUR",
  promptPerMillion: 1,
  completionPerMillion: 1,
  provenance: "fixture de test d'intégration",
  asOf: "2026-10-02",
};
const PRICE_TABLE: PriceTable = { "test/model": PRICED };

const metered = (
  prompt: number,
  completion = 0,
  attribution: Attribution | null = G1,
): SpendEntry => ({
  modelId: "test/model",
  usage: {
    kind: "METERED",
    usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
  },
  attribution,
  at: "2026-10-02T00:00:00.000Z",
});

const unmetered = (attribution: Attribution | null = G1): SpendEntry => ({
  modelId: "test/model",
  usage: { kind: UNMETERED, reason: "USAGE_ABSENT" },
  attribution,
  at: "2026-10-02T00:00:00.000Z",
});

/** SQLSTATE d'une promesse rejetée par PostgreSQL, sans exposer le message brut. */
const pgCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code ?? "UNKNOWN";
  }
};

describe("spend_ledger (base de test locale, migration 0055)", () => {
  let ctx: { handle: DatabaseHandle };

  beforeAll(() => {
    ctx = { handle: createDatabase(TEST_DATABASE_URL, { max: 5 }) };
  });
  afterAll(async () => {
    await ctx.handle.close();
  });

  beforeEach(async () => {
    await ctx.handle.db.execute(sql`TRUNCATE TABLE spend_ledger`);
    await ctx.handle.db.execute(sql`DELETE FROM goals`);
  });

  const ledger = (
    tenantId = TENANT,
    caps: BudgetCapResolver = async () => ({ kind: "CAPPED", maxTotalTokens: 100 }),
    priceTable: PriceTable = PRICE_TABLE,
  ) => new PostgresSpendLedger({ db: ctx.handle.db, tenantId, caps, priceTable });

  const rowCount = async () => {
    const rows = (await ctx.handle.db.execute(
      sql`select count(*)::int as n from spend_ledger`,
    )) as unknown as { n: number }[];
    return rows[0].n;
  };

  it("persiste une ligne par observation et replie la fenêtre depuis la base", async () => {
    const l = ledger(TENANT, async () => ({ kind: "CAPPED", maxTotalTokens: 10_000 }));
    await l.record(metered(100, 50));
    await l.record(metered(10, 5));
    await l.record(unmetered());

    expect(await rowCount()).toBe(3);
    const window = await l.windowFor(G1);
    expect(window.calls).toBe(3);
    expect(window.totalTokens).toBe(165);
    expect(window.unmeteredCalls).toBe(1);
    expect(window.amount).toBeCloseTo(165 / 1_000_000, 12);
  });

  it("survit à un REDÉMARRAGE : une connexion neuve lit la même fenêtre", async () => {
    await ledger().record(metered(40));
    const before = await ledger().windowFor(G1);

    /* Nouveau client PostgreSQL = nouveau processus, aucun état partagé. */
    const fresh = createDatabase(TEST_DATABASE_URL, { max: 2 });
    try {
      const after = await new PostgresSpendLedger({
        db: fresh.db,
        tenantId: TENANT,
        caps: async () => ({ kind: "CAPPED", maxTotalTokens: 100 }),
        priceTable: PRICE_TABLE,
      }).windowFor(G1);
      expect(after).toEqual(before);
      expect(after.totalTokens).toBe(40);
    } finally {
      await fresh.close();
    }
  });

  it("le plafond tient après redémarrage : la dépense d'avant compte encore", async () => {
    await ledger().record(metered(150));
    expect(await ledger().checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "TOKEN_CAP_REACHED",
    });
  });

  it("isole les tenants : la dépense d'un tenant ne compte pas pour l'autre", async () => {
    await ledger(TENANT).record(metered(150));
    expect(await ledger(TENANT).checkBudget(G1)).toMatchObject({ kind: "DENY" });
    expect(await ledger(OTHER_TENANT).checkBudget(G1)).toEqual({ kind: "ALLOW" });
    expect((await ledger(OTHER_TENANT).windowFor(G1)).calls).toBe(0);
  });

  it("est APPEND-ONLY : UPDATE et DELETE sont refusés par le trigger", async () => {
    await ledger().record(metered(10));
    expect(await pgCode(ctx.handle.db.execute(sql`UPDATE spend_ledger SET total_tokens = 0`))).toBe(
      "42501",
    );
    expect(await pgCode(ctx.handle.db.execute(sql`DELETE FROM spend_ledger`))).toBe("42501");
    /* La ligne est intacte : la dépense n'a pas pu être silencieusement réduite. */
    expect((await ledger().windowFor(G1)).totalTokens).toBe(10);
    expect(await rowCount()).toBe(1);
  });

  describe("les CHECK rendent « une absence n'est jamais un zéro » non contournable", () => {
    const insert = (columns: string, values: SQL) =>
      ctx.handle.db.execute(
        sql`insert into spend_ledger (id, tenant_id, attribution_key, model_id, observed_at, ${sql.raw(columns)})
            values ('x', ${TENANT}, 'goal=g1', 'test/model', now(), ${values})`,
      );

    it("refuse un METERED sans compteurs (un inconnu blanchi en mesure)", async () => {
      expect(await pgCode(insert("usage_kind, cost_kind", sql`'METERED', 'UNPRICED'`))).toBe(
        "23514",
      );
    });

    it("refuse un UNMETERED porteur de zéros (un inconnu blanchi en 0 token)", async () => {
      expect(
        await pgCode(
          insert(
            "usage_kind, unmetered_reason, prompt_tokens, completion_tokens, total_tokens",
            sql`'UNMETERED', 'USAGE_ABSENT', 0, 0, 0`,
          ),
        ),
      ).toBe("23514");
    });

    it("refuse un UNMETERED sans raison", async () => {
      expect(await pgCode(insert("usage_kind", sql`'UNMETERED'`))).toBe("23514");
    });

    it("refuse un UNPRICED porteur d'un montant (un appel sans prix n'est pas gratuit)", async () => {
      expect(
        await pgCode(
          insert(
            "usage_kind, prompt_tokens, completion_tokens, total_tokens, cost_kind, unpriced_reason, amount",
            sql`'METERED', 1, 1, 2, 'UNPRICED', 'modèle absent', 0`,
          ),
        ),
      ).toBe("23514");
    });

    it("refuse un COST sans montant", async () => {
      expect(
        await pgCode(
          insert(
            "usage_kind, prompt_tokens, completion_tokens, total_tokens, cost_kind, currency",
            sql`'METERED', 1, 1, 2, 'COST', 'EUR'`,
          ),
        ),
      ).toBe("23514");
    });

    it("refuse un tenant vide", async () => {
      expect(
        await pgCode(
          ctx.handle.db.execute(
            sql`insert into spend_ledger (id, tenant_id, attribution_key, model_id, usage_kind,
                  unmetered_reason, observed_at)
                values ('y', '', 'goal=g1', 'test/model', 'UNMETERED', 'USAGE_ABSENT', now())`,
          ),
        ),
      ).toBe("23514");
    });

    it("accepte un VRAI zéro mesuré et le relit comme mesuré, pas comme inconnu", async () => {
      const l = ledger(TENANT, async () => ({ kind: "CAPPED", maxTotalTokens: 100 }));
      await l.record(metered(0, 0));
      const rows = (await ctx.handle.db.execute(
        sql`select usage_kind, total_tokens, unmetered_reason from spend_ledger`,
      )) as unknown as Record<string, unknown>[];
      expect(rows[0]).toMatchObject({ usage_kind: "METERED", unmetered_reason: null });
      expect(Number(rows[0].total_tokens)).toBe(0);
      const window = await l.windowFor(G1);
      expect(window.unmeteredCalls).toBe(0);
      expect(window.calls).toBe(1);
      expect(await l.checkBudget(G1)).toEqual({ kind: "ALLOW" });
    });
  });

  it("une table de prix VIDE rend UNPRICED et interdit tout plafond monétaire", async () => {
    const l = ledger(TENANT, async () => ({ kind: "CAPPED", maxAmount: 10 }), {});
    await l.record(metered(1_000));
    const rows = (await ctx.handle.db.execute(
      sql`select cost_kind, amount from spend_ledger`,
    )) as unknown as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ cost_kind: "UNPRICED", amount: null });
    expect(await l.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
  });

  describe("la borne de dépassement, contre une vraie base", () => {
    const WORKERS = 8;

    it("W contrôles simultanés passent, les W écritures atterrissent toutes, puis tout est refusé", async () => {
      const l = ledger(TENANT, async () => ({ kind: "CAPPED", maxTotalTokens: 100 }), {});
      await l.record(metered(90));

      const decisions = await Promise.all(Array.from({ length: WORKERS }, () => l.checkBudget(G1)));
      expect(decisions.filter((d) => d.kind === "ALLOW")).toHaveLength(WORKERS);

      await Promise.all(Array.from({ length: WORKERS }, () => l.record(metered(10))));
      /* Aucune écriture concurrente perdue ni fusionnée : la table est append-only. */
      expect(await rowCount()).toBe(1 + WORKERS);
      expect((await l.windowFor(G1)).totalTokens).toBe(90 + WORKERS * 10);

      const after = await Promise.all(Array.from({ length: WORKERS }, () => l.checkBudget(G1)));
      expect(after.every((d) => d.kind === "DENY")).toBe(true);
    });

    it("la borne tient entre PROCESSUS : des instances neuves refusent déjà", async () => {
      await ledger(TENANT, async () => ({ kind: "CAPPED", maxTotalTokens: 100 }), {}).record(
        metered(150),
      );
      const decisions = await Promise.all(
        Array.from({ length: WORKERS }, () =>
          ledger(TENANT, async () => ({ kind: "CAPPED", maxTotalTokens: 100 }), {}).checkBudget(G1),
        ),
      );
      expect(decisions.every((d) => d.kind === "DENY")).toBe(true);
    });
  });

  describe("createGoalBudgetCapResolver contre la vraie table goals", () => {
    /*
     * `goals.createdAt` et `goals.updatedAt` sont NOT NULL sans défaut : l'insertion du lot d'origine l'omettait et
     * n'avait jamais été exécutée (le fichier était gaté sur Docker, indisponible ici), donc
     * les trois preuves du résolveur échouaient sur leur propre fixture, pas sur le code testé.
     */
    const seedGoal = async (id: string, budget: number | null) =>
      ctx.handle.db.execute(sql`
        insert into goals ("id", "goalId", "title", "objective", "rawInput",
                           "normalizedIntent", "budget", "createdAt", "updatedAt")
        values (${id}, ${id}, 'titre', 'objectif', 'entrée', 'intention', ${budget},
                '2026-10-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z')
      `);

    it("un budget NULL n'est ni sans plafond ni zéro : sans plafond de tokens, il refuse", async () => {
      await seedGoal("g1", null);
      const caps = createGoalBudgetCapResolver({ db: ctx.handle.db });
      expect(await caps(G1)).toEqual({ kind: "CAPPED" });
      expect(await ledger(TENANT, caps, {}).checkBudget(G1)).toMatchObject({
        kind: "DENY",
        reason: "NO_ENFORCEABLE_CAP",
      });
    });

    it("un budget NULL reste gouverné par le plafond de tokens du propriétaire", async () => {
      await seedGoal("g1", null);
      const caps = createGoalBudgetCapResolver({
        db: ctx.handle.db,
        maxTotalTokensPerGoal: 1_000,
      });
      const l = ledger(TENANT, caps, {});
      expect(await l.checkBudget(G1)).toEqual({ kind: "ALLOW" });
      await l.record(metered(1_200));
      expect(await l.checkBudget(G1)).toMatchObject({
        kind: "DENY",
        reason: "TOKEN_CAP_REACHED",
      });
    });

    it("un budget persisté devient un plafond monétaire, insatisfiable sans prix", async () => {
      await seedGoal("g1", 42.5);
      const caps = createGoalBudgetCapResolver({ db: ctx.handle.db });
      expect(await caps(G1)).toEqual({ kind: "CAPPED", maxAmount: 42.5 });
      const l = ledger(TENANT, caps, {});
      await l.record(metered(10));
      expect(await l.checkBudget(G1)).toMatchObject({
        kind: "DENY",
        reason: "UNPRICED_USAGE_IN_WINDOW",
      });
    });

    it("un goal inexistant refuse", async () => {
      const caps = createGoalBudgetCapResolver({ db: ctx.handle.db });
      expect(await caps({ goalId: "inconnu" })).toEqual({ kind: "CAPPED" });
    });
  });
});
