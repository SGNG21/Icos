/**
 * LA CAUSE RACINE SURVIT AUX COUCHES (décision du propriétaire).
 *
 * ── CE QUI ÉTAIT CASSÉ ──────────────────────────────────────────────────────────────────
 * `omniroute-reviewer.ts` finissait par `throw reviewerError("PROVIDER_FAILURE")` dans un
 * `catch` attrape-tout. Toute cause y disparaissait. Mesuré : une relecture refusée par le
 * budget remontait comme « échec du fournisseur », et la vraie cause —
 * `BUDGET_DENIED:NO_ENFORCEABLE_CAP` — n'était visible QUE parce que j'ai ajouté un
 * `console.error` temporaire pour la trouver. Un opérateur serait allé chercher OmniRoute
 * pendant que le problème était une variable de configuration.
 *
 * Cinq causes ne doivent JAMAIS être repliées en une seule, parce qu'elles appellent cinq
 * actions différentes :
 *
 *   NO_ENFORCEABLE_CAP  configurer un plafond       -> action de l'opérateur
 *   BUDGET_EXHAUSTED    augmenter ou attendre       -> action du propriétaire
 *   OUTPUT_TRUNCATED    lever `ICOS_MAX_OUTPUT_TOKENS` -> action de l'opérateur
 *   LEASE_LOST          ne rien faire, c'est correct -> un autre runner a repris
 *   CANCELLED           ne rien faire, c'est voulu   -> quelqu'un a demandé l'arrêt
 *   PROVIDER_FAILURE    regarder le fournisseur      -> la SEULE qui concerne OmniRoute
 *
 * ── CE QUE PORTE UNE CAUSE ──────────────────────────────────────────────────────────────
 * La catégorie, la cause racine, le fournisseur et le modèle quand ils s'appliquent, et les
 * identifiants (goal, mission, tâche, relecture) pour qu'on sache DE QUOI on parle. Jamais
 * une valeur de secret : il n'y a aucun champ libre où en mettre une.
 */

export const FAILURE_CATEGORIES = [
  /** Le budget a refusé AVANT l'appel. Rien n'a été dépensé. */
  "BUDGET",
  /** Le fournisseur a répondu, mais la réponse a été coupée au plafond de sortie. */
  "OUTPUT",
  /** L'exécution a perdu son droit de rendre un résultat, ou a été arrêtée. */
  "LIFECYCLE",
  /** Le fournisseur lui-même : réseau, 5xx, réponse illisible. */
  "PROVIDER",
  /** Configuration absente ou incohérente. */
  "CONFIGURATION",
] as const;
export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

/**
 * Les causes racines qui ne doivent jamais être repliées. La liste est fermée : une cause
 * inconnue devient `PROVIDER_FAILURE`, qui est l'aveu honnête « on ne sait pas », et non un
 * fourre-tout où les causes connues viendraient se perdre.
 */
export const ROOT_CAUSES = [
  "NO_ENFORCEABLE_CAP",
  "BUDGET_EXHAUSTED",
  "UNPRICED_USAGE",
  "UNBOUNDED_REQUEST",
  "OUTPUT_TRUNCATED",
  "LEASE_LOST",
  "CANCELLED",
  "TIMEOUT",
  "CONFIGURATION_INCOMPLETE",
  "PROVIDER_FAILURE",
] as const;
export type RootCause = (typeof ROOT_CAUSES)[number];

const CATEGORY_OF: Readonly<Record<RootCause, FailureCategory>> = Object.freeze({
  NO_ENFORCEABLE_CAP: "BUDGET",
  BUDGET_EXHAUSTED: "BUDGET",
  UNPRICED_USAGE: "BUDGET",
  UNBOUNDED_REQUEST: "BUDGET",
  OUTPUT_TRUNCATED: "OUTPUT",
  LEASE_LOST: "LIFECYCLE",
  CANCELLED: "LIFECYCLE",
  TIMEOUT: "LIFECYCLE",
  CONFIGURATION_INCOMPLETE: "CONFIGURATION",
  PROVIDER_FAILURE: "PROVIDER",
});

export const categoryOf = (cause: RootCause): FailureCategory => CATEGORY_OF[cause];

/** De quoi on parle. Tous optionnels : on ne remplit que ce qu'on sait réellement. */
export interface FailureSubject {
  readonly goalId?: string;
  readonly missionId?: string;
  readonly taskId?: string;
  readonly reviewId?: string;
  readonly provider?: string;
  readonly model?: string;
}

export interface FailureCause {
  readonly category: FailureCategory;
  readonly rootCause: RootCause;
  /** Détail lisible. Jamais un secret : il vient d'un message de refus, pas d'un corps. */
  readonly detail: string;
  readonly subject: FailureSubject;
}

/**
 * Les refus de budget arrivent comme `BUDGET_DENIED:<RAISON> <détail>`. On traduit la
 * RAISON, on ne la devine pas : une raison inconnue reste `PROVIDER_FAILURE` plutôt que
 * d'être rangée de force dans une catégorie qui lui irait mal.
 */
/*
 * NOT anchored to the start, deliberately.
 *
 * It used to be `^BUDGET_DENIED:`, which assumed the refusal arrives raw. It does not:
 * the reviewer wraps it — `QUALITY_REVIEWER_BUDGET_EXHAUSTED:BUDGET/... : BUDGET_DENIED:
 * RESERVATION_EXCEEDS_CAP ...` — so a real cap refusal was classified PROVIDER_FAILURE
 * and retried as if the provider were flaky. The token is distinctive enough to find
 * anywhere in the message, and finding it is the whole point of this function.
 */
const BUDGET_DENIED = /BUDGET_DENIED:([A-Z_]+)\s*(.*)$/s;

const DENY_TO_ROOT: Readonly<Record<string, RootCause>> = Object.freeze({
  NO_ENFORCEABLE_CAP: "NO_ENFORCEABLE_CAP",
  INVALID_CAP: "NO_ENFORCEABLE_CAP",
  MONEY_CAP_REACHED: "BUDGET_EXHAUSTED",
  TOKEN_CAP_REACHED: "BUDGET_EXHAUSTED",
  RESERVATION_EXCEEDS_CAP: "BUDGET_EXHAUSTED",
  UNPRICED_USAGE_IN_WINDOW: "UNPRICED_USAGE",
  UNPRICED_RESERVATION: "UNPRICED_USAGE",
  UNMETERED_USAGE_IN_WINDOW: "UNPRICED_USAGE",
  UNBOUNDED_REQUEST: "UNBOUNDED_REQUEST",
  RESERVATION_LEASE_LOST: "LEASE_LOST",
});

/**
 * Lit la cause racine d'une erreur quelconque, SANS la replier. C'est la fonction qu'une
 * couche d'adaptation doit appeler au lieu de jeter un code générique.
 */
export function rootCauseOf(error: unknown): RootCause {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const denied = BUDGET_DENIED.exec(message);
  if (denied?.[1]) return DENY_TO_ROOT[denied[1]] ?? "PROVIDER_FAILURE";
  if (/OUTPUT_TRUNCATED/.test(message)) return "OUTPUT_TRUNCATED";
  if (/LEASE_LOST/.test(message)) return "LEASE_LOST";
  if (/CONFIGURATION_INCOMPLETE/.test(message)) return "CONFIGURATION_INCOMPLETE";
  if (/\bABORTED\b|\bCANCELL?ED\b/i.test(message)) return "CANCELLED";
  if (/\bTIMEOUT\b/i.test(message) || (error instanceof Error && error.name === "TimeoutError")) {
    return "TIMEOUT";
  }
  /* Inconnu : on l'avoue, on ne le range pas ailleurs. */
  return "PROVIDER_FAILURE";
}

export function failureCauseOf(error: unknown, subject: FailureSubject = {}): FailureCause {
  const rootCause = rootCauseOf(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  return { category: categoryOf(rootCause), rootCause, detail: message, subject };
}

/** Une ligne pour l'opérateur : la catégorie, la cause, et de quoi on parle. */
export function describeFailure(cause: FailureCause): string {
  const subject = Object.entries(cause.subject)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `${cause.category}/${cause.rootCause}${subject ? ` [${subject}]` : ""}: ${cause.detail}`;
}
