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
interface FakeReservation {
  id: string;
  tenant_id: string;
  attribution_key: string;
  reserved_tokens: number;
  owner_token: string;
  state: "OPEN" | "SETTLED" | "EXPIRED";
  lease_until: number;
}

class FakeDb implements SqlExec {
  readonly rows: Record<string, unknown>[] = [];
  readonly goalLookups: string[] = [];
  /** Engagements vivants : ce que `spend_reservations` tiendrait réellement. */
  readonly reservations: FakeReservation[] = [];

  constructor(private readonly goals: Record<string, number | null> = {}) {}

  /**
   * Une transaction qui exécute simplement le corps. Elle ne simule NI l'isolation NI le
   * verrou consultatif : ces propriétés-là sont celles de PostgreSQL et se prouvent contre
   * une vraie base (`postgres-spend-reservations.integration.test.ts`). Ce qu'elle permet de
   * prouver ici, et qui ne demande pas de concurrence, c'est que la couture de mission
   * RÉSERVE AVANT D'ÉMETTRE et borne la sortie.
   */
  async transaction<T>(fn: (tx: SqlExec) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async execute(query: SQL): Promise<unknown> {
    const { sql: text, params } = dialect.sqlToQuery(query);

    if (/pg_advisory_xact_lock/i.test(text)) return [];

    if (/from goals/i.test(text)) {
      const id = String(params[0]);
      this.goalLookups.push(id);
      return id in this.goals ? [{ budget: this.goals[id] }] : [];
    }

    if (/sum\(reserved_tokens\)/i.test(text)) {
      const held = this.live(String(params[0]), String(params[1])).reduce(
        (sum, r) => sum + r.reserved_tokens,
        0,
      );
      return [{ held: String(held) }];
    }

    if (/insert into spend_reservations/i.test(text)) {
      this.reservations.push({
        id: String(params[0]),
        tenant_id: String(params[1]),
        attribution_key: String(params[2]),
        reserved_tokens: Number(params[4]),
        owner_token: String(params[5]),
        state: "OPEN",
        lease_until: Date.now() + Number(params[6]),
      });
      return [];
    }

    if (/select attribution_key/i.test(text)) {
      /* Par ID et TENANT seulement : le jeton de fencing ne gouverne que la CLÔTURE. */
      const row = this.reservations.find(
        (r) => r.id === String(params[0]) && r.tenant_id === String(params[1]),
      );
      return row === undefined ? [] : [{ attribution_key: row.attribution_key }];
    }

    if (/update spend_reservations/i.test(text)) {
      /* La prolongation porte son `leaseMs` en premier paramètre ; les autres non. */
      const renewing = /set lease_until/i.test(text);
      const row = this.owned(renewing ? params.slice(1) : params);
      if (row === undefined || row.state !== "OPEN") return [];
      if (renewing) row.lease_until = Date.now() + Number(params[0]);
      else row.state = /'SETTLED'/.test(text) ? "SETTLED" : "EXPIRED";
      return [{ id: row.id }];
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

  private live(tenant: string, key: string): FakeReservation[] {
    const now = Date.now();
    return this.reservations.filter(
      (r) =>
        r.tenant_id === tenant &&
        r.attribution_key === key &&
        r.state === "OPEN" &&
        r.lease_until > now,
    );
  }

  /** La ligne désignée par (id, tenant, owner_token) — l'authentification par fencing. */
  private owned(params: readonly unknown[]): FakeReservation | undefined {
    return this.reservations.find(
      (r) =>
        r.id === String(params[0]) &&
        r.tenant_id === String(params[1]) &&
        r.owner_token === String(params[2]),
    );
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

/**
 * Un corps de complétion RÉALISTE. Depuis le verrou C1, un corps non bornable est refusé
 * AVANT d'atteindre le résolveur de plafond, donc un test qui postait `{}` ou rien du tout
 * ne prouvait plus ce qu'il croyait prouver. `max_tokens` déclaré ici est RABAISSÉ, jamais
 * relevé, et la majoration réservée vaut `octets(corps) + marge de gabarit + max_tokens`.
 */
const body = (maxTokens = 50) => JSON.stringify({ model: "test/model", max_tokens: maxTokens });

describe("composeSpendMeters — couture mission : plafonnée par le budget du goal", () => {
  it("contrôle l'appel contre LE budget du goal de la portée, et impute la ligne à ce goal", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    await runWithAttribution({ goalId: "g1" }, () =>
      meters.mission("https://provider.test/v1/chat/completions", { body: body() }),
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

    await expect(
      meters.mission("https://provider.test/v1/chat/completions", { body: body() }),
    ).rejects.toThrow(BudgetDeniedError);
    /* Rien n'est parti, et aucun goal n'a été interrogé : il n'y en avait aucun. */
    expect(calls).toHaveLength(0);
    expect(db.goalLookups).toEqual([]);
  });

  it("refuse l'appel suivant AVANT le fournisseur quand le plafond de tokens est épuisé", async () => {
    const db = new FakeDb({ g1: null });
    const { fetchImpl, calls } = provider(800);
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    const call = () =>
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: body(50) }),
      );

    await call();
    expect(calls).toHaveLength(1);

    /*
     * 800 tokens réellement consommés sur 1 000 : la réservation suivante (≈ 350) ne tient
     * plus. Le refus est désormais RESERVATION_EXCEEDS_CAP et non TOKEN_CAP_REACHED, parce
     * qu'il porte sur ce que l'appel POURRAIT consommer et non sur ce qui l'a déjà été —
     * c'est précisément ce que le pré-vol seul ne savait pas faire.
     */
    await expect(call()).rejects.toMatchObject({
      name: "BudgetDeniedError",
      reason: "RESERVATION_EXCEEDS_CAP",
    });
    /* LE point du lot : le deuxième appel n'a jamais atteint le fournisseur. */
    expect(calls).toHaveLength(1);
  });

  /**
   * LE DÉFAUT CRITIQUE C1, dans sa forme monétaire.
   *
   * AVANT : un goal à budget en EUROS obtenait UN appel — la fenêtre historique était vide,
   * donc `decide` passait, et le prix n'était découvert qu'APRÈS avoir payé. Un test de ce
   * fichier affirmait ce « un appel » comme un comportement correct. Il décrivait en fait le
   * défaut : sous un plafond en euros et une table de prix vide, le premier appel facturant
   * était AUTORISÉ.
   *
   * MAINTENANT : prix inconnu AVANT dispatch = refus. ZÉRO appel. C'est la règle
   * « UNKNOWN_PRICE -> FAIL CLOSED » : on n'autorise pas une dépense parce que l'historique
   * est vide. Le propriétaire ouvre cette vanne en inscrivant de vrais prix, ou en posant un
   * plafond en TOKENS — qui, lui, reste pleinement applicable sans aucun prix.
   */
  it("un goal à budget MONÉTAIRE n'obtient AUCUN appel tant que la table de prix est vide", async () => {
    const db = new FakeDb({ g1: 5_000 });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, inner: fetchImpl });

    await expect(
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: body() }),
      ),
    ).rejects.toMatchObject({ name: "BudgetDeniedError", reason: "UNPRICED_RESERVATION" });

    /* Le tout premier appel facturant n'a jamais atteint le fournisseur. */
    expect(calls).toHaveLength(0);
    expect(db.rows).toHaveLength(0);
  });

  it("refuse un goal inconnu plutôt que d'inventer son plafond", async () => {
    const db = new FakeDb({});
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    await expect(
      runWithAttribution({ goalId: "absent" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: body() }),
      ),
    ).rejects.toMatchObject({ name: "BudgetDeniedError", reason: "NO_ENFORCEABLE_CAP" });
    expect(calls).toHaveLength(0);
  });

  it("sans base, refuse : aucun budget lisible n'est « pas de budget »", async () => {
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ inner: fetchImpl });

    await expect(
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: body() }),
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
    /* 2 000 : assez pour qu'un appel de mission BORNÉ tienne, donc le test porte bien sur
       l'isolation des deux coutures et non sur la taille du plafond. */
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 2_000, inner: fetchImpl });

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
    /* 10 000 tokens de sonde n'épuisent pas le plafond du goal : il reste passant. */
    await expect(
      runWithAttribution({ goalId: "g1" }, () =>
        meters.mission("https://provider.test/v1/chat/completions", { body: body() }),
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
    /* Le planificateur ne déclare AUCUNE sortie maximale : la couture lui en impose une. */
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 50_000, inner: fetchImpl });
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
  /** `FakeDb` tient désormais lui-même les réservations et une transaction. */
  const txDb = (goals: Record<string, number | null> = {}) => new FakeDb(goals);

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
    expect(db.reservations.at(-1)?.tenant_id).toBe(SPEND_LEDGER_TENANT_ID);
  });
});
