import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { attributionKey } from "@/core/budget/contracts";

import { runWithAttribution } from "./attribution-context";
import {
  composeSpendMeters,
  conversationCaps,
  DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS,
} from "./compose-spend";
import { BudgetDeniedError } from "./metered-fetch";
import type { SqlExec } from "./postgres-spend-ledger";

/**
 * DEUX PORTÉES DE BUDGET, ET ELLES NE SE TOUCHENT PAS (décision du propriétaire).
 *
 *   A. CONVERSATION — parler, comprendre une intention, retrouver du contexte, répondre.
 *      Peut tourner SANS aucun goal. Plafond propre, par conversation.
 *   B. EXÉCUTION DE GOAL — planification, tâches, workers, reprises, replans, relectures.
 *      Reste strictement imputé au goal.
 *
 * Ce qui est prouvé ici : le trafic de conversation ne consomme ni ne contourne le budget
 * d'exécution d'un goal, et réciproquement. L'isolation n'est pas une règle appliquée à
 * l'exécution : c'est une conséquence de `attributionKey`, qui range les deux dans des
 * fenêtres différentes. Un test qui ne vérifierait que « le code appelle la bonne couture »
 * raterait précisément le jour où quelqu'un passe la mauvaise imputation.
 */

const dialect = new PgDialect();

/** Journal minimal en mémoire, indexé par clé d'imputation, comme la vraie table. */
class Ledger implements SqlExec {
  readonly rows: Record<string, unknown>[] = [];
  readonly reservations: Record<string, unknown>[] = [];

  async transaction<T>(fn: (tx: SqlExec) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async execute(query: SQL): Promise<unknown> {
    const { sql: text, params } = dialect.sqlToQuery(query);
    if (/pg_advisory_xact_lock/i.test(text)) return [];
    /* Aucun goal n'est lu ici : les plafonds du test sont explicites. */
    if (/from goals/i.test(text)) return [{ budget: null }];
    if (/sum\(reserved_tokens\)/i.test(text)) return [{ held: "0" }];
    if (/insert into spend_reservations/i.test(text)) {
      this.reservations.push({ id: params[0], attribution_key: params[2] });
      return [];
    }
    if (/select attribution_key/i.test(text)) {
      const row = this.reservations.find((r) => r.id === String(params[0]));
      return row ? [{ attribution_key: row.attribution_key }] : [];
    }
    if (/update spend_reservations/i.test(text)) return [{ id: params[0] }];
    if (/^\s*insert/i.test(text)) {
      const columns = /\(([^)]*)\)\s*values/i.exec(text)?.[1] ?? "";
      const row: Record<string, unknown> = {};
      columns.split(",").forEach((name, i) => (row[name.trim()] = params[i] ?? null));
      this.rows.push(row);
      return [];
    }
    /* Relecture de la fenêtre : UNIQUEMENT les lignes de CETTE clé d'imputation. */
    return this.rows.filter((r) => r.tenant_id === params[0] && r.attribution_key === params[1]);
  }
}

const URL_ = "https://provider.test/v1/chat/completions";
const body = (maxTokens = 50) => JSON.stringify({ model: "m", max_tokens: maxTokens });

function provider(totalTokens: number) {
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

describe("isolation des budgets — la conversation n'entame pas le goal", () => {
  it("range les deux trafics dans DEUX fenêtres différentes", () => {
    expect(attributionKey({ conversationId: "c1" })).toBe("conversation=c1");
    expect(attributionKey({ goalId: "g1" })).toBe("goal=g1");
    expect(attributionKey({ conversationId: "c1" })).not.toBe(attributionKey({ goalId: "c1" }));
  });

  it("une imputation qui porte LES DEUX retombe sur le budget du GOAL, le plus strict", () => {
    /*
     * La règle de sécurité du choix de précédence. Si une portée de conversation se
     * retrouvait autour d'un travail de goal, l'ambiguïté doit se résoudre vers la
     * CONTRAINTE, jamais vers la permission : sinon le budget d'exécution se contournerait
     * en ouvrant une conversation autour de lui.
     */
    expect(attributionKey({ goalId: "g1", conversationId: "c1" })).toBe("goal=g1");
  });

  it("CONVERSATION : des appels passent SANS aucun goal, et n'écrivent rien dans un goal", async () => {
    const db = new Ledger();
    const { fetchImpl, calls } = provider(100);
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_000, inner: fetchImpl });

    await runWithAttribution({ conversationId: "c1" }, () =>
      meters.conversation(URL_, { body: body() }),
    );

    expect(calls).toHaveLength(1);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.attribution_key).toBe("conversation=c1");
    /* Rien n'a touché un goal : pas de goal_id, pas de ligne dans une fenêtre de goal. */
    expect(db.rows[0]?.goal_id).toBeNull();
    expect(db.rows.some((r) => String(r.attribution_key).startsWith("goal="))).toBe(false);
  });

  it("la dépense de conversation NE RÉDUIT PAS le budget d'exécution du goal", async () => {
    const db = new Ledger();
    const { fetchImpl } = provider(900);
    /* Plafond de goal serré : 900 tokens de conversation l'épuiseraient s'ils comptaient. */
    const meters = composeSpendMeters({ db, maxTotalTokensPerGoal: 1_500, inner: fetchImpl });

    await runWithAttribution({ conversationId: "c1" }, () =>
      meters.conversation(URL_, { body: body() }),
    );
    /* Le goal n'a rien dépensé : son premier appel de mission doit passer. */
    await expect(
      runWithAttribution({ goalId: "g1" }, () => meters.mission(URL_, { body: body() })),
    ).resolves.toBeInstanceOf(Response);
  });

  it("la dépense d'exécution du goal NE RÉDUIT PAS le budget de conversation", async () => {
    const db = new Ledger();
    const { fetchImpl } = provider(900);
    const meters = composeSpendMeters({
      db,
      maxTotalTokensPerGoal: 1_500,
      maxTotalTokensPerConversation: 1_000,
      inner: fetchImpl,
    });

    await runWithAttribution({ goalId: "g1" }, () => meters.mission(URL_, { body: body() }));
    await expect(
      runWithAttribution({ conversationId: "c1" }, () =>
        meters.conversation(URL_, { body: body() }),
      ),
    ).resolves.toBeInstanceOf(Response);
  });

  it("DEUX conversations ont DEUX budgets : l'une bavarde ne fait pas taire l'autre", async () => {
    const db = new Ledger();
    const { fetchImpl } = provider(900);
    const meters = composeSpendMeters({
      db,
      maxTotalTokensPerConversation: 1_000,
      inner: fetchImpl,
    });

    await runWithAttribution({ conversationId: "c1" }, () =>
      meters.conversation(URL_, { body: body() }),
    );
    /* c1 est maintenant quasiment épuisée ; c2 est intacte. */
    await expect(
      runWithAttribution({ conversationId: "c1" }, () =>
        meters.conversation(URL_, { body: body() }),
      ),
    ).rejects.toBeInstanceOf(BudgetDeniedError);
    await expect(
      runWithAttribution({ conversationId: "c2" }, () =>
        meters.conversation(URL_, { body: body() }),
      ),
    ).resolves.toBeInstanceOf(Response);
  });

  it("la conversation est BORNÉE, jamais illimitée, même sans variable d'environnement", async () => {
    /*
     * La différence avec les frais opérationnels, qui sont `UNCAPPED` par choix nommé : une
     * conversation DOIT avoir une borne. L'absence de configuration donne un défaut large,
     * pas l'absence de plafond.
     */
    expect(
      await conversationCaps(DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS)({ conversationId: "c" }),
    ).toEqual({ kind: "CAPPED", maxTotalTokens: DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS });
    expect(DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_CONVERSATION_MAX_TOTAL_TOKENS)).toBe(true);
  });

  it("hors conversation identifiée, la couture de conversation REFUSE au lieu d'ouvrir", async () => {
    const db = new Ledger();
    const { fetchImpl, calls } = provider(10);
    const meters = composeSpendMeters({ db, inner: fetchImpl });

    await expect(meters.conversation(URL_, { body: body() })).rejects.toBeInstanceOf(
      BudgetDeniedError,
    );
    expect(calls).toHaveLength(0);
  });

  it("la conversation est bornée en SORTIE comme la mission : pas de complétion sans limite", async () => {
    const db = new Ledger();
    const { fetchImpl, calls } = provider(10);
    const meters = composeSpendMeters({ db, inner: fetchImpl });

    /* Aucun corps : la sortie n'est pas bornable, donc l'appel ne part pas. */
    await expect(
      runWithAttribution({ conversationId: "c1" }, () => meters.conversation(URL_, {})),
    ).rejects.toMatchObject({ name: "BudgetDeniedError", reason: "UNBOUNDED_REQUEST" });
    expect(calls).toHaveLength(0);
  });
});
