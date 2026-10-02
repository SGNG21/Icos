import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { UNMETERED, type Attribution, type BudgetCap } from "@/core/budget/contracts";
import type { PriceEntry, PriceTable } from "@/core/budget/price-table";

import { PostgresSpendLedger, type SqlExec } from "./postgres-spend-ledger";

/**
 * Preuves UNITAIRES du journal durable, SANS base de données.
 *
 * Ce que ce fichier prouve : l'ordre des appels, l'absence de tout total gardé en mémoire
 * (donc la survie à un redémarrage simulé), le repliement des lignes par `accumulate`, le
 * refus sur erreur de base, et la BORNE DE DÉPASSEMENT annoncée dans l'en-tête de
 * `postgres-spend-ledger.ts` sous appels réellement simultanés.
 *
 * Ce que ce fichier NE prouve PAS : la justesse du SQL, des CHECK et du trigger append-only.
 * Cela n'est prouvé que par `postgres-spend-ledger.integration.test.ts`, qui exige PostgreSQL.
 */

const dialect = new PgDialect();
const TENANT = "default";
const G1: Attribution = { goalId: "g1" };
const G2: Attribution = { goalId: "g2" };

const PRICED: PriceEntry = {
  modelId: "test/model",
  currency: "EUR",
  promptPerMillion: 1,
  completionPerMillion: 1,
  provenance: "fixture de test",
  asOf: "2026-10-02",
};
const table: PriceTable = { "test/model": PRICED };

/**
 * Faux `execute`. Il ne simule PAS PostgreSQL : il reconnaît les deux seules requêtes du
 * journal via le rendu réel de Drizzle (`PgDialect`), garde les lignes insérées dans un
 * tableau et les rend filtrées sur (tenant_id, attribution_key). Il ne connaît ni les CHECK
 * ni le trigger — c'est délibéré : les contraintes sont la preuve du test d'intégration.
 */
class FakeLedgerDb implements SqlExec {
  readonly rows: Record<string, unknown>[] = [];
  /** Le verbe de chaque requête émise, pour prouver qu'aucun UPDATE/DELETE n'est émis. */
  readonly verbs: string[] = [];
  failSelect: Error | undefined;
  failInsert: Error | undefined;

  async execute(query: SQL): Promise<unknown> {
    const { sql: text, params } = dialect.sqlToQuery(query);
    this.verbs.push(text.trim().split(/\s+/)[0].toLowerCase());

    if (/^\s*insert/i.test(text)) {
      if (this.failInsert) throw this.failInsert;
      const columns = /\(([^)]*)\)\s*values/i.exec(text)?.[1] ?? "";
      const row: Record<string, unknown> = {};
      columns.split(",").forEach((name, i) => (row[name.trim()] = params[i] ?? null));
      this.rows.push(row);
      return [];
    }

    if (this.failSelect) throw this.failSelect;
    return this.rows.filter((r) => r.tenant_id === params[0] && r.attribution_key === params[1]);
  }
}

const ledger = (
  db: SqlExec,
  cap: BudgetCap,
  priceTable: PriceTable = table,
  caps?: () => Promise<BudgetCap>,
) =>
  new PostgresSpendLedger({
    db,
    tenantId: TENANT,
    caps: caps ?? (async () => cap),
    priceTable,
    newId: (() => {
      let n = 0;
      return () => `row-${String(++n).padStart(4, "0")}`;
    })(),
  });

const metered = (prompt: number, completion = 0, attribution: Attribution | null = G1) => ({
  modelId: "test/model",
  usage: {
    kind: "METERED" as const,
    usage: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
  },
  attribution,
  at: "2026-10-02T00:00:00.000Z",
});

const unmetered = (attribution: Attribution | null = G1) => ({
  modelId: "test/model",
  usage: { kind: UNMETERED, reason: "USAGE_ABSENT" as const },
  attribution,
  at: "2026-10-02T00:00:00.000Z",
});

describe("PostgresSpendLedger — tenant", () => {
  it("refuse d'être construit sans contexte tenant", () => {
    const db = new FakeLedgerDb();
    const build = (tenantId: string) =>
      new PostgresSpendLedger({ db, tenantId, caps: async () => ({ kind: "UNCAPPED" }) });
    expect(() => build("")).toThrow(/tenantId requis/);
    expect(() => build("   ")).toThrow(/tenantId requis/);
    expect(db.verbs).toEqual([]);
  });

  it("impute chaque ligne au tenant et le pose en prédicat de lecture", async () => {
    const db = new FakeLedgerDb();
    await ledger(db, { kind: "UNCAPPED" }).record(metered(10));
    expect(db.rows[0].tenant_id).toBe(TENANT);

    const other = new PostgresSpendLedger({
      db,
      tenantId: "autre-tenant",
      caps: async () => ({ kind: "CAPPED", maxTotalTokens: 5 }),
      priceTable: table,
    });
    /* Les lignes de `default` ne sont pas dans la fenêtre d'un autre tenant. */
    expect((await other.windowFor(G1)).calls).toBe(0);
    expect(await other.checkBudget(G1)).toEqual({ kind: "ALLOW" });
  });
});

describe("PostgresSpendLedger — durabilité append-only", () => {
  it("persiste une ligne immuable par observation et n'émet jamais UPDATE ni DELETE", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 10_000 });
    await l.record(metered(10));
    await l.record(metered(20));
    await l.record(unmetered());
    await l.checkBudget(G1);

    expect(db.rows).toHaveLength(3);
    expect(new Set(db.verbs)).toEqual(new Set(["insert", "select"]));
    expect(db.verbs.filter((v) => v === "insert")).toHaveLength(3);
    expect(db.rows.map((r) => r.id)).toEqual(["row-0001", "row-0002", "row-0003"]);
  });

  it("survit à un redémarrage : une instance NEUVE sur les mêmes lignes lit la même fenêtre", async () => {
    const db = new FakeLedgerDb();
    const before = ledger(db, { kind: "CAPPED", maxTotalTokens: 1_000 });
    await before.record(metered(100, 50));
    await before.record(metered(10, 5));
    const windowBefore = await before.windowFor(G1);

    /* Le processus redémarre : nouvelle instance, aucun état conservé, mêmes lignes. */
    const after = ledger(db, { kind: "CAPPED", maxTotalTokens: 1_000 });
    expect(await after.windowFor(G1)).toEqual(windowBefore);
    expect(windowBefore.calls).toBe(2);
    expect(windowBefore.totalTokens).toBe(165);
  });

  it("ne garde aucun total en mémoire : une AUTRE instance voit l'écriture immédiatement", async () => {
    const db = new FakeLedgerDb();
    const cap: BudgetCap = { kind: "CAPPED", maxTotalTokens: 100 };
    const writer = ledger(db, cap);
    const reader = ledger(db, cap);
    expect(await reader.checkBudget(G1)).toEqual({ kind: "ALLOW" });

    await writer.record(metered(100));
    /* Un cache par processus aurait laissé le lecteur autoriser pour toujours. */
    expect(await reader.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "TOKEN_CAP_REACHED",
    });
  });

  it("isole les imputations : un goal ne consomme pas le budget d'un autre", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 100 });
    await l.record(metered(200, 0, G1));
    expect(await l.checkBudget(G1)).toMatchObject({ kind: "DENY" });
    expect(await l.checkBudget(G2)).toEqual({ kind: "ALLOW" });
  });
});

describe("PostgresSpendLedger — une absence n'est jamais un zéro", () => {
  it("persiste UNMETERED comme tel, distinguable à jamais d'un zéro mesuré", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 100 });
    await l.record(unmetered());

    expect(db.rows[0]).toMatchObject({
      usage_kind: "UNMETERED",
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      unmetered_reason: "USAGE_ABSENT",
      cost_kind: null,
      amount: null,
    });

    const window = await l.windowFor(G1);
    expect(window.unmeteredCalls).toBe(1);
    expect(window.calls).toBe(1);
    expect(window.totalTokens).toBe(0);
    /* Non mesuré = non prouvable sous un plafond = refus, pas « 0 token dépensé ». */
    expect(await l.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "UNMETERED_USAGE_IN_WINDOW",
    });
  });

  it("un VRAI zéro mesuré reste METERED et reste autorisé", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 100 });
    await l.record(metered(0, 0));

    expect(db.rows[0]).toMatchObject({
      usage_kind: "METERED",
      prompt_tokens: 0,
      total_tokens: 0,
      unmetered_reason: null,
    });
    const window = await l.windowFor(G1);
    expect(window.calls).toBe(1);
    expect(window.unmeteredCalls).toBe(0);
    expect(await l.checkBudget(G1)).toEqual({ kind: "ALLOW" });
  });

  it("persiste UNPRICED comme tel : amount NULL, jamais 0 EUR", async () => {
    const db = new FakeLedgerDb();
    /* Table de prix VIDE, l'état réel du système aujourd'hui. */
    const l = ledger(db, { kind: "CAPPED", maxAmount: 10 }, {});
    await l.record(metered(1_000));

    expect(db.rows[0]).toMatchObject({ cost_kind: "UNPRICED", amount: null, currency: null });
    expect(db.rows[0].unpriced_reason).toEqual(expect.stringContaining("absent"));

    const window = await l.windowFor(G1);
    expect(window.unpricedCalls).toBe(1);
    expect(window.amount).toBe(0);
    expect(window.totalTokens).toBe(1_000);
    /* 0 EUR comptabilisé n'est pas 0 EUR dépensé : un plafond monétaire est insatisfiable. */
    expect(await l.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
  });

  it("un plafond de TOKENS reste applicable alors qu'aucun prix n'existe", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 1_000 }, {});
    await l.record(metered(500));
    expect(await l.checkBudget(G1)).toEqual({ kind: "ALLOW" });
    await l.record(metered(500));
    expect(await l.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "TOKEN_CAP_REACHED",
    });
  });

  it("persiste un coût chiffré et le replie en montant", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxAmount: 10 });
    await l.record(metered(2_000_000, 1_000_000));
    expect(db.rows[0]).toMatchObject({ cost_kind: "COST", currency: "EUR", amount: 3 });
    const window = await l.windowFor(G1);
    expect(window.amount).toBe(3);
    expect(window.unpricedCalls).toBe(0);
    expect(await l.checkBudget(G1)).toEqual({ kind: "ALLOW" });
  });
});

describe("PostgresSpendLedger — fermé par défaut", () => {
  it("une erreur de base pendant checkBudget REFUSE, même sous UNCAPPED", async () => {
    const db = new FakeLedgerDb();
    db.failSelect = new Error("connection terminated");
    const l = ledger(db, { kind: "UNCAPPED" });
    const decision = await l.checkBudget(G1);
    expect(decision.kind).toBe("DENY");
    expect(decision).toMatchObject({ reason: "UNUSABLE_WINDOW" });
  });

  it("un plafond non résolu REFUSE, comme le journal en mémoire", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "UNCAPPED" }, table, async () => {
      throw new Error("goal introuvable");
    });
    expect(await l.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "NO_ENFORCEABLE_CAP",
      detail: expect.stringContaining("goal introuvable"),
    });
  });

  it("une erreur de base pendant record REMONTE et n'est pas avalée", async () => {
    const db = new FakeLedgerDb();
    db.failInsert = new Error("disk full");
    const l = ledger(db, { kind: "UNCAPPED" });
    await expect(l.record(metered(10))).rejects.toThrow("disk full");
    expect(db.rows).toHaveLength(0);
  });

  it("une ligne illisible sature la fenêtre et REFUSE plutôt que de compter faux", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 1_000 });
    await l.record(metered(10));
    db.rows[0].total_tokens = "pas-un-nombre";
    expect((await l.windowFor(G1)).saturated).toBe(true);
    expect(await l.checkBudget(G1)).toMatchObject({
      kind: "DENY",
      reason: "UNUSABLE_WINDOW",
    });
  });
});

describe("PostgresSpendLedger — la borne de dépassement annoncée", () => {
  /**
   * Choix (a) : dépassement borné et documenté. La borne revendiquée est « AU PLUS UN appel
   * par appelant simultané ». Ces tests la vérifient sous appels RÉELLEMENT simultanés
   * (promesses non attendues, résolues ensemble) — y compris son coût honnête : avec W
   * appelants le dépassement vaut W appels, il n'est PAS constant.
   */
  const WORKERS = 8;

  it("W contrôles simultanés passent tous : le trou existe et n'est pas caché", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 100 }, {});
    await l.record(metered(90)); // fenêtre juste sous le plafond

    const decisions = await Promise.all(Array.from({ length: WORKERS }, () => l.checkBudget(G1)));
    expect(decisions.filter((d) => d.kind === "ALLOW")).toHaveLength(WORKERS);
  });

  it("le dépassement vaut EXACTEMENT les appels en vol, et pas un de plus", async () => {
    const db = new FakeLedgerDb();
    const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 100 }, {});
    await l.record(metered(90));

    /* Les W contrôles sont émis avant qu'aucun n'enregistre : c'est le pire cas. */
    const allowed = (
      await Promise.all(Array.from({ length: WORKERS }, () => l.checkBudget(G1)))
    ).filter((d) => d.kind === "ALLOW").length;
    expect(allowed).toBe(WORKERS);

    /* Puis les W appels se règlent ensemble : aucun enregistrement n'est perdu ni fusionné. */
    await Promise.all(Array.from({ length: WORKERS }, () => l.record(metered(10))));
    const window = await l.windowFor(G1);
    expect(window.calls).toBe(1 + WORKERS);
    expect(db.rows).toHaveLength(1 + WORKERS);
    /* 90 + 8×10 = 170 pour un plafond de 100 : le dépassement est de 70, soit les 8 appels
       en vol — et jamais au-delà, car plus aucun contrôle ne passe. */
    expect(window.totalTokens).toBe(90 + WORKERS * 10);

    const after = await Promise.all(Array.from({ length: WORKERS }, () => l.checkBudget(G1)));
    expect(after.every((d) => d.kind === "DENY")).toBe(true);
    expect(after[0]).toMatchObject({ reason: "TOKEN_CAP_REACHED" });
  });

  it("la borne tient ENTRE processus : d'autres instances refusent dès les lignes écrites", async () => {
    const db = new FakeLedgerDb();
    const cap: BudgetCap = { kind: "CAPPED", maxTotalTokens: 100 };
    const writer = ledger(db, cap, {});
    await writer.record(metered(150));

    /* Huit « processus » neufs, contrôlant simultanément : tous refusent. Avec un total gardé
       en mémoire par processus, chacun aurait sa propre fenêtre vide et autoriserait. */
    const others = Array.from({ length: WORKERS }, () => ledger(db, cap, {}));
    const decisions = await Promise.all(others.map((o) => o.checkBudget(G1)));
    expect(decisions.every((d) => d.kind === "DENY")).toBe(true);
  });

  it("la borne est en NOMBRE D'APPELS : elle croît avec le parallélisme", async () => {
    const overshoot = async (workers: number) => {
      const db = new FakeLedgerDb();
      const l = ledger(db, { kind: "CAPPED", maxTotalTokens: 100 }, {});
      await l.record(metered(90));
      await Promise.all(Array.from({ length: workers }, () => l.checkBudget(G1)));
      await Promise.all(Array.from({ length: workers }, () => l.record(metered(10))));
      return (await l.windowFor(G1)).totalTokens - 100;
    };
    /* Documenté sans fard : 2 workers dépassent de 10, 16 workers dépassent de 150. Le
       dépassement n'est pas une constante — c'est le prix du choix (a). */
    expect(await overshoot(2)).toBe(10);
    expect(await overshoot(16)).toBe(150);
  });
});
