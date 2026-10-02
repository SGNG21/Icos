import { sql } from "drizzle-orm";

import { eurToMicros, type BudgetCap } from "@/core/budget/contracts";

import type { BudgetCapResolver } from "./ports";
import type { SqlExec } from "./postgres-spend-ledger";

/**
 * Résout le plafond d'une imputation depuis le budget PERSISTÉ du goal (`goals.budget`).
 *
 * Ce que la colonne est réellement (voir `schema.ts` et `core/contracts/high-level-goal.ts`) :
 * `doublePrecision` NULLABLE, `z.number().nonnegative().optional()`, SANS unité déclarée,
 * SANS colonne de tokens compagnon, et jamais appliquée jusqu'ici. Trois conséquences, toutes
 * assumées explicitement plutôt que devinées :
 *
 * 1. UN BUDGET NULL N'EST NI « SANS PLAFOND » NI ZÉRO. `BudgetCap` est une union discriminée
 *    dans laquelle `UNCAPPED` doit être CHOISI : l'absence de plafond ne se déduit jamais d'un
 *    champ manquant, et ce résolveur ne renvoie JAMAIS `UNCAPPED`. Un budget NULL rend un
 *    plafond `CAPPED` sans limite monétaire. S'il ne porte alors aucune limite du tout,
 *    `decide` le refuse en `NO_ENFORCEABLE_CAP` — fermé par défaut, comme « pas de permission
 *    explicite -> refus ». C'est volontairement visible : un goal sans budget ne dépense pas.
 *
 * 2. L'UNITÉ EST UNE HYPOTHÈSE, ET ELLE N'A QU'UNE SEULE SOURCE :
 *    {@link GOAL_BUDGET_UNITS_PER_EUR}. Rien dans le dépôt ne dit si la colonne est en euros
 *    ou en centimes — ni la colonne, ni le schéma Zod, ni l'API, ni `core/supervisor/priority.ts`
 *    qui s'en sert comme d'une simple échelle. Le propriétaire corrige en UN endroit.
 *
 *    CE FICHIER EST LA FRONTIÈRE DES UNITÉS (P0-C). `goals.budget` est un `doublePrecision`
 *    NULLABLE sans unité déclarée : c'est, en l'état, une valeur d'ORIGINE INCONNUE, gardée
 *    LISIBLE pour compatibilité ascendante et rien de plus. Elle est convertie ICI, une seule
 *    fois, en MICRO-EUROS ENTIERS (`maxCostMicros`) ; aucune couche en aval ne compare plus
 *    jamais un flottant monétaire. Un budget qu'on ne peut pas exprimer en entier n'est PAS
 *    traité comme une absence de plafond : il devient un plafond INVALIDE, donc un refus nommé.
 *    Et comme la table de prix est vide, un plafond monétaire reste AUJOURD'HUI inapplicable :
 *    `decide` le refuse en `UNPRICED_USAGE_IN_WINDOW` et une réservation en
 *    `UNPRICED_RESERVATION`. On ne prétend donc nulle part que `goals.budget` est appliqué.
 *
 * 3. UN PLAFOND DE TOKENS DOIT ÊTRE EXPRIMABLE. La table de prix (`ICOS_PRICE_TABLE`) est
 *    VIDE, donc tout appel est UNPRICED et aucun plafond MONÉTAIRE ne peut être déclaré
 *    satisfait : le seul plafond réellement applicable aujourd'hui est en tokens. Comme
 *    `goals` n'a pas de colonne de tokens, ce plafond est une option de configuration du
 *    propriétaire, `maxTotalTokensPerGoal`, et non une valeur inventée par ligne.
 *
 * Il n'y a pas de port à une seule méthode ici : `BudgetCapResolver` est déjà une fonction.
 */

/**
 * HYPOTHÈSE D'UNITÉ, SOURCE UNIQUE. `goals.budget` est lu comme étant exprimé en
 * `BUDGET_CURRENCY` (EUR), facteur 1. Si une facture ou l'interface établit que la
 * colonne est en CENTIMES, mettre 100 ICI et nulle part ailleurs. Aucune autre ligne de code
 * ne connaît l'unité de cette colonne.
 */
export const GOAL_BUDGET_UNITS_PER_EUR = 1;

export interface GoalBudgetCapResolverOptions {
  readonly db: SqlExec;
  /**
   * Plafond de tokens appliqué à CHAQUE goal, posé par le propriétaire. Absent = aucun
   * plafond de tokens, donc un goal sans budget monétaire n'a aucun plafond applicable et
   * tout appel lui est refusé.
   */
  readonly maxTotalTokensPerGoal?: number;
}

/**
 * `CAPPED` sans aucune limite : `decide` le refuse en `NO_ENFORCEABLE_CAP`. C'est la seule
 * façon de dire « je n'ai pas pu établir de plafond » dans le vocabulaire existant, sans
 * ajouter quoi que ce soit au contrat — et elle refuse.
 */
const NO_RESOLVABLE_CAP: BudgetCap = { kind: "CAPPED" };

type Row = Record<string, unknown>;

/**
 * `goals.id` est la colonne d'identité : `goalToRow` écrit la même valeur dans `id` et dans
 * `goalId`, et `GoalRepository.getById` interroge `goals.id`. On suit cette autorité.
 * `goals` ne porte pas de `tenant_id` dans ce schéma — constat, non invention : aucun
 * prédicat de tenant n'est donc ajouté ici.
 */
export function createGoalBudgetCapResolver(
  options: GoalBudgetCapResolverOptions,
): BudgetCapResolver {
  const tokenCap =
    options.maxTotalTokensPerGoal === undefined
      ? {}
      : { maxTotalTokens: options.maxTotalTokensPerGoal };

  return async (attribution) => {
    const goalId = attribution?.goalId?.trim();
    /* Aucun goal imputé : aucun budget du propriétaire à appliquer, donc refus. */
    if (!goalId) return NO_RESOLVABLE_CAP;

    const rows = (await options.db.execute(sql`
      select budget from goals where id = ${goalId} limit 1
    `)) as unknown as Row[];

    const row = rows[0];
    /* Goal inconnu : on n'invente pas son plafond. */
    if (!row) return NO_RESOLVABLE_CAP;

    const budget = row.budget;
    if (budget === null || budget === undefined) {
      /* NULL : ni UNCAPPED, ni 0. Seul le plafond de tokens du propriétaire reste. */
      return { kind: "CAPPED", ...tokenCap };
    }

    /*
     * Une valeur présente est transmise TELLE QUELLE (à l'unité près). Un 0 ou un négatif
     * persistés — `nonnegative()` autorise 0 — ne sont pas « corrigés » en absence de
     * plafond : `decide` les refuse en `INVALID_CAP`, donc rien ne part. C'est le résultat
     * voulu, et il est visible dans le motif du refus.
     */
    /*
     * Conversion de frontière, une seule fois. Un budget illisible ou non fini ne devient
     * pas une absence de plafond : `NaN` n'est pas un entier sûr, donc `decide` le refuse en
     * `INVALID_CAP` — un refus nommé plutôt qu'un plafond disparu.
     */
    return {
      kind: "CAPPED",
      maxCostMicros: eurToMicros(Number(budget) / GOAL_BUDGET_UNITS_PER_EUR) ?? Number.NaN,
      ...tokenCap,
    };
  };
}
