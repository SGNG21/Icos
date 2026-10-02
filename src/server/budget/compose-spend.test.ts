import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { createOmniRouteAutonomousMissionPlanner } from "@/server/autonomy/omniroute-autonomous-mission-planner";

import { runWithAttribution } from "./attribution-context";
import {
  composeSpendMeters,
  composeSpendReservations,
  createSpendLedger,
  SPEND_LEDGER_TENANT_ID,
  UNCAPPED_OVERHEAD,
} from "./compose-spend";
import { InMemorySpendLedger } from "./in-memory-spend-ledger";
import { BudgetDeniedError } from "./metered-fetch";
import { PostgresSpendLedger, type SqlExec } from "./postgres-spend-ledger";

/**
 * Preuves de l'INSTALLATION du compteur (verrou B1), sans base de données et sans réseau.
 *
 * Ce qui est prouvé ici : un appel émis dans la portée d'un goal est contrôlé contre LE
 * budget de CE goal ; un appel hors de toute portée est REFUSÉ et non « non plafonné » ; la
 * couture des frais opérationnels est sans plafond par un choix NOMMÉ et n'entame la fenêtre
 * d'aucun goal ; un plafond de tokens épuisé refuse l'appel suivant AVANT le fournisseur.
 *
 * Ce qui n'est PAS prouvé ici : le SQL réel (c'est `postgres-spend-ledger.integration.test.ts`)
 * et le câblage du conteneur (`container.ts` ne se monte pas sans base).
 */

const dialect = new PgDialect();

/**
 * Faux `execute` reconnaissant les TROIS requêtes de cette composition, via le rendu réel de
 * Drizzle : la lecture de `goals.budget`, l'insertion dans `spend_ledger` et la relecture de
 * la fenêtre. Il ne simule pas PostgreSQL ; il rend des lignes.
 */
class FakeDb implements SqlExec {
  readonly rows: Record<string, unknown>[] = [];
  readonly goalLookups: string[] = [];

  constructor(private readonly goals: Record<string, number | null> = {}) {}

  async execute(query: SQL): Promise<unknown> {
    const { sql: text, params } = dialect.sqlToQuery(query);

    if (/from goals/i.test(text)) {
      const id = String(params[0]);
      this.goalLookups.push(id);
      return id in this.goals ? [{ budget: this.goals[id] }] : [];
    }

    if (/^\s*insert/i.test(text)) {
      const columns = /\(([^)]*)\)\s*values/i.exec(text)?.[1] ?? "";
      const row: Record<string, unknown> = {};
      columns.split(",").forEach((name, i) => (row[name.trim()] = params[i] ?? null));
      this.rows.push(row);
      return [];
    }

    return this.rows.filter((r) => r.tenant_id === params[0] && r.attribution_key === params[1]);
  }
}

/** Un fournisseur qui compte ses appels : « refusé AVANT le fournisseur » se prouve avec lui. */
function provider(totalTokens = 10) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        model: "test/model",
        usage: {
          prompt_tokens: totalTokens,
          completion_tokens: 0,
          total_tokens: totalTokens,
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  return { fetchImpl, calls };
}

describe("composeSpendMeters — couture mission : plafonnée par le budget du goal", () => {
  it("contrôle l'appel contre LE budget du goal de la portée, et impute la ligne à ce goal", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    await runWithAttribution({ goalId: "g1" }, () =>
      meters.mission("https://provider.test/v1/chat/completions", { body: "{}" }),
    );

    expect(calls).toHaveLength(1);
    /* Le plafond a été résolu pour CE goal, pas pour un autre et pas « en général ». */
    expect(db.goalLookups).toEqual(["g1"]);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].goal_id).toBe("g1");
    expect(db.rows[0].attribution_key).toBe("goal=g1");
    expect(db.rows[0].tenant_id).toBe(SPEND_LEDGER_TENANT_ID);
  });

  it("REFUSE un appel hors de toute portée : l'absence d'imputation n'est pas une absence de plafond", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    await expect(meters.mission("https://provider.test/v1/chat/completions")).rejects.toThrow(
      BudgetDeniedError,
    );
    /* Rien n'est parti, et aucun goal n'a été interrogé : il n'y en avait aucun. */
    expect(calls).toHaveLength(0);
    expect(db.goalLookups).toEqual([]);
  });

  it("refuse l'appel suivant AVANT le fournisseur quand le plafond de tokens est épuisé", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl, calls } = provider(120);
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 100, inner: fetchImpl });

    const call = () =>
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: "{}" }),
      );

    await call();
    expect(calls).toHaveLength(1);

    await expect(call()).rejects.toMatchObject({
      name: "BudgetDeniedError",
      reason: "TOKEN_CAP_REACHED",
    });
    /* LE point du lot : le deuxième appel n'a jamais atteint le fournisseur. */
    expect(calls).toHaveLength(1);
  });

  /**
   * CONSÉQUENCE OPÉRATIONNELLE RÉELLE, documentée par un test plutôt que par une note :
   * la table de prix est VIDE, donc tout appel est UNPRICED. Un goal qui porte un budget
   * MONÉTAIRE obtient donc un premier appel (fenêtre vide), puis plus rien : un total non
   * chiffré ne peut pas être prouvé sous un plafond en euros. Ce n'est pas un défaut de
   * câblage, c'est `decide` qui refuse de blanchir une dépense inconnue ; le propriétaire
   * ouvre cette vanne en inscrivant de vrais prix, pas en relâchant le plafond.
   */
  it("un goal à budget monétaire n'obtient qu'UN appel tant que la table de prix est vide", async () => {
    const db = new FakeDb({ g1: 5_000 });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, inner: fetchImpl });
    const call = () =>
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: "{}" }),
      );

    await call();
    await expect(call()).rejects.toMatchObject({
      name: "BudgetDeniedError",
      reason: "UNPRICED_USAGE_IN_WINDOW",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuse un goal inconnu plutôt que d'inventer son plafond", async () => {
    const db = new FakeDb({});
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    await expect(
      runWithAttribution({ goalId: "absent" }, () =>
        meters.mission("https://provider.test/v1/chat/completions"),
      ),
    ).rejects.toMatchObject({ name: "BudgetDeniedError", reason: "NO_ENFORCEABLE_CAP" });
    expect(calls).toHaveLength(0);
  });

  it("sans base, refuse : aucun budget lisible n'est « pas de budget »", async () => {
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ inner: fetchImpl });

    await expect(
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions"),
      ),
    ).rejects.toMatchObject({ name: "BudgetDeniedError", reason: "NO_ENFORCEABLE_CAP" });
    expect(calls).toHaveLength(0);
  });
});

describe("composeSpendMeters — couture frais opérationnels : UNCAPPED par choix nommé", () => {
  it("UNCAPPED_OVERHEAD est bien un UNCAPPED écrit, pas une absence de plafond", async () => {
    expect(await UNCAPPED_OVERHEAD(null)).toEqual({ kind: "UNCAPPED" });
    expect(await UNCAPPED_OVERHEAD({ goalId: "g1" })).toEqual({ kind: "UNCAPPED" });
  });

  it("laisse passer une sonde hors de toute portée, et la mesure quand même", async () => {
    const db = new FakeDb({});
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, inner: fetchImpl });

    await meters.overhead("https://provider.test/v1/chat/completions", { body: "{}" });

    expect(calls).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].attribution_key).toBe("UNATTRIBUTED");
    /* Aucun budget de goal n'est consulté pour un frais opérationnel. */
    expect(db.goalLookups).toEqual([]);
  });

  it("n'entame la fenêtre d'aucun goal, même émise dans une portée de mission", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl } = provider(10_000);
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 100, inner: fetchImpl });

    /*
     * Le chemin RÉEL de la sonde : `OmniRouteHttpWorkerProbe` sonde un modèle par une
     * complétion (`compute-fleet` poste sur /v1/chat/completions). Un chemin inventé ne serait
     * plus mesuré du tout depuis que seules les complétions le sont, et ce test ne prouverait
     * alors plus rien.
     */
    await runWithAttribution({ goalId: "g1" }, () =>
      meters.overhead("https://provider.test/v1/chat/completions", { body: "{}" }),
    );

    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].goal_id).toBeNull();
    /* 10 000 tokens de sonde n'épuisent pas le plafond de 100 du goal : il reste passant. */
    await expect(
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: "{}" }),
      ),
    ).resolves.toBeInstanceOf(Response);
  });
});

describe("createSpendLedger — durable quand il y a une base", () => {
  it("choisit le journal PostgreSQL quand le conteneur a une base", () => {
    const ledger = createSpendLedger({ db: new FakeDb(), caps: UNCAPPED_OVERHEAD });
    expect(ledger).toBeInstanceOf(PostgresSpendLedger);
  });

  it("choisit le journal en mémoire quand il n'y en a pas", () => {
    const ledger = createSpendLedger({ caps: UNCAPPED_OVERHEAD });
    expect(ledger).toBeInstanceOf(InMemorySpendLedger);
  });
});

/**
 * LA PREUVE DE L'INSTALLATION : la fabrique que `container.ts` appelle (avec, en
 * production, `spend.mission`) produit bien un planificateur dont le moindre appel passe par
 * le compteur. C'est ce chemin — fabrique -> provider OmniRoute -> `meteredFetch` -> journal
 * -> `decide` — qui applique `goals.budget`.
 *
 * Ce qui reste prouvé par LECTURE seulement : `buildPostgresContainer` passe réellement
 * `spend.mission` ici, parce que monter ce conteneur exige une base de données.
 */
describe("couture planificateur — la fabrique du conteneur émet à travers le compteur", () => {
  const plannerEnv = {
    OMNIROUTE_BASE_URL: "https://provider.test",
    OMNIROUTE_API_KEY: "clef-de-test",
    ICOS_PLANNER_MODEL: "test/model",
    ICOS_PLANNER_TIMEOUT_MS: 1_000,
  };

  const planInput = {
    mission: {
      id: "mission-1",
      title: "M",
      objective: "O",
      status: "planning" as const,
      createdAt: new Date("2026-10-02T12:00:00.000Z"),
      updatedAt: new Date("2026-10-02T12:00:00.000Z"),
    },
    tasks: [],
    reason: "initial" as const,
  };

  it("n'atteint PAS le fournisseur quand le goal imputé n'a aucun plafond applicable", async () => {
    const db = new FakeDb({});
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, inner: fetchImpl });
    const planner = createOmniRouteAutonomousMissionPlanner(plannerEnv, meters.mission);

    await expect(
      runWithAttribution({ goalId: "g1" }, () => planner!.plan(planInput)),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(db.goalLookups).toEqual(["g1"]);
  });

  it("atteint le fournisseur quand le goal a un plafond applicable non épuisé", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });
    const planner = createOmniRouteAutonomousMissionPlanner(plannerEnv, meters.mission);

    /* La réponse du faux fournisseur n'est pas un plan : seule compte l'émission de l'appel. */
    await runWithAttribution({ goalId: "g1" }, () => planner!.plan(planInput)).catch(
      () => undefined,
    );

    expect(calls).toEqual(["https://provider.test/v1/chat/completions"]);
    expect(db.rows[0].goal_id).toBe("g1");
  });
});

describe("composeSpendReservations — MÊME plafond que la couture mission", () => {
  /**
   * Le faux `execute` ci-dessus, plus la somme des engagements et une transaction factice.
   * Il ne simule PAS la concurrence : l'atomicité est une propriété de PostgreSQL et elle est
   * prouvée dans `postgres-spend-reservations.integration.test.ts`. Ce qui est prouvé ici,
   * c'est le CÂBLAGE — quel plafond, quelle clé tenant, quelle imputation.
   */
  const txDb = (goals: Record<string, number | null> = {}) => {
    const db = new FakeDb(goals);
    const exec: SqlExec = {
      async execute(query: SQL) {
        const { sql: text } = dialect.sqlToQuery(query);
        if (/pg_advisory_xact_lock/.test(text)) return [];
        if (/sum\(reserved_tokens\)/.test(text)) {
          const held = db.rows
            .filter((r) => r.reserved_tokens !== undefined)
            .reduce((sum, r) => sum + Number(r.reserved_tokens), 0);
          return [{ held: String(held) }];
        }
        return db.execute(query);
      },
    };
    return Object.assign(exec, {
      goalLookups: db.goalLookups,
      rows: db.rows,
      transaction: <T>(fn: (tx: SqlExec) => Promise<T>) => fn(exec),
    });
  };

  it("réserve sous le budget du goal, donc refuse un goal sans plafond applicable", async () => {
    const db = txDb({});
    const store = composeSpendReservations({ db });
    expect(await store.reserve({ goalId: "g1" }, 100)).toMatchObject({
      kind: "DENY",
      reason: "NO_ENFORCEABLE_CAP",
    });
    expect(db.goalLookups).toEqual(["g1"]);
  });

  it("accorde sous le plafond de TOKENS du propriétaire, sans aucun prix", async () => {
    const store = composeSpendReservations({
      db: txDb({ g1: null }),
      maxTotalTokensPerGoal: 1_000,
    });
    expect(await store.reserve({ goalId: "g1" }, 1_000)).toMatchObject({ kind: "RESERVED" });
  });

  it("refuse une demande qui dépasse le plafond du goal, sans la rogner", async () => {
    const store = composeSpendReservations({
      db: txDb({ g1: null }),
      maxTotalTokensPerGoal: 1_000,
    });
    expect(await store.reserve({ goalId: "g1" }, 1_001)).toMatchObject({
      kind: "DENY",
      reason: "RESERVATION_EXCEEDS_CAP",
    });
  });

  it("refuse un appel NON IMPUTÉ : pas d'imputation, pas de budget à engager", async () => {
    const store = composeSpendReservations({
      db: txDb({ g1: null }),
      maxTotalTokensPerGoal: 1_000,
    });
    expect(await store.reserve(null, 10)).toMatchObject({ kind: "DENY" });
  });

  it("écrit sous la MÊME clé tenant que le journal", async () => {
    const db = txDb({ g1: null });
    await composeSpendReservations({ db, maxTotalTokensPerGoal: 1_000 }).reserve(
      { goalId: "g1" },
      10,
    );
    expect(db.rows.at(-1)?.tenant_id).toBe(SPEND_LEDGER_TENANT_ID);
  });
});
