import { randomUUID } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";

import {
  attributionKey,
  UNMETERED,
  UNPRICED,
  type Attribution,
  type BudgetCurrency,
  type SpendDecision,
  type UnmeteredReason,
} from "@/core/budget/contracts";
import { ICOS_PRICE_TABLE, priceUsage, type PriceTable } from "@/core/budget/price-table";
import {
  accumulate,
  decide,
  emptyWindow,
  type SpendObservation,
  type SpendWindow,
} from "@/core/budget/spend";

import type { BudgetCapResolver, SpendEntry, SpendLedgerPort } from "./ports";

/**
 * Compteur de dépense DURABLE (verrou d'autonomie B1), table `spend_ledger`
 * (migration 0055_spend_ledger.sql).
 *
 * `InMemorySpendLedger` perd tout au redémarrage : une boucle de crash dépenserait donc sans
 * aucune borne alors que le système prétend appliquer un budget. Ce journal ferme exactement
 * ce trou, et SEULEMENT celui-là : les décisions restent prises par `decide`, l'accumulation
 * par `accumulate`, le chiffrage par `priceUsage`. Aucune seconde autorité n'est créée — en
 * particulier la fenêtre n'est PAS agrégée en SQL (voir « repliement » plus bas).
 *
 * ── LA QUESTION DE LA CONCURRENCE ───────────────────────────────────────────────────────
 * `checkBudget()` est un contrôle PRÉ-vol et `record()` n'arrive qu'après la réponse du
 * fournisseur. Deux appelants simultanés peuvent donc passer le contrôle avant que l'un des
 * deux n'enregistre, et dépasser le plafond. Choix assumé : **(a) dépassement BORNÉ ET
 * DOCUMENTÉ**, pas (b) réservation atomique.
 *
 * POURQUOI PAS (b). Réserver « du budget » au contrôle supposerait de connaître la
 * consommation de l'appel qu'on s'apprête à faire. Elle est inconnue avant la réponse du
 * fournisseur : il n'y a donc aucun montant honnête à réserver, et réserver une estimation
 * inventée appliquerait un plafond fabriqué — exactement ce que la règle « une absence n'est
 * jamais un zéro » interdit. La seule quantité réellement réservable est un JETON d'appel en
 * vol, qui borne un nombre d'appels et non une dépense : c'est la même classe de borne que
 * (a), au prix d'un cycle de vie mutable (réserver / solder / expirer les jetons fuités par
 * un crash) dans une table par ailleurs append-only. (b) coûterait donc plus cher pour une
 * garantie de même nature.
 *
 * LA BORNE EXACTE, HONNÊTEMENT. Pour une imputation donnée, à tout instant :
 *   dépassement ≤ la consommation des appels DÉJÀ EN VOL au moment du dernier contrôle
 *                 passant, soit AU PLUS UN appel par appelant simultané.
 * Donc : W appelants qui contrôlent simultanément avant tout enregistrement obtiennent W
 * autorisations, et la fenêtre peut finir à `plafond + consommation de ces W appels`. La
 * borne est en NOMBRE D'APPELS (W), jamais en euros ni en tokens, puisque la consommation
 * d'un appel n'est pas connue avant qu'il réponde. **Avec beaucoup de workers parallèles le
 * dépassement est donc grand** : il croît avec le parallélisme, il n'est pas constant. Ce
 * plafond est un ARRÊT (« on s'arrête en W appels »), pas une garantie de non-dépassement.
 *
 * CE QUI FAIT TENIR LA BORNE À W PLUTÔT QU'À L'INFINI : aucun total n'est gardé en mémoire.
 * Chaque `checkBudget` relit les lignes. Un cache par processus — comme celui de
 * l'implémentation en mémoire — donnerait à chaque processus sa propre fenêtre et le
 * dépassement ne serait borné par rien du tout, pour toujours. C'est la propriété testée.
 *
 * ── FERMÉ PAR DÉFAUT ────────────────────────────────────────────────────────────────────
 * Une erreur de base pendant `checkBudget` est un REFUS, jamais une autorisation, y compris
 * sous un plafond UNCAPPED : si le journal est illisible, `record` échouera aussi, et
 * `meteredFetch` ne lèverait alors `BudgetLedgerError` qu'APRÈS que le fournisseur a facturé.
 * Refuser en amont évite de dépenser ce qu'on ne pourra pas comptabiliser.
 * Une erreur pendant `record` remonte telle quelle (comme le journal en mémoire) : l'avaler
 * ferait de ce compteur un compteur ouvert.
 *
 * ── REPLIEMENT PLUTÔT QU'AGRÉGAT SQL ────────────────────────────────────────────────────
 * `windowFor` relit les lignes et les replie par `accumulate`, l'autorité unique de
 * l'accumulation. Réécrire ces règles en SQL (sommes, `count(… ) filter`, saturation)
 * créerait une seconde autorité qui dériverait en silence du jour où `accumulate` change.
 * Plafond assumé : coût O(lignes de l'imputation) à chaque contrôle. Si une imputation
 * dépasse quelques milliers d'appels, la suite est un INSTANTANÉ périodique replié par le
 * même `accumulate`, pas une somme SQL parallèle.
 */

/** Le minimum dont ce journal a besoin d'une base : exécuter une requête. */
export type SqlExec = { execute(query: SQL): Promise<unknown> };

type Row = Record<string, unknown>;

export interface PostgresSpendLedgerOptions {
  readonly db: SqlExec;
  /** CLÉ TENANT de `spend_ledger`. Prédicat obligatoire de toute lecture et écriture. */
  readonly tenantId: string;
  readonly caps: BudgetCapResolver;
  readonly priceTable?: PriceTable;
  /** Identifiant de ligne. Injectable pour les tests ; jamais une valeur par défaut muette. */
  readonly newId?: () => string;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : "cause inconnue");

/** Un entier rapporté par la base. Une valeur illisible devient NaN, donc fenêtre saturée. */
const count = (value: unknown) => Number(value);

/**
 * Reconstruit l'observation portée par une ligne. Une ligne UNMETERED a ses compteurs à NULL
 * et redevient UNMETERED : elle ne peut pas se relire en « 0 token ». Un vrai zéro mesuré
 * redevient METERED avec trois zéros, et reste donc distinguable pour toujours.
 */
function toObservation(row: Row): SpendObservation {
  const modelId = String(row.model_id);
  if (row.usage_kind === UNMETERED) {
    return {
      modelId,
      usage: { kind: UNMETERED, reason: row.unmetered_reason as UnmeteredReason },
    };
  }
  const usage = {
    promptTokens: count(row.prompt_tokens),
    completionTokens: count(row.completion_tokens),
    totalTokens: count(row.total_tokens),
  };
  if (row.cost_kind === UNPRICED) {
    return {
      modelId,
      usage: { kind: "METERED", usage },
      cost: { kind: UNPRICED, modelId, reason: String(row.unpriced_reason) },
    };
  }
  return {
    modelId,
    usage: { kind: "METERED", usage },
    cost: {
      kind: "COST",
      currency: row.currency as BudgetCurrency,
      amount: Number(row.amount),
    },
  };
}

export class PostgresSpendLedger implements SpendLedgerPort {
  private readonly priceTable: PriceTable;
  private readonly tenantId: string;
  private readonly newId: () => string;

  constructor(private readonly options: PostgresSpendLedgerOptions) {
    /* Pas de contexte tenant -> pas d'opération tenant. Refus à la construction. */
    const tenantId = options.tenantId.trim();
    if (tenantId.length === 0) {
      throw new Error("PostgresSpendLedger: tenantId requis (pas de tenant, pas de journal)");
    }
    this.tenantId = tenantId;
    this.priceTable = options.priceTable ?? ICOS_PRICE_TABLE;
    this.newId = options.newId ?? randomUUID;
  }

  async checkBudget(attribution: Attribution | null): Promise<SpendDecision> {
    let window: SpendWindow;
    try {
      window = await this.windowFor(attribution);
    } catch (cause) {
      /* Journal illisible = dépense invérifiable = refus. Même sous UNCAPPED. */
      return {
        kind: "DENY",
        reason: "UNUSABLE_WINDOW",
        detail: `journal de dépense illisible : ${message(cause)}`,
      };
    }
    try {
      return decide(window, await this.options.caps(attribution));
    } catch (cause) {
      /* Plafond introuvable = plafond inconnu = refus. Même formulation qu'en mémoire. */
      return {
        kind: "DENY",
        reason: "NO_ENFORCEABLE_CAP",
        detail: `plafond non résolu : ${message(cause)}`,
      };
    }
  }

  /**
   * Une ligne immuable par observation. Le coût est chiffré ICI, au moment du constat, et
   * persisté : la ligne est une preuve datée, qu'un changement ultérieur de la table de prix
   * ne doit pas réécrire. Aucun UPDATE, aucun DELETE n'est émis par ce journal.
   */
  async record(entry: SpendEntry): Promise<void> {
    const metered = entry.usage.kind === UNMETERED ? null : entry.usage.usage;
    const cost = metered === null ? undefined : priceUsage(this.priceTable, entry.modelId, metered);

    await this.options.db.execute(sql`
      insert into spend_ledger (
        id, tenant_id, attribution_key, mission_id, goal_id, brain_id, model_id,
        usage_kind, prompt_tokens, completion_tokens, total_tokens, unmetered_reason,
        cost_kind, currency, amount, unpriced_reason, observed_at
      ) values (
        ${this.newId()},
        ${this.tenantId},
        ${attributionKey(entry.attribution)},
        ${entry.attribution?.missionId ?? null},
        ${entry.attribution?.goalId ?? null},
        ${entry.attribution?.brainId ?? null},
        ${entry.modelId},
        ${entry.usage.kind},
        ${metered?.promptTokens ?? null},
        ${metered?.completionTokens ?? null},
        ${metered?.totalTokens ?? null},
        ${entry.usage.kind === UNMETERED ? entry.usage.reason : null},
        ${cost?.kind ?? null},
        ${cost?.kind === "COST" ? cost.currency : null},
        ${cost?.kind === "COST" ? cost.amount : null},
        ${cost?.kind === UNPRICED ? cost.reason : null},
        ${entry.at}
      )
    `);
  }

  async windowFor(attribution: Attribution | null): Promise<SpendWindow> {
    const rows = (await this.options.db.execute(sql`
      select model_id, usage_kind, prompt_tokens, completion_tokens, total_tokens,
             unmetered_reason, cost_kind, currency, amount
        from spend_ledger
       where tenant_id = ${this.tenantId}
         and attribution_key = ${attributionKey(attribution)}
       order by recorded_at, id
    `)) as unknown as Row[];

    return rows.reduce((window, row) => accumulate(window, toObservation(row)), emptyWindow());
  }
}
