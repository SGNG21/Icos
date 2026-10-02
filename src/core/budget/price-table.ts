import {
  BUDGET_CURRENCY,
  UNPRICED,
  type BudgetCurrency,
  type CostOutcome,
  type TokenUsage,
} from "./contracts";

/**
 * Table de prix explicite, par identifiant de modèle, en {@link BUDGET_CURRENCY}.
 *
 * Un modèle absent rend UNPRICED. Il n'y a pas de prix par défaut et pas de 0 :
 * un appel UNPRICED consomme quand même le budget en tokens et doit être rapporté.
 */

export interface PriceEntry {
  /** Doit être égal à la clé qui porte l'entrée (garde contre les copier-coller). */
  readonly modelId: string;
  readonly currency: BudgetCurrency;
  /** Prix pour 1 000 000 de tokens de prompt. */
  readonly promptPerMillion: number;
  /** Prix pour 1 000 000 de tokens de complétion. */
  readonly completionPerMillion: number;
  /** D'où vient ce prix : facture, page de tarif, contrat. Jamais « de mémoire ». */
  readonly provenance: string;
  /** Date de constat du prix, ISO `YYYY-MM-DD`. */
  readonly asOf: string;
}

export type PriceTable = Readonly<Record<string, PriceEntry>>;

const TOKENS_PER_PRICE_UNIT = 1_000_000;

/**
 * VIDE VOLONTAIREMENT.
 *
 * Aucun prix de modèle réel n'est inscrit ici : écrire un tarif OmniRoute de mémoire serait
 * une fabrication, et un plafond monétaire calculé sur un prix inventé est pire qu'absent.
 * Tant que cette table est vide, tout appel est UNPRICED — donc aucun plafond monétaire ne
 * peut être déclaré satisfait, et seul un plafond en tokens est applicable. C'est l'état
 * honnête du système. Le propriétaire remplit la table depuis une facture ou la page de
 * tarif OmniRoute, chaque entrée portant sa provenance et sa date.
 */
export const ICOS_PRICE_TABLE: PriceTable = {};

const MAX_PRICE_PER_MILLION = 100_000;

/** `null` si l'entrée est utilisable, sinon le motif du refus. */
function entryDefect(key: string, entry: PriceEntry): string | null {
  if (entry.modelId !== key) return `entrée ${entry.modelId} rangée sous la clé ${key}`;
  if (entry.currency !== BUDGET_CURRENCY) return `devise ${entry.currency} non supportée`;
  for (const [label, value] of [
    ["promptPerMillion", entry.promptPerMillion],
    ["completionPerMillion", entry.completionPerMillion],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > MAX_PRICE_PER_MILLION) {
      return `${label} invalide`;
    }
  }
  if (entry.provenance.trim().length === 0) return "provenance absente";
  if (entry.asOf.trim().length === 0) return "asOf absent";
  return null;
}

/**
 * Chiffre une consommation mesurée. Seuls prompt et completion sont facturés : les tokens
 * au-delà (raisonnement, cache) n'ont pas de prix propre dans cette table, donc on ne leur
 * en invente pas un.
 */
export function priceUsage(table: PriceTable, modelId: string, usage: TokenUsage): CostOutcome {
  const entry = Object.prototype.hasOwnProperty.call(table, modelId) ? table[modelId] : undefined;
  if (!entry) {
    return { kind: UNPRICED, modelId, reason: "modèle absent de la table de prix" };
  }

  const defect = entryDefect(modelId, entry);
  if (defect) return { kind: UNPRICED, modelId, reason: `entrée de prix inutilisable : ${defect}` };

  const amount =
    (usage.promptTokens * entry.promptPerMillion) / TOKENS_PER_PRICE_UNIT +
    (usage.completionTokens * entry.completionPerMillion) / TOKENS_PER_PRICE_UNIT;

  if (!Number.isFinite(amount) || amount < 0) {
    return { kind: UNPRICED, modelId, reason: "coût calculé non exploitable" };
  }

  return { kind: "COST", currency: BUDGET_CURRENCY, amount };
}
