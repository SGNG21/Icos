import { PersistenceUnavailableError, TransientConflictError } from "@/server/database/errors";

import { apiError } from "./respond";

/**
 * Traduit une erreur inattendue attrapée par un Route Handler en réponse API
 * stable. Aucune information sensible (SQL, URL, hôte, base, secret) n'est
 * exposée : seuls des messages contrôlés sont renvoyés.
 *
 * - `PersistenceUnavailableError` → 503 `persistence_unavailable` ;
 * - `TransientConflictError` → 503 `transient_conflict` (+ `Retry-After`), invite
 *   à réessayer explicitement (aucun retry automatique serveur) ;
 * - tout le reste → 500 `internal_error`.
 */
export function toErrorResponse(error: unknown): Response {
  if (error instanceof PersistenceUnavailableError) {
    return apiError(
      "persistence_unavailable",
      "Le service de persistance est temporairement indisponible.",
    );
  }
  if (error instanceof TransientConflictError) {
    return apiError(
      "transient_conflict",
      "Conflit temporaire lors de l'opération, veuillez réessayer.",
      undefined,
      { "retry-after": "1" },
    );
  }
  return apiError("internal_error", "erreur interne");
}
