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
] as const;
export type DenyReason = (typeof DENY_REASONS)[number];

/** À qui une dépense est imputée. Tous les champs sont optionnels : rien n'est inventé. */
export interface Attribution {
  readonly missionId?: string;
  readonly goalId?: string;
  readonly brainId?: string;
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
 */
export type BudgetCap =
  | { readonly kind: "UNCAPPED" }
  | {
      readonly kind: "CAPPED";
      /** Plafond monétaire en `BUDGET_CURRENCY`. */
      readonly maxAmount?: number;
      readonly maxTotalTokens?: number;
    };

export type SpendDecision =
  | { readonly kind: "ALLOW" }
  | { readonly kind: "DENY"; readonly reason: DenyReason; readonly detail: string };

/**
 * Clé d'imputation stable. `goal=`/`mission=` préfixent chaque champ pour qu'une valeur
 * contenant le séparateur ne puisse pas se faire passer pour un autre champ.
 */
export function attributionKey(attribution: Attribution | null | undefined): string {
  if (!attribution) return UNATTRIBUTED;
  const parts: string[] = [];
  for (const [label, value] of [
    ["mission", attribution.missionId],
    ["goal", attribution.goalId],
    ["brain", attribution.brainId],
  ] as const) {
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(`${label}=${encodeURIComponent(value.trim())}`);
    }
  }
  return parts.length === 0 ? UNATTRIBUTED : parts.join("|");
}
