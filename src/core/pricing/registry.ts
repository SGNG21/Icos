import {
  BUDGET_CURRENCY,
  UNPRICED,
  type BudgetCurrency,
  type TokenUsage,
} from "@/core/budget/contracts";

/**
 * REGISTRE DE PRIX — l'unique autorité de tarif d'ICOS. Pur : ni horloge globale, ni E/S.
 *
 * Ce module ne contient AUCUN prix. Il contient l'architecture qui permet au propriétaire
 * d'en déposer de vrais et de les faire appliquer, et qui empêche un tarif douteux de
 * devenir en silence un montant auquel quelqu'un fait confiance.
 *
 * Trois règles portent tout le reste :
 *  1. UNKNOWN_PRICE est EXPLICITE. Jamais un défaut, jamais 0, jamais interpolé depuis un
 *     modèle frère. Un appel sans prix n'est pas gratuit : il est non chiffrable.
 *  2. LA FRAÎCHEUR EST UN FAIT DE PREMIÈRE CLASSE. Un tarif daté du futur, ou passé son
 *     horizon de fraîcheur, rend UNKNOWN_PRICE — pas un montant « presque juste ».
 *  3. L'ARGENT EST UN ENTIER DE MICROS. Aucun flottant monétaire ici. La division par
 *     {@link MICROS_PER_UNIT} n'a lieu qu'à la frontière héritée ({@link microsToAmount}).
 */

/**
 * Unité monétaire interne : le MICRO, soit un millionième d'une unité de
 * {@link BUDGET_CURRENCY}. Toute somme manipulée ici est un entier de micros.
 *
 * Choix de nom assumé pour ce lot : `micros`, et non `cents`. Un appel de 1 000 tokens à
 * 3 EUR/Mtok coûte 0,3 centime — en centimes il s'arrondirait à 0 et le plafond ne mordrait
 * jamais. (`financialCents` de `core/workforce` est une autre couche, non reliée.)
 */
export const MICROS_PER_UNIT = 1_000_000;

/** Nombre de tokens couvert par un tarif : un tarif est donné « par million ». */
export const TOKENS_PER_RATE_UNIT = 1_000_000;

/** Garde-fou de saisie : au-delà, c'est une faute de frappe, pas un tarif. */
const MAX_MICROS_PER_MILLION = 100_000 * MICROS_PER_UNIT;

const DAY_MS = 86_400_000;

/**
 * Prix indisponible ou indigne de confiance.
 *
 * MÊME VALEUR que {@link UNPRICED} : un seul mot circule sur le fil et dans la base. Deux
 * chaînes pour un même fait créeraient deux vocabulaires, donc deux autorités, et un
 * consommateur qui n'en connaîtrait qu'une lirait « chiffré ».
 */
export const UNKNOWN_PRICE = UNPRICED;
export type UnknownPrice = typeof UNKNOWN_PRICE;

/** Pourquoi un prix n'est pas utilisable. Lisible par la machine, pas seulement par l'humain. */
export const PRICE_DEFECTS = [
  /** Aucune entrée pour ce modèle. */
  "ABSENT",
  /** Plusieurs entrées concurrentes : on n'en choisit aucune. */
  "AMBIGUOUS",
  /** Entrée présente mais inexploitable (tarif, devise, provenance, dates). */
  "INVALID_ENTRY",
  /** `effectiveAt` est dans le futur. */
  "NOT_YET_EFFECTIVE",
  /** `staleAfter` est atteint : tarif périmé. */
  "STALE",
  /** Le fournisseur facture des tokens sans tarif ici (raisonnement, cache). */
  "UNPRICED_TOKENS",
  /** Le montant exact ne tient pas dans un entier sûr. */
  "NOT_REPRESENTABLE",
  /** Horloge illisible : la fraîcheur n'est pas vérifiable. */
  "UNUSABLE_CLOCK",
] as const;
export type PriceDefect = (typeof PRICE_DEFECTS)[number];

/**
 * Un tarif, avec de quoi décider s'il est digne de confiance. Tous les champs sont requis :
 * un prix sans provenance ni date est précisément le prix qu'il ne faut pas appliquer.
 */
export interface PriceRecord {
  /** Fournisseur facturant (passerelle ou éditeur). */
  readonly provider: string;
  readonly modelId: string;
  readonly currency: BudgetCurrency;
  /** Prix de 1 000 000 de tokens de prompt, en micros ENTIERS. */
  readonly promptMicrosPerMillion: number;
  /** Prix de 1 000 000 de tokens de complétion, en micros ENTIERS. */
  readonly completionMicrosPerMillion: number;
  /** D'où vient ce prix : facture, page de tarif, contrat. Jamais « de mémoire ». */
  readonly provenance: string;
  /** Instant ISO à partir duquel ce tarif s'applique. */
  readonly effectiveAt: string;
  /**
   * Instant ISO à partir duquel ce tarif n'est plus digne de confiance. La fraîcheur est
   * portée par l'entrée, pas déduite d'un horizon global : un contrat peut valoir un an,
   * une page de tarif publique quelques semaines. {@link staleAfterFrom} en calcule un par
   * défaut quand le propriétaire n'a pas de date d'expiration sous la main.
   */
  readonly staleAfter: string;
}

export type PriceRegistry = readonly PriceRecord[];

/**
 * VIDE VOLONTAIREMENT. C'est le point de dépôt du propriétaire.
 *
 * Aucun tarif de modèle réel n'est écrit ici : inscrire un prix OmniRoute, NVIDIA, OpenAI
 * ou Anthropic « de mémoire » serait une fabrication, et un plafond monétaire calculé sur un
 * prix inventé est pire qu'un plafond absent — quelqu'un budgéterait de l'argent réel dessus.
 *
 * Tant que ce registre est vide, tout appel est UNKNOWN_PRICE : aucun plafond monétaire ne
 * peut être déclaré satisfait, et seul un plafond en tokens est applicable. C'est l'état
 * honnête du système, et il doit le rester jusqu'à ce qu'une facture ou une page de tarif
 * fournisse une ligne complète (provenance + effectiveAt + staleAfter).
 */
export const ICOS_PRICE_REGISTRY: PriceRegistry = Object.freeze([]);

/**
 * Horizon de fraîcheur par défaut. Il n'est appliqué nulle part d'office : il ne sert qu'à
 * calculer un `staleAfter` quand le propriétaire inscrit un tarif sans date d'expiration.
 */
export const DEFAULT_FRESHNESS_DAYS = 90;

/** Péremption déduite d'une date d'entrée en vigueur. Lève si la date est illisible. */
export function staleAfterFrom(effectiveAt: string, days = DEFAULT_FRESHNESS_DAYS): string {
  const from = Date.parse(effectiveAt);
  if (!Number.isFinite(from)) throw new Error(`effectiveAt illisible : ${effectiveAt}`);
  return new Date(from + days * DAY_MS).toISOString();
}

/** `null` si l'entrée est exploitable, sinon le motif du refus. */
export function recordDefect(record: PriceRecord): string | null {
  if (record.modelId.trim().length === 0) return "modelId absent";
  if (record.provider.trim().length === 0) return "provider absent";
  if (record.currency !== BUDGET_CURRENCY) return `devise ${record.currency} non supportée`;
  for (const [label, value] of [
    ["promptMicrosPerMillion", record.promptMicrosPerMillion],
    ["completionMicrosPerMillion", record.completionMicrosPerMillion],
  ] as const) {
    /*
     * STRICTEMENT positif et ENTIER. Un 0 n'est pas un prix : c'est un placeholder ou une
     * faute de frappe, et l'accepter rendrait le modèle gratuit pour toujours tout en le
     * comptant comme chiffré — plus aucun plafond monétaire ne mordrait. Un négatif
     * créditerait la fenêtre. Un non-entier ramènerait le flottant dans la monnaie.
     */
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MICROS_PER_MILLION) {
      return `${label} invalide`;
    }
  }
  if (record.provenance.trim().length === 0) return "provenance absente";
  const from = Date.parse(record.effectiveAt);
  const until = Date.parse(record.staleAfter);
  if (!Number.isFinite(from)) return `effectiveAt illisible : ${record.effectiveAt}`;
  if (!Number.isFinite(until)) return `staleAfter illisible : ${record.staleAfter}`;
  if (until <= from) return "staleAfter n'est pas postérieur à effectiveAt";
  return null;
}

/**
 * Modèles portés par plusieurs entrées. Deux tarifs concurrents pour un même modèle ne
 * désignent pas un gagnant : en choisir un (le premier, le dernier) serait arbitraire et
 * silencieux. Aucun des deux n'est utilisable.
 */
export function ambiguousModelIds(registry: PriceRegistry): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const record of registry) {
    if (seen.has(record.modelId)) duplicated.add(record.modelId);
    else seen.add(record.modelId);
  }
  return duplicated;
}

export interface UnknownPriceOutcome {
  readonly kind: UnknownPrice;
  readonly modelId: string;
  readonly defect: PriceDefect;
  readonly reason: string;
}

export type PriceResolution =
  { readonly kind: "PRICE"; readonly record: PriceRecord } | UnknownPriceOutcome;

export type CostMicrosOutcome =
  | { readonly kind: "COST_MICROS"; readonly currency: BudgetCurrency; readonly micros: number }
  | UnknownPriceOutcome;

const unknown = (modelId: string, defect: PriceDefect, reason: string): UnknownPriceOutcome => ({
  kind: UNKNOWN_PRICE,
  modelId,
  defect,
  reason,
});

/** Le tarif applicable à `modelId` à l'instant `now`, ou le motif précis de son absence. */
export function resolvePrice(registry: PriceRegistry, modelId: string, now: Date): PriceResolution {
  if (ambiguousModelIds(registry).has(modelId)) {
    return unknown(modelId, "AMBIGUOUS", "plusieurs tarifs concurrents : aucun n'est choisi");
  }
  const record =
    modelId.trim().length === 0 ? undefined : registry.find((r) => r.modelId === modelId);
  if (!record) return unknown(modelId, "ABSENT", "modèle absent du registre de prix");

  const defect = recordDefect(record);
  if (defect) return unknown(modelId, "INVALID_ENTRY", `entrée de prix inutilisable : ${defect}`);

  const at = now.getTime();
  /*
   * `NaN >= staleAfter` est FAUX : sans ce garde-fou, une horloge illisible ferait passer
   * n'importe quel tarif périmé pour utilisable. Fermé par défaut.
   */
  if (!Number.isFinite(at)) {
    return unknown(modelId, "UNUSABLE_CLOCK", "horloge illisible : fraîcheur invérifiable");
  }
  if (at < Date.parse(record.effectiveAt)) {
    return unknown(
      modelId,
      "NOT_YET_EFFECTIVE",
      `tarif applicable à partir de ${record.effectiveAt}`,
    );
  }
  if (at >= Date.parse(record.staleAfter)) {
    return unknown(modelId, "STALE", `tarif périmé depuis ${record.staleAfter} : non appliqué`);
  }
  return { kind: "PRICE", record };
}

/**
 * Coût d'une consommation mesurée, en micros ENTIERS.
 *
 * Un tarif ne connaît que le prompt et la complétion. Quand le fournisseur facture PLUS que
 * prompt + completion (tokens de raisonnement, tokens de cache), le reste n'a pas de tarif
 * ici — et on ne lui en invente pas un, pas même 0. Le coût n'est alors pas prouvable.
 */
export function costMicros(record: PriceRecord, usage: TokenUsage): CostMicrosOutcome {
  const { modelId } = record;
  for (const [label, value] of [
    ["promptTokens", usage.promptTokens],
    ["completionTokens", usage.completionTokens],
    ["totalTokens", usage.totalTokens],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return unknown(modelId, "NOT_REPRESENTABLE", `${label} inexploitable : ${String(value)}`);
    }
  }

  const billedWithoutPrice = usage.totalTokens - (usage.promptTokens + usage.completionTokens);
  if (billedWithoutPrice > 0) {
    return unknown(
      modelId,
      "UNPRICED_TOKENS",
      `${billedWithoutPrice} tokens facturés sans tarif (total ${usage.totalTokens} > prompt+completion)`,
    );
  }

  const numerator =
    usage.promptTokens * record.promptMicrosPerMillion +
    usage.completionTokens * record.completionMicrosPerMillion;
  if (!Number.isSafeInteger(numerator)) {
    return unknown(modelId, "NOT_REPRESENTABLE", "coût hors de l'entier sûr : aucun montant exact");
  }

  /*
   * Division ENTIÈRE : on retire d'abord le reste pour que le quotient soit exactement
   * représentable (`numerator / TOKENS_PER_RATE_UNIT` en flottant peut tomber juste sous un
   * entier et un `Math.ceil` direct se tromperait d'un micro). Reste non nul => micro
   * SUPÉRIEUR : sous un plafond, surestimer est le sens sûr, et un coût réel ne doit jamais
   * s'arrondir à zéro.
   */
  const remainder = numerator % TOKENS_PER_RATE_UNIT;
  const whole = (numerator - remainder) / TOKENS_PER_RATE_UNIT;
  return {
    kind: "COST_MICROS",
    currency: BUDGET_CURRENCY,
    micros: remainder === 0 ? whole : whole + 1,
  };
}

/** Résolution du tarif puis chiffrage, en un appel. Le chemin normal des appelants. */
export function priceUsageMicros(
  registry: PriceRegistry,
  modelId: string,
  usage: TokenUsage,
  now: Date,
): CostMicrosOutcome {
  const resolved = resolvePrice(registry, modelId, now);
  if (resolved.kind !== "PRICE") return resolved;
  return costMicros(resolved.record, usage);
}

/**
 * SEUL endroit où la monnaie redevient un flottant, pour la frontière héritée
 * (`CostOutcome.amount`, en unités de {@link BUDGET_CURRENCY}). Tout calcul reste en micros.
 */
export function microsToAmount(micros: number): number {
  return micros / MICROS_PER_UNIT;
}
