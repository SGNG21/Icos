import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { attributionKey } from "@/core/budget/contracts";

import { runWithAttribution } from "./attribution-context";
import {
  composeSpendMeters,
  DEFAULT_SYSTEM_REVIEW_MAX_TOTAL_TOKENS,
  systemReviewCaps,
} from "./compose-spend";
import { BudgetDeniedError } from "./metered-fetch";
import type { SqlExec } from "./postgres-spend-ledger";

/**
 * BUDGET DE RELECTURE SYSTÈME — étroit, borné, et NON CONTOURNABLE (décision du propriétaire).
 *
 * Ce n'est pas un troisième budget d'exécution. C'est la réponse à UN cas : une relecture
 * OBLIGATOIRE d'une mission qui n'a réellement aucun goal. Une relecture indépendante est un
 * contrôle de sûreté ; la refuser faute de budget ne protège rien, cela éteint le contrôle.
 *
 * Tout l'enjeu est qu'on ne puisse pas s'en servir pour échapper au budget d'un goal.
 */

const dialect = new PgDialect();

/** Journal minimal, indexé par clé d'imputation, comme la vraie table. */
class Ledger implements SqlExec {
  readonly rows: Record<string, unknown>[] = [];
  readonly reservations: { id: string; key: string; tokens: number; open: boolean }[] = [];
  constructor(private readonly goals: Record<string, number | null> = {}) {}

  /** Chaîne de transactions : le faux MODÉLISE le verrou que le vrai magasin prend. */
  private tail: Promise<unknown> = Promise.resolve();

  /*
   * Sans sérialisation, quatre `reserve()` simultanées lisent toutes `held = 0` avant que
   * la moindre insertion n'ait lieu — c'est le write skew exact que
   * `pg_advisory_xact_lock` empêche dans le vrai magasin. Un faux qui ne le modélise pas
   * ferait échouer ce test pour une raison qui n'existe pas en production.
   *
   * L'atomicité RÉELLE reste prouvée contre une vraie base
   * (`postgres-spend-reservations.integration.test.ts`) ; ce qui est vérifié ici, c'est
   * l'ARITHMÉTIQUE — que le terme « déjà engagé » est bien compté pour CE budget aussi.
   */
  async transaction<T>(fn: (tx: SqlExec) => Promise<T>): Promise<T> {
    const run = this.tail.then(() => fn(this));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async execute(query: SQL): Promise<unknown> {
    const { sql: text, params } = dialect.sqlToQuery(query);
    if (/pg_advisory_xact_lock/i.test(text)) return [];
    if (/from goals/i.test(text)) {
      const id = String(params[0]);
      return id in this.goals ? [{ budget: this.goals[id] }] : [];
    }
    if (/sum\(reserved_tokens\)/i.test(text)) {
      const held = this.reservations
        .filter((r) => r.open && r.key === String(params[1]))
        .reduce((sum, r) => sum + r.tokens, 0);
      return [{ held: String(held) }];
    }
    if (/insert into spend_reservations/i.test(text)) {
      this.reservations.push({
        id: String(params[0]),
        key: String(params[2]),
        tokens: Number(params[4]),
        open: true,
      });
      return [];
    }
    if (/select attribution_key/i.test(text)) {
      const row = this.reservations.find((r) => r.id === String(params[0]));
      return row ? [{ attribution_key: row.key }] : [];
    }
    if (/update spend_reservations/i.test(text)) {
      const row = this.reservations.find((r) => r.id === String(params[0]));
      if (row) row.open = false;
      return row ? [{ id: row.id }] : [];
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

const URL_ = "https://provider.test/v1/chat/completions";
const body = (maxTokens = 50) => JSON.stringify({ model: "m", max_tokens: maxTokens });

function provider(totalTokens = 100) {
  const calls: string[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    calls.push(String(input));
    return new Response(
      JSON.stringify({
        model: "m",
        usage: { prompt_tokens: totalTokens, completion_tokens: 0, total_tokens: totalTokens },
      }),
      { headers: { "content-type": "application/json" } },
    );
  });
  return { fetchImpl, calls };
}

describe("précédence — le goal gagne toujours, et on ne peut pas descendre", () => {
  it("une imputation qui porte un goal ET une relecture système tombe sur le GOAL", () => {
    /*
     * LA non-contournabilité, au niveau de la clé. Ajouter le champ de relecture système à
     * une imputation qui a un goal ne change RIEN : la fenêtre reste celle du goal. Obtenir
     * le budget souple exigerait qu'aucun goal n'existe — et le goal est lu sur la mission
     * persistée, jamais fourni par l'appelant.
     */
    expect(attributionKey({ goalId: "g1", systemReviewMissionId: "m1" })).toBe("goal=g1");
    expect(attributionKey({ systemReviewMissionId: "m1" })).toBe("system-review=m1");
  });

  it("la relecture système est DERNIÈRE : mission et conversation la précèdent aussi", () => {
    expect(attributionKey({ missionId: "m1", systemReviewMissionId: "m1" })).toBe("mission=m1");
    expect(attributionKey({ conversationId: "c1", systemReviewMissionId: "m1" })).toBe(
      "conversation=c1",
    );
  });

  it("le résolveur de relecture système ne répond QU'À une relecture système", async () => {
    const caps = systemReviewCaps(1_000);
    expect(await caps({ systemReviewMissionId: "m1" })).toEqual({
      kind: "CAPPED",
      maxTotalTokens: 1_000,
    });
    /* Tout le reste : CAPPED sans limite, donc `decide` refuse. */
    for (const other of [{ goalId: "g1" }, { missionId: "m1" }, { brainId: "b" }, null]) {
      expect(await caps(other)).toEqual({ kind: "CAPPED" });
    }
  });
});

describe("relecture d'un goal — budget du GOAL, sans repli", () => {
  it("consomme le budget du goal et écrit dans SA fenêtre", async () => {
    const db = new Ledger({ g1: null });
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 50_000, inner: fetchImpl });

    await runWithAttribution({ goalId: "g1" }, () => meters.mission(URL_, { body: body() }));

    expect(calls).toHaveLength(1);
    expect(db.rows[0]?.attribution_key).toBe("goal=g1");
  });

  it("un budget de goal INAPPLICABLE échoue — il ne retombe JAMAIS sur la relecture système", async () => {
    /*
     * LE test qui compte. Si ce repli existait, « mon goal n'a plus de budget » deviendrait
     * « relis quand même », et le plafond du goal ne voudrait plus rien dire.
     */
    const db = new Ledger({ g1: null });
    const { fetchImpl, calls } = provider();
    /* Aucun plafond de tokens configuré : le budget du goal n'est pas applicable. */
    const meters = composeSpendMeters({ db, inner: fetchImpl });

    await expect(
      runWithAttribution({ goalId: "g1" }, () => meters.mission(URL_, { body: body() })),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    expect(calls).toHaveLength(0);
    /* Et rien n'a été écrit sous une clé de relecture système. */
    expect(db.rows.some((r) => String(r.attribution_key).startsWith("system-review="))).toBe(false);
  });

  it("un appelant NE PEUT PAS retirer le goal pour obtenir le budget souple", async () => {
    /*
     * Au niveau du budget, « retirer le goal » veut dire présenter une imputation de
     * relecture système à la place. Elle ouvre bien SA PROPRE fenêtre — mais c'est une
     * fenêtre différente, strictement plafonnée, et surtout elle ne touche pas au goal :
     * on n'a rien gagné, on a seulement changé de budget borné.
     *
     * Et en production ce choix n'appartient pas à l'appelant : `review-execution.ts` lit
     * `goalId` sur la MISSION PERSISTÉE, pas sur son entrée.
     */
    const db = new Ledger({ g1: 5_000 });
    const { fetchImpl } = provider(10);
    const meters = composeSpendMeters({
      db,
      maxTotalTokensPerGoal: 50_000,
      maxTotalTokensPerSystemReview: 1_000,
      inner: fetchImpl,
    });

    await runWithAttribution({ systemReviewMissionId: "m1" }, () =>
      meters.mission(URL_, { body: body() }),
    );
    /* La dépense est allée dans la fenêtre de relecture, pas dans celle du goal. */
    expect(db.rows[0]?.attribution_key).toBe("system-review=m1");
    expect(db.rows.some((r) => r.attribution_key === "goal=g1")).toBe(false);
  });
});

describe("relecture d'une mission SANS goal — budget de relecture système, borné", () => {
  it("passe, et écrit dans la fenêtre de SA mission", async () => {
    const db = new Ledger();
    const { fetchImpl, calls } = provider(10);
    const meters = composeSpendMeters({ db, inner: fetchImpl });

    await runWithAttribution({ systemReviewMissionId: "m1" }, () =>
      meters.mission(URL_, { body: body() }),
    );
    expect(calls).toHaveLength(1);
    expect(db.rows[0]?.attribution_key).toBe("system-review=m1");
  });

  it("DEUX missions ont DEUX fenêtres : l'une ne consomme pas l'autre", async () => {
    const db = new Ledger();
    const { fetchImpl } = provider(900);
    const meters = composeSpendMeters({
      db,
      maxTotalTokensPerSystemReview: 1_000,
      inner: fetchImpl,
    });
    const review = (m: string) =>
      runWithAttribution({ systemReviewMissionId: m }, () =>
        meters.mission(URL_, { body: body() }),
      );

    await review("m1");
    await expect(review("m1")).rejects.toBeInstanceOf(BudgetDeniedError);
    await expect(review("m2")).resolves.toBeInstanceOf(Response);
  });

  it("DES RELECTURES PARALLÈLES ne peuvent pas dépasser le plafond", async () => {
    /*
     * Même propriété que pour un goal : la réservation est prise AVANT l'appel, donc des
     * relectures simultanées de la même mission se voient mutuellement. L'atomicité réelle
     * est celle de PostgreSQL ; ce qui est vérifié ici, c'est que le terme « déjà engagé »
     * est bien compté pour ce budget aussi.
     */
    const db = new Ledger();
    /*
     * UNE VRAIE COURSE. Sans barrière, chaque appel se solde avant que le suivant ne
     * réserve, donc les engagements ne se voient jamais et le test ne prouverait rien.
     * Le fournisseur retient ici les quatre appels jusqu'à ce qu'ils soient tous partis :
     * les réservations sont alors réellement ouvertes en même temps.
     */
    let release!: () => void;
    const allInFlight = new Promise<void>((resolve) => (release = resolve));
    let inFlight = 0;
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      calls.push(String(input));
      if (++inFlight >= 2) release();
      await allInFlight;
      return new Response(
        JSON.stringify({
          model: "m",
          usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const meters = composeSpendMeters({
      db,
      maxTotalTokensPerSystemReview: 1_200,
      inner: fetchImpl,
    });
    const review = () =>
      runWithAttribution({ systemReviewMissionId: "m1" }, () =>
        meters.mission(URL_, { body: body(300) }),
      );

    const outcomes = await Promise.allSettled([review(), review(), review(), review()]);
    const denied = outcomes.filter(
      (o) => o.status === "rejected" && o.reason instanceof BudgetDeniedError,
    );
    expect(denied.length).toBeGreaterThan(0);
    const reserved = db.reservations.reduce((sum, r) => sum + r.tokens, 0);
    expect(reserved).toBeLessThanOrEqual(1_200);
    expect(calls.length).toBeLessThan(4);
  });

  it("le plafond par défaut est STRICT : une relecture n'est pas un dialogue", () => {
    expect(DEFAULT_SYSTEM_REVIEW_MAX_TOTAL_TOKENS).toBeGreaterThan(0);
    expect(DEFAULT_SYSTEM_REVIEW_MAX_TOTAL_TOKENS).toBeLessThanOrEqual(100_000);
  });
});

describe("le travail ORDINAIRE d'une mission sans goal reste REFUSÉ", () => {
  it("un worker non imputé ne peut pas dépenser", async () => {
    const db = new Ledger();
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 50_000, inner: fetchImpl });

    /* Hors de toute portée : aucune imputation, donc rien à plafonner, donc refus. */
    await expect(meters.mission(URL_, { body: body() })).rejects.toBeInstanceOf(BudgetDeniedError);
    expect(calls).toHaveLength(0);
  });

  it("une imputation de MISSION seule ne donne pas accès au budget de relecture", async () => {
    /*
     * Builder, Research, Evolution et le travail de tâche ordinaire d'une mission sans goal
     * n'ont PAS accès à ce budget : seule la clé `system-review=` l'ouvre, et seule la
     * relecture la pose.
     */
    const db = new Ledger();
    const { fetchImpl, calls } = provider();
    const meters = composeSpendMeters({
      db,
      maxTotalTokensPerSystemReview: 50_000,
      inner: fetchImpl,
    });

    await expect(
      runWithAttribution({ missionId: "m1" }, () => meters.mission(URL_, { body: body() })),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    expect(calls).toHaveLength(0);
  });
});
