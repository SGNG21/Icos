/**
 * Erreur levée lorsqu'une ligne SQL ne satisfait pas le contrat Zod attendu au
 * moment du mapping (jamais un retour silencieux). Le message reste non
 * sensible : il n'inclut pas les valeurs de la ligne.
 */
export class RepositoryMappingError extends Error {
  readonly code = "repository_mapping_error" as const;
  constructor(entity: string, details: string) {
    super(`Ligne ${entity} invalide au mapping : ${details}`);
    this.name = "RepositoryMappingError";
  }
}

/**
 * Indisponibilité de la persistance (connexion impossible, schéma absent,
 * timeout). Le message ne contient jamais d'URL, d'hôte, de nom de base ni de
 * détail SQL — il est destiné à être mappé en HTTP 503.
 */
export class PersistenceUnavailableError extends Error {
  readonly code = "persistence_unavailable" as const;
  constructor(reason: string) {
    super(`Persistance indisponible : ${reason}`);
    this.name = "PersistenceUnavailableError";
  }
}

/**
 * Conflit transitoire (deadlock, échec de sérialisation). L'appelant doit
 * réessayer explicitement : aucun retry automatique serveur pour une décision
 * humaine.
 */
export class TransientConflictError extends Error {
  readonly code = "transient_conflict" as const;
  constructor(reason: string) {
    super(`Conflit transitoire : ${reason}`);
    this.name = "TransientConflictError";
  }
}

/** SQLSTATE personnalisé levé par le trigger append-only de `audit_entries`. */
export const AUDIT_APPEND_ONLY_SQLSTATE = "IC001";

/**
 * Classe une erreur PostgreSQL par son SQLSTATE (`error.code` de postgres.js),
 * sans exposer le message brut.
 * - `unique` : violation de contrainte unique (23505) ;
 * - `transient` : deadlock (40P01) ou échec de sérialisation (40001) ;
 * - `unavailable` : classes connexion (08*) et arrêt serveur (57P0x) ;
 * - `other` : à propager tel quel.
 */
/**
 * Extrait SQLSTATE et nom de contrainte d'une erreur PostgreSQL, en déroulant la
 * chaîne `cause` : Drizzle enveloppe l'erreur postgres.js (le SQLSTATE se trouve
 * alors sur `error.cause.code`).
 */
function pgFields(error: unknown): { code: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) {
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      return { code, constraint: typeof constraint === "string" ? constraint : undefined };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return { code: "" };
}

/** SQLSTATE d'une erreur PostgreSQL (en déroulant `cause`), ou `undefined`. */
export function sqlStateOf(error: unknown): string | undefined {
  const code = pgFields(error).code;
  return code === "" ? undefined : code;
}

export function classifyDbError(error: unknown): "transient" | "unavailable" | "other" {
  const sqlstate = pgFields(error).code;
  if (sqlstate === "40001" || sqlstate === "40P01") return "transient";
  if (sqlstate.startsWith("08") || sqlstate === "57P01" || sqlstate === "57P03") {
    return "unavailable";
  }
  return "other";
}

/**
 * Nom de la contrainte unique violée (23505), ou `null`. Permet de distinguer
 * une décision concurrente (`approvals_action_id_unique`) d'une autre violation
 * d'unicité (qui doit, elle, remonter et provoquer un rollback).
 */
export function uniqueConstraintName(error: unknown): string | null {
  const { code, constraint } = pgFields(error);
  if (code !== "23505") {
    return null;
  }
  return constraint ?? "";
}
