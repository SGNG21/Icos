/**
 * SPEND METER vocabulary (autonomy blocker B1). Pure : ni Next.js, ni Drizzle, ni PostgreSQL.
 *
 * `goals.budget` est persisté depuis longtemps mais n'a jamais été appliqué : aucune source
 * de prix, aucun accumulateur, aucun point d'application. Cette couche fournit le vocabulaire
 * minimal pour dire la vérité sur une dépense, y compris quand cette vérité est « je ne sais pas ».
 *
 * Règle non négociable : une absence n'est JAMAIS un zéro. Un appel dont on ne connaît pas
 * les tokens est UNMETERED, un modèle sans prix est UNPRICED, et aucun des deux ne peut être
 * blanchi en « 0 EUR dépensé ».
 */

/** Une seule devise déclarée. Aucune conversion n'est faite nulle part dans cette couche. */
export const BUDGET_CURRENCY = "EUR" as const;
export type BudgetCurrency = typeof BUDGET_CURRENCY;

/**
 * UNITÉ CANONIQUE DE L'ARGENT : le MICRO-EUR ENTIER.
 *
 * Pourquoi des micros et pas des centimes : un appel de complétion coûte couramment
 * 1,65e-4 EUR (voir `postgres-spend-ledger.integration.test.ts`). En centimes, chaque appel
 * s'arrondirait à 0 et un plafond ne serait jamais atteint — un blanchiment par arrondi.
 * Le micro-euro est donc la plus petite unité qui reste ENTIÈRE sur un vrai appel.
 *
 * Il n'y a qu'UNE unité mineure dans ce dépôt. Pas de centimes à côté.
 */
export const MICROS_PER_EUR = 1_000_000;

/** EUR flottant -> micros entiers, au plus proche. Conversion de FRONTIÈRE uniquement. */
export function eurToMicros(amount: number): number | null {
  if (!Number.isFinite(amount)) return null;
  const micros = Math.round(amount * MICROS_PER_EUR);
  return Number.isSafeInteger(micros) ? micros : null;
}

/** Consommation réelle inconnue ou invérifiable. Jamais 0. */
export const UNMETERED = "UNMETERED" as const;
export type Unmetered = typeof UNMETERED;

/** Modèle absent de la table de prix. Un appel UNPRICED n'est pas gratuit. */
export const UNPRICED = "UNPRICED" as const;
export type Unpriced = typeof UNPRICED;

/** Appel sans attribution fournie. On l'enregistre tel quel, on n'en invente pas une. */
export const UNATTRIBUTED = "UNATTRIBUTED" as const;
export type Unattributed = typeof UNATTRIBUTED;

/** Pourquoi la consommation d'un appel n'a pas pu être mesurée. */
export const UNMETERED_REASONS = [
  /** Corps non lisible comme JSON (flux SSE, binaire, corps déjà consommé…). */
  "NON_JSON_BODY",
  /** JSON lisible mais sans objet `usage`. */
  "USAGE_ABSENT",
  /** `usage` présent mais incomplet (prompt_tokens ou completion_tokens manquant). */
  "USAGE_INCOMPLETE",
  /** Valeur négative, non entière, NaN ou non finie. */
  "USAGE_INVALID",
  /** total_tokens incohérent avec prompt + completion. */
  "USAGE_INCONSISTENT",
  /** Valeur si grande qu'elle ne peut pas être un vrai décompte. */
  "USAGE_IMPLAUSIBLE",
] as const;
export type UnmeteredReason = (typeof UNMETERED_REASONS)[number];

/** Pourquoi un appel est refusé avant d'être émis. */
export const DENY_REASONS = [
  /** Plafond monétaire atteint ou dépassé. */
  "MONEY_CAP_REACHED",
  /** Plafond de tokens atteint ou dépassé. */
  "TOKEN_CAP_REACHED",
  /** Un total non chiffré ne peut pas être prouvé sous un plafond monétaire. */
  "UNPRICED_USAGE_IN_WINDOW",
  /** Un total non mesuré ne peut pas être prouvé sous quelque plafond que ce soit. */
  "UNMETERED_USAGE_IN_WINDOW",
  /** `CAPPED` sans aucun plafond : rien à appliquer, donc on refuse. */
  "NO_ENFORCEABLE_CAP",
  /** Plafond non fini, négatif ou nul. */
  "INVALID_CAP",
  /** Accumulateur dans un état non exploitable (débordement, non fini). */
  "UNUSABLE_WINDOW",
  /** La réservation demandée ferait franchir le plafond : refusée, jamais rognée en silence. */
  "RESERVATION_EXCEEDS_CAP",
  /** Montant de réservation inexploitable (non entier, nul, négatif, non fini). */
  "INVALID_RESERVATION",
  /**
   * Plafond MONÉTAIRE et prix du modèle inconnu : une réservation en tokens ne peut pas être
   * prouvée sous un plafond en euros. Fermé par défaut — le prix n'est pas inventé.
   */
  "UNPRICED_RESERVATION",
  /** Les deux orthographes du plafond monétaire sont fournies : on ne devine pas laquelle. */
  "AMBIGUOUS_MONEY_CAP",
  /**
   * La requête ne peut pas se voir écrire une limite de sortie, donc sa consommation n'a
   * aucune majoration connue AVANT émission : rien à réserver, donc rien à autoriser.
   */
  "UNBOUNDED_REQUEST",
  /**
   * Le bail de la réservation a été perdu PENDANT l'appel (prolongation refusée) : le budget
   * engagé a pu être réattribué, donc continuer dépenserait une seconde fois le même plafond.
   */
  "RESERVATION_LEASE_LOST",
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** À qui une dépense est imputée. Tous les champs sont optionnels : rien n'est inventé. */
export interface Attribution {
  readonly missionId?: string;
  readonly goalId?: string;
  readonly brainId?: string;
  /**
   * BUDGET DE CONVERSATION (décision du propriétaire : deux portées distinctes).
   *
   * Parler à ICOS — comprendre une intention, retrouver du contexte, répondre — n'est PAS
   * du travail de goal, et doit pouvoir avoir lieu sans qu'aucun goal existe. Ce trafic a
   * donc son propre plafond, par conversation, et il ne doit JAMAIS entamer le budget
   * d'exécution d'un goal. Dès qu'une parole devient une demande de TRAVAIL, un Goal est
   * créé et tout ce qui suit passe sur le budget du goal.
   *
   * Dernier dans la précédence de {@link attributionKey}, délibérément : si une imputation
   * portait les deux, c'est le budget le plus STRICT (le goal) qui gagne. L'ambiguïté se
   * résout vers la contrainte, jamais vers la permission.
   */
  readonly conversationId?: string;
  /**
   * BUDGET DE RELECTURE SYSTÈME — UNIQUEMENT pour la relecture OBLIGATOIRE d'une mission
   * qui n'a réellement AUCUN goal (décision du propriétaire).
   *
   * Ce n'est PAS un troisième budget d'exécution. Une relecture indépendante est un
   * CONTRÔLE DE SÛRETÉ : la refuser faute de budget n'est pas « fermé par défaut », c'est
   * éteindre le contrôle. Mais une mission générique (N11) n'a pas de goal, donc pas de
   * budget d'exécution à débiter. Ce champ est la seule réponse à ce cas précis, et il est
   * borné strictement.
   *
   * DERNIER dans la précédence de {@link attributionKey}, après le goal ET la mission.
   * C'est ce qui rend le contournement INEXPRIMABLE : une imputation qui porte un goal
   * tombe TOUJOURS sur le budget du goal, même si elle porte aussi ceci. On ne peut donc
   * pas « obtenir le budget de relecture système » en ajoutant un champ — il faudrait
   * qu'aucun goal n'existe, et le goal est lu sur la MISSION PERSISTÉE, jamais fourni par
   * l'appelant.
   *
   * Porte l'id de la mission relue : une fenêtre par mission, pas une cagnotte commune où
   * une relecture bavarde affamerait les suivantes.
   */
  readonly systemReviewMissionId?: string;
}

/** Décompte de tokens mesuré. `totalTokens >= promptTokens + completionTokens`. */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** Résultat de lecture de la consommation d'un appel. */
export type UsageOutcome =
  | { readonly kind: "METERED"; readonly usage: TokenUsage }
  | { readonly kind: Unmetered; readonly reason: UnmeteredReason };

/** Résultat du chiffrage d'une consommation mesurée. */
export type CostOutcome =
  | { readonly kind: "COST"; readonly currency: BudgetCurrency; readonly amount: number }
  | { readonly kind: Unpriced; readonly modelId: string; readonly reason: string };

/**
 * Plafond de dépense. `UNCAPPED` doit être choisi explicitement : l'absence de plafond
 * n'est jamais déduite d'un champ manquant.
 *
 * DEUX CONCEPTS TYPÉS, UNE SEULE UNITÉ CHACUN :
 *   - `maxTotalTokens` : entier, TOUJOURS applicable, aucun prix requis. C'est le seul
 *     plafond réellement appliqué aujourd'hui (la table de prix est vide) et il doit rester
 *     suffisant à lui seul : le prix en euros ne doit JAMAIS être un prérequis de l'autonomie.
 *   - `maxCostMicros` : plafond monétaire en MICRO-EUR ENTIERS ({@link MICROS_PER_EUR}).
 *     Jamais de flottant pour de l'argent à l'intérieur : la conversion se fait à la frontière
 *     (le résolveur qui lit `goals.budget`), et tout ce qui est en aval compare des entiers.
 */
export type BudgetCap =
  | { readonly kind: "UNCAPPED" }
  | {
      readonly kind: "CAPPED";
      /** Plafond monétaire en micro-euros ENTIERS. Unité canonique. */
      readonly maxCostMicros?: number;
      /**
       * @deprecated Ancienne orthographe : montant FLOTTANT en `BUDGET_CURRENCY`. Conservée
       * pour compatibilité ascendante le temps que les appelants hors de ce lot passent à
       * `maxCostMicros` ; `decide` la normalise en micros en UN seul endroit
       * ({@link moneyCapMicros}). Fournir les deux est un refus `AMBIGUOUS_MONEY_CAP`.
       */
      readonly maxAmount?: number;
      readonly maxTotalTokens?: number;
    };

export type SpendDecision =
  | { readonly kind: "ALLOW" }
  | { readonly kind: "DENY"; readonly reason: DenyReason; readonly detail: string };

/**
 * Clé d'imputation stable. `goal=`/`mission=` préfixent le champ pour qu'une valeur
 * contenant le séparateur ne puisse pas se faire passer pour un autre champ.
 *
 * UN SEUL BUDGET POUR TOUT L'ARBRE D'UN GOAL (verrou P0-B). La clé est le GOAL SEUL dès
 * qu'un goal est imputé — jamais `goal+mission`, jamais `goal+brain`. C'est le cœur de la
 * propriété : une tâche, un worker, un relecteur, une reprise, une replanification et une
 * SECONDE MISSION sur le même goal tombent tous dans la MÊME fenêtre. Concaténer les champs
 * (l'ancien comportement) donnait à chaque mission, et à chaque brain, une copie neuve du
 * budget du goal : multiplier les workers multipliait le budget. La précédence le rend
 * désormais INEXPRIMABLE, et pas seulement « non utilisé par les appelants actuels ».
 *
 * Hors goal, la clé retombe sur la mission puis sur le brain : l'imputation la plus précise
 * dont on dispose, jamais une invention.
 */
export function attributionKey(attribution: Attribution | null | undefined): string {
  if (!attribution) return UNATTRIBUTED;
  for (const [label, value] of [
    ["goal", attribution.goalId],
    ["mission", attribution.missionId],
    ["brain", attribution.brainId],
    /* Avant-dernier : une imputation qui porte AUSSI un goal retombe sur le budget du goal. */
    ["conversation", attribution.conversationId],
    /*
     * DERNIER DE TOUS. La relecture système ne gagne que s'il n'y a RIEN d'autre — ni goal,
     * ni mission, ni brain, ni conversation. C'est la non-contournabilité, écrite dans
     * l'ordre : on ne peut pas descendre vers ce budget, seulement y tomber faute de mieux.
     */
    ["system-review", attribution.systemReviewMissionId],
  ] as const) {
    if (typeof value === "string" && value.trim().length > 0) {
      return `${label}=${encodeURIComponent(value.trim())}`;
    }
  }
  return UNATTRIBUTED;
}

/**
 * INVERSE de {@link attributionKey}. Sert au SOLDE d'une réservation (verrou C2) : la ligne
 * de réservation ne stocke que la clé, et c'est pourtant elle — pas l'appelant — qui dit à
 * quel budget la dépense revient.
 *
 * Exact par construction : `attributionKey` ne retient JAMAIS qu'UN champ (goal, puis
 * mission, puis brain), donc la clé contient tout ce que la clé encodait. Elle ne restitue
 * pas les champs de REPORTING que l'appelant avait pu fournir en plus ; c'est pourquoi
 * `settle` préfère l'imputation de l'appelant quand sa clé est IDENTIQUE, et ne retombe sur
 * celle-ci que lorsqu'elles diffèrent, c'est-à-dire exactement quand il y a redirection.
 *
 * `attributionKey(attributionFromKey(k)) === k` pour toute clé produite par `attributionKey`.
 */
export function attributionFromKey(key: string): Attribution | null {
  const separator = key.indexOf("=");
  if (separator < 1) return null; /* UNATTRIBUTED, ou une clé qu'on n'a pas écrite. */
  const label = key.slice(0, separator);
  let value: string;
  try {
    value = decodeURIComponent(key.slice(separator + 1));
  } catch {
    return null; /* Encodage cassé : on n'invente pas une imputation. */
  }
  if (value.length === 0) return null;
  switch (label) {
    case "goal":
      return { goalId: value };
    case "mission":
      return { missionId: value };
    case "brain":
      return { brainId: value };
    case "conversation":
      return { conversationId: value };
    case "system-review":
      return { systemReviewMissionId: value };
    default:
      return null;
  }
}
