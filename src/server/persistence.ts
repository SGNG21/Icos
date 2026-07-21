import type { Env } from "@/config/env";

export type Backend = "memory" | "postgres";

/** Configuration `PERSISTENCE=postgres` valide mais backend pas encore fourni. */
export class BackendNotImplementedError extends Error {
  readonly code = "backend_not_implemented" as const;
  constructor(backend: Backend) {
    super(`Le backend de persistance « ${backend} » n'est pas encore implémenté (Lot 2A-2).`);
    this.name = "BackendNotImplementedError";
  }
}

/** Configuration de persistance invalide (ex. production sans `PERSISTENCE`). */
export class PersistenceConfigError extends Error {
  readonly code = "persistence_config_invalid" as const;
  constructor(message: string) {
    super(message);
    this.name = "PersistenceConfigError";
  }
}

/**
 * Résolution déterministe du backend, sans jamais de bascule silencieuse.
 *
 * - développement sans `PERSISTENCE` → `memory` ;
 * - test sans `PERSISTENCE` → `memory` ;
 * - production sans `PERSISTENCE` → erreur ;
 * - `PERSISTENCE=memory` → `memory` ;
 * - `PERSISTENCE=postgres` → `postgres` (le container lèvera ensuite
 *   `BackendNotImplementedError` — aucun repli vers `memory`) ;
 * - valeur inconnue → déjà rejetée par la validation Zod de `loadEnv`.
 */
export function resolvePersistence(env: Env): Backend {
  if (env.PERSISTENCE === undefined) {
    if (env.NODE_ENV === "production") {
      throw new PersistenceConfigError(
        "PERSISTENCE doit être défini explicitement en production (aucune valeur par défaut).",
      );
    }
    return "memory";
  }
  return env.PERSISTENCE;
}
