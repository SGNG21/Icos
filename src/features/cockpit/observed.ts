import { isReal, missing, type Truth } from "./truth";

/**
 * CONTRAT TRANSVERSAL DE FRAÎCHEUR (mission COCKPIT-LIVE, D1).
 *
 * Une source n'est « verte » que si elle a été LUE et si sa mesure est RÉCENTE.
 * `Observed<T>` ajoute à `Truth<T>` ce que la vérité seule ne porte pas : quand
 * la source a mesuré (`observedAt`), quand ICOS l'a lue (`collectedAt`) et le
 * seuil documenté au-delà duquel la lecture est périmée (`maxAgeMs`).
 *
 * États, dans l'ordre où ils sont décidés :
 * - `forbidden`   : la portée de l'appelant n'y a pas accès (jamais « vide ») ;
 * - `unavailable` : la lecture a échoué ou la source n'est pas composée ;
 * - `degraded`    : lue, mais sans horodatage source (fraîcheur improuvable), avec un
 *                   horodatage dans le futur (horloge divergente), ou avec une partie
 *                   de ses sous-sources illisible (`degradedCode`) ;
 * - `stale`       : lue, horodatée, plus vieille que `maxAgeMs` ;
 * - `ok`          : lue, horodatée, récente, complète.
 *
 * `maxAgeMs: null` = aucun seuil de fraîcheur documenté pour cette source (journal
 * append-only dont l'âge de la dernière ligne n'est pas une panne). L'état `stale`
 * n'est alors jamais produit : on ne fabrique pas un seuil qu'on ne sait pas justifier.
 */
export type SourceState = "ok" | "stale" | "unavailable" | "degraded" | "forbidden";

export interface Observed<T> {
  state: SourceState;
  /** Horodatage de la mesure côté source (ISO), null si la source n'en porte pas. */
  observedAt: string | null;
  /** Horodatage de l'acquisition par ICOS (ISO) : une lecture, pas une simulation. */
  collectedAt: string;
  /** Seuil de fraîcheur documenté ; null = pas de seuil applicable. */
  maxAgeMs: number | null;
  /** Source de vérité technique vérifiée (table, route, fichier). */
  source: string;
  /** Présent uniquement pour une surface autorisée à le voir. */
  tenantId?: string;
  data: T | null;
  /** Code assaini : jamais un message de driver, une URL ni du SQL. */
  errorCode?: string;
}

/**
 * Marqueur STRUCTURÉ d'un refus de portée, porté par `Truth.requirement` : une vérité
 * `not_available` qui le porte est un refus (`forbidden`), jamais une absence. Le
 * texte de la raison n'entre pas dans la décision.
 */
export const FORBIDDEN_SCOPE_REQUIREMENT = "FORBIDDEN_SCOPE";

/** Vérité manquante « hors portée de l'appelant » (owner/admin seulement). */
export function scopeRefused<T = never>(what: string): Truth<T> {
  return missing<T>(
    "not_available",
    `${what} is visible to owner/admin scope only.`,
    FORBIDDEN_SCOPE_REQUIREMENT,
  );
}

export function isScopeRefused(truth: Truth<unknown>): boolean {
  return !isReal(truth) && truth.requirement === FORBIDDEN_SCOPE_REQUIREMENT;
}

/** Une horloge source en avance de plus d'une minute n'est pas une mesure fraîche. */
export const FUTURE_TOLERANCE_MS = 60_000;

export interface ObserveInput<T> {
  truth: Truth<T>;
  /** Extrait l'horodatage de mesure d'une valeur réelle ; null si la source n'en porte pas. */
  observedAt: (value: T) => string | null;
  collectedAt: Date;
  maxAgeMs: number | null;
  source: string;
  tenantId?: string;
  /**
   * Code d'une dégradation PARTIELLE constatée par l'appelant (sous-source illisible,
   * preuve d'un membre périmée) : la source reste lue, mais n'est plus `ok`.
   */
  degradedCode?: string | null;
  /** Vrai quand la valeur lue est vide (aucune ligne) : `EMPTY_SOURCE` plutôt qu'un silence. */
  empty?: (value: T) => boolean;
}

/** Code d'erreur assaini dérivé d'une vérité manquante. */
export function errorCodeOf(truth: Exclude<Truth<unknown>, { kind: "real" }>): string {
  if (truth.requirement === FORBIDDEN_SCOPE_REQUIREMENT) return FORBIDDEN_SCOPE_REQUIREMENT;
  switch (truth.kind) {
    case "not_connected":
      return "NOT_CONNECTED";
    case "not_available":
      return "NOT_AVAILABLE";
    case "unknown":
      return "READ_FAILED";
  }
}

export function observe<T>(input: ObserveInput<T>): Observed<T> {
  const collectedAt = input.collectedAt.toISOString();
  const base = {
    collectedAt,
    maxAgeMs: input.maxAgeMs,
    source: input.source,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
  };
  const truth = input.truth;
  if (!isReal(truth)) {
    const forbidden = isScopeRefused(truth);
    return {
      ...base,
      state: forbidden ? "forbidden" : "unavailable",
      observedAt: null,
      data: null,
      errorCode: errorCodeOf(truth),
    };
  }
  const partial = input.degradedCode ?? null;
  const observedAt = input.observedAt(truth.value);
  if (observedAt === null) {
    const empty = input.empty?.(truth.value) === true;
    return {
      ...base,
      state: "degraded",
      observedAt: null,
      data: truth.value,
      errorCode: partial ?? (empty ? "EMPTY_SOURCE" : "NO_SOURCE_TIMESTAMP"),
    };
  }
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
    return {
      ...base,
      state: "degraded",
      observedAt: null,
      data: truth.value,
      errorCode: partial ?? "INVALID_SOURCE_TIMESTAMP",
    };
  }
  const age = input.collectedAt.getTime() - observedMs;
  if (age < -FUTURE_TOLERANCE_MS) {
    return {
      ...base,
      state: "degraded",
      observedAt,
      data: truth.value,
      errorCode: partial ?? "FUTURE_SOURCE_TIMESTAMP",
    };
  }
  const stale = input.maxAgeMs !== null && age > input.maxAgeMs;
  if (stale) {
    return {
      ...base,
      state: "stale",
      observedAt,
      data: truth.value,
      ...(partial ? { errorCode: partial } : {}),
    };
  }
  if (partial) {
    return { ...base, state: "degraded", observedAt, data: truth.value, errorCode: partial };
  }
  return { ...base, state: "ok", observedAt, data: truth.value };
}

/** Le plus récent d'une liste d'horodatages ISO (ou Date) ; null si aucun n'est lisible. */
export function latestOf(values: readonly (string | Date | null | undefined)[]): string | null {
  let best: number | null = null;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const ms = v instanceof Date ? v.getTime() : Date.parse(v);
    if (Number.isNaN(ms)) continue;
    if (best === null || ms > best) best = ms;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Ton d'affichage : vert = mesuré et frais ; orange = périmé ou dégradé ; gris = inconnu,
 * indisponible ou refusé par la portée (un refus n'est pas un incident : le rouge est
 * réservé aux incidents confirmés par une mesure).
 */
export const SOURCE_STATE_TONE: Record<SourceState, "ok" | "warn" | "unknown"> = {
  ok: "ok",
  stale: "warn",
  degraded: "warn",
  unavailable: "unknown",
  forbidden: "unknown",
};

/** Libellé affiché pour chaque état (jamais la couleur seule). */
export const SOURCE_STATE_LABEL: Record<SourceState, string> = {
  ok: "LIVE",
  stale: "STALE",
  degraded: "DEGRADED",
  unavailable: "UNAVAILABLE",
  forbidden: "FORBIDDEN",
};
