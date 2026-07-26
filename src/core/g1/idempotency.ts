import type { IdempotencyKey, IdempotencyState } from "./contract";

// ─────────────────────────────────────
// Transition Rules
// ─────────────────────────────────────

const TRANSITIONS: Record<IdempotencyState, IdempotencyState[]> = {
  RESERVED: ["EXECUTING"],
  EXECUTING: ["COMPLETED", "FAILED_SAFE", "UNKNOWN"],
  COMPLETED: [],
  FAILED_SAFE: ["RESERVED"], // Retry : re-réserver
  UNKNOWN: [],
};

/**
 * Vérifie si une transition d'état d'idempotence est autorisée.
 *
 * Règles : voir la machine d'état dans contract.ts.
 *
 * @throws Error si la transition est invalide.
 */
export function assertIdempotencyTransition(
  from: IdempotencyState,
  to: IdempotencyState,
): void {
  if (from === to) {
    // Rester dans le même état est toujours autorisé
    // (utilisé pour les lectures / rejeu).
    return;
  }

  const allowed = TRANSITIONS[from];
  if (!allowed) {
    throw new Error(
      `Transition d'état invalide : '${from}' → '${to}' (état source inconnu)`,
    );
  }

  if (!allowed.includes(to)) {
    throw new Error(
      `Transition d'état invalide : '${from}' → '${to}' (interdite par la machine d'état G1)`,
    );
  }
}

/**
 * Retourne les états terminaux : aucune transition sortante autorisée.
 */
export function isIdempotencyTerminal(state: IdempotencyState): boolean {
  return TRANSITIONS[state].length === 0;
}

/**
 * Vérifie si un état EXECUTING est considéré comme stale.
 *
 * @param updatedAt Date ISO de dernière mise à jour.
 * @param staleThresholdMs Seuil de staleness en ms (défaut = 5 minutes).
 */
export function isStaleExecuting(
  updatedAt: string,
  staleThresholdMs = 300_000,
): boolean {
  const elapsed = Date.now() - new Date(updatedAt).getTime();
  return elapsed > staleThresholdMs;
}

/**
 * Un état UNKNOWN ne peut JAMAIS être rejoué automatiquement.
 * La réconciliation manuelle est toujours requise.
 */
export function canAutoReplay(state: IdempotencyState): boolean {
  switch (state) {
    case "COMPLETED":
      return true; // Rejeu idempotent
    case "FAILED_SAFE":
      return true; // Retry autorisé (pas d'effet durable)
    case "RESERVED":
      return true; // Stale reserve peut être repris
    case "UNKNOWN":
      return false; // JAMAIS de rejeu automatique
    case "EXECUTING":
      return false; // En cours, pas de rejeu
  }
}

/**
 * Résultat de validation pour une tentative de réservation.
 */
export interface IdempotencyValidation {
  allowed: boolean;
  /** Code de conflit si non autorisé. */
  conflictCode?: "IDEMPOTENCY_CONFLICT" | "ALREADY_COMPLETED";
  /** Résultat du rejeu si COMPLETED. */
  replayResult?: unknown;
  /** Message explicatif. */
  message: string;
}
