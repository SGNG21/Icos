import { isReal, type Truth } from "./truth";

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
 * - `degraded`    : lue, mais sans horodatage source : la fraîcheur est improuvable ;
 * - `stale`       : lue, horodatée, plus vieille que `maxAgeMs` ;
 * - `ok`          : lue, horodatée, récente.
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

export interface ObserveInput<T> {
  truth: Truth<T>;
  /** Extrait l'horodatage de mesure d'une valeur réelle ; null si la source n'en porte pas. */
  observedAt: (value: T) => string | null;
  collectedAt: Date;
  maxAgeMs: number | null;
  source: string;
  tenantId?: string;
}

/** Code d'erreur assaini dérivé d'une vérité manquante. */
export function errorCodeOf(truth: Exclude<Truth<unknown>, { kind: "real" }>): string {
  switch (truth.kind) {
    case "not_connected":
      return "NOT_CONNECTED";
    case "not_available":
      return "NOT_AVAILABLE";
    case "unknown":
      return "READ_FAILED";
  }
}

/** Une vérité `not_available` motivée par la portée est un refus, pas une absence. */
const SCOPE_REFUSAL = /scope only|portée/i;

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
    const forbidden = truth.kind === "not_available" && SCOPE_REFUSAL.test(truth.reason);
    return {
      ...base,
      state: forbidden ? "forbidden" : "unavailable",
      observedAt: null,
      data: null,
      errorCode: forbidden ? "FORBIDDEN_SCOPE" : errorCodeOf(truth),
    };
  }
  const observedAt = input.observedAt(truth.value);
  if (observedAt === null) {
    return {
      ...base,
      state: "degraded",
      observedAt: null,
      data: truth.value,
      errorCode: "NO_SOURCE_TIMESTAMP",
    };
  }
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
    return {
      ...base,
      state: "degraded",
      observedAt: null,
      data: truth.value,
      errorCode: "INVALID_SOURCE_TIMESTAMP",
    };
  }
  const age = input.collectedAt.getTime() - observedMs;
  const stale = input.maxAgeMs !== null && age > input.maxAgeMs;
  return { ...base, state: stale ? "stale" : "ok", observedAt, data: truth.value };
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
