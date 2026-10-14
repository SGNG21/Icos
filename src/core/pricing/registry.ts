import {
  BUDGET_CURRENCY,
  FREE_TIER,
  UNPRICED,
  type BudgetCurrency,
  type FreeTierProvenance,
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
 *
 * `kind` absent vaut `"RATE"` (forme historique de 0067, inchangée). Une GRATUITÉ, elle, doit
 * se dire : {@link FreeTierPriceRecord} exige `kind: "FREE_TIER"`, et rien d'autre ne la produit.
 */
export interface RatePriceRecord {
  readonly kind?: "RATE";
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

/**
 * GRATUITÉ VÉRIFIÉE (décision 0078). Une condition d'usage avec une date d'expiration, PAS un
 * tarif : il n'y a dans cette forme AUCUN champ de tarif, donc aucun endroit où taper un 0.
 * Le refus `value <= 0` des tarifs reste entier : un 0 tapé est une faute de frappe jusqu'à
 * preuve du contraire, et la preuve, c'est cet enregistrement.
 *
 * Inscrire un tel enregistrement pour un vrai fournisseur est un ACTE DU PROPRIÉTAIRE : il a lu
 * les conditions et le quota, et il en écrit la provenance. Un agent n'en écrit pas.
 */
export interface FreeTierPriceRecord {
  readonly kind: "FREE_TIER";
  readonly provider: string;
  /** L'identifiant tel que la passerelle l'ÉCHO dans la réponse : c'est lui que le journal écrit. */
  readonly modelId: string;
  readonly currency: BudgetCurrency;
  /** La page de conditions lue (URL) et le jour de la lecture. */
  readonly provenance: FreeTierProvenance;
  /** Conditions d'usage constatées (ex. « évaluation seulement, pas de production »). */
  readonly conditions: string;
  /** Quota constaté (requêtes/minute, /jour, crédits) ou « non publié » — jamais vide. */
  readonly verifiedQuota: string;
  readonly effectiveAt: string;
  /** Au plus {@link FREE_TIER_MAX_FRESHNESS_DAYS} jours après `provenance.verifiedOn`. */
  readonly staleAfter: string;
  /* Inexprimables : une gratuité ne porte pas de tarif. */
  readonly promptMicrosPerMillion?: never;
  readonly completionMicrosPerMillion?: never;
}

export type PriceRecord = RatePriceRecord | FreeTierPriceRecord;

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
 *
 * Il ne contient pas davantage de GRATUITÉ (`FREE_TIER`, décision 0078) : en inscrire une est
 * un acte du propriétaire, qui a lu les conditions et le quota du fournisseur pour CE modèle
 * et en date la lecture. Une mesure « 200 en 0,7 s » n'est pas une lecture des conditions.
 */
export const ICOS_PRICE_REGISTRY: PriceRegistry = Object.freeze([]);

/**
 * Horizon de fraîcheur par défaut. Il n'est appliqué nulle part d'office : il ne sert qu'à
 * calculer un `staleAfter` quand le propriétaire inscrit un tarif sans date d'expiration.
 */
export const DEFAULT_FRESHNESS_DAYS = 90;

/**
 * Horizon MAXIMAL d'une gratuité, compté depuis le jour de vérification. Une gratuité est une
 * condition qu'un fournisseur retire sans préavis : l'horizon de 90 jours des factures et des
 * contrats ne vaut pas pour une page de conditions.
 */
export const FREE_TIER_MAX_FRESHNESS_DAYS = 30;

/** Péremption déduite d'une date d'entrée en vigueur. Lève si la date est illisible. */
export function staleAfterFrom(effectiveAt: string, days = DEFAULT_FRESHNESS_DAYS): string {
  const from = Date.parse(effectiveAt);
  if (!Number.isFinite(from)) throw new Error(`effectiveAt illisible : ${effectiveAt}`);
  return new Date(from + days * DAY_MS).toISOString();
}

const blank = (value: unknown) => typeof value !== "string" || value.trim().length === 0;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Défaut d'une gratuité. Chaque champ manquant est un refus : la preuve EST l'enregistrement. */
function freeTierDefect(record: FreeTierPriceRecord): string | null {
  const loose = record as unknown as Record<string, unknown>;
  if (
    loose.promptMicrosPerMillion !== undefined ||
    loose.completionMicrosPerMillion !== undefined
  ) {
    return "une gratuité ne porte aucun tarif";
  }
  const provenance = record.provenance as Partial<FreeTierProvenance> | undefined;
  if (!provenance || blank(provenance.source)) return "source de la gratuité absente";
  if (blank(provenance.verifiedOn) || !ISO_DAY.test(String(provenance.verifiedOn))) {
    return "date de vérification absente ou non ISO (YYYY-MM-DD)";
  }
  const verified = Date.parse(`${provenance.verifiedOn}T00:00:00.000Z`);
  if (!Number.isFinite(verified))
    return `date de vérification illisible : ${provenance.verifiedOn}`;
  if (blank(record.conditions)) return "conditions d'usage absentes";
  if (blank(record.verifiedQuota)) return "quota vérifié absent";
  const from = Date.parse(record.effectiveAt);
  const until = Date.parse(record.staleAfter);
  if (!Number.isFinite(from)) return `effectiveAt illisible : ${record.effectiveAt}`;
  if (!Number.isFinite(until)) return `staleAfter illisible : ${record.staleAfter}`;
  if (until <= from) return "staleAfter n'est pas postérieur à effectiveAt";
  /* Une gratuité ne s'applique pas avant d'avoir été constatée. */
  if (from < verified) return "effectiveAt antérieur à la vérification";
  if (until > verified + FREE_TIER_MAX_FRESHNESS_DAYS * DAY_MS) {
    return `horizon de gratuité trop long (> ${FREE_TIER_MAX_FRESHNESS_DAYS} jours après la vérification)`;
  }
  return null;
}

/** `null` si l'entrée est exploitable, sinon le motif du refus. */
export function recordDefect(record: PriceRecord): string | null {
  if (blank(record.modelId)) return "modelId absent";
  if (blank(record.provider)) return "provider absent";
  if (record.currency !== BUDGET_CURRENCY) return `devise ${record.currency} non supportée`;
  if (record.kind === FREE_TIER) return freeTierDefect(record);
  /* Un `kind` inconnu (JSON, cast) n'est pas un tarif par défaut : refusé. */
  if (record.kind !== undefined && record.kind !== "RATE")
    return `kind ${String(record.kind)} inconnu`;
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
  | { readonly kind: "PRICE"; readonly record: RatePriceRecord }
  | { readonly kind: typeof FREE_TIER; readonly record: FreeTierPriceRecord }
  | UnknownPriceOutcome;

/** Une gratuité chiffrée : 0 micro, et la preuve datée qui l'autorise. */
export interface FreeTierCostOutcome {
  readonly kind: typeof FREE_TIER;
  readonly modelId: string;
  readonly currency: BudgetCurrency;
  readonly micros: 0;
  readonly provenance: FreeTierProvenance;
}

export type CostMicrosOutcome =
  | { readonly kind: "COST_MICROS"; readonly currency: BudgetCurrency; readonly micros: number }
  | FreeTierCostOutcome
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
  const what = record.kind === FREE_TIER ? "gratuité" : "tarif";
  if (at < Date.parse(record.effectiveAt)) {
    return unknown(
      modelId,
      "NOT_YET_EFFECTIVE",
      `${what} applicable à partir de ${record.effectiveAt}`,
    );
  }
  /*
   * Une gratuité périmée redevient INCONNUE (`STALE`), jamais « encore gratuite » et jamais un
   * tarif : c'est la façon la plus probable dont un modèle « gratuit » se met à coûter.
   */
  if (at >= Date.parse(record.staleAfter)) {
    return unknown(
      modelId,
      "STALE",
      `${what} périmé(e) depuis ${record.staleAfter} : non appliqué(e)`,
    );
  }
  if (record.kind === FREE_TIER) return { kind: FREE_TIER, record };
  return { kind: "PRICE", record };
}

/**
 * Coût d'une consommation mesurée, en micros ENTIERS.
 *
 * Un tarif ne connaît que le prompt et la complétion. Quand le fournisseur facture PLUS que
 * prompt + completion (tokens de raisonnement, tokens de cache), le reste n'a pas de tarif
 * ici — et on ne lui en invente pas un, pas même 0. Le coût n'est alors pas prouvable.
 */
export function costMicros(
  record: RatePriceRecord,
  usage: TokenUsage,
): Exclude<CostMicrosOutcome, FreeTierCostOutcome>;
export function costMicros(
  record: FreeTierPriceRecord,
  usage: TokenUsage,
): FreeTierCostOutcome | UnknownPriceOutcome;
export function costMicros(record: PriceRecord, usage: TokenUsage): CostMicrosOutcome;
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

  /*
   * Une gratuité couvre l'APPEL, pas des classes de tokens : les tokens de raisonnement ou de
   * cache au-delà de prompt + completion relèvent des mêmes conditions vérifiées. La validation
   * des compteurs ci-dessus s'applique néanmoins : un décompte illisible reste NOT_REPRESENTABLE.
   */
  if (record.kind === FREE_TIER) {
    return {
      kind: FREE_TIER,
      modelId,
      currency: record.currency,
      micros: 0,
      provenance: record.provenance,
    };
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
  if (resolved.kind === UNKNOWN_PRICE) return resolved;
  return costMicros(resolved.record, usage);
}

/**
 * SEUL endroit où la monnaie redevient un flottant, pour la frontière héritée
 * (`CostOutcome.amount`, en unités de {@link BUDGET_CURRENCY}). Tout calcul reste en micros.
 */
export function microsToAmount(micros: number): number {
  return micros / MICROS_PER_UNIT;
}
