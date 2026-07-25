import type { ExecutionStatus } from "./contract";
import { TERMINAL_EXECUTION_STATUSES } from "./contract";

/**
 * Transitions valides entre états d'exécution D4.
 * La clé est l'état source, la valeur est l'ensemble des états cibles autorisés.
 *
 * INVARIANT : les états terminaux n'ont aucune transition sortante.
 */
const VALID_TRANSITIONS: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  STARTING: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "LOST"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
  TIMED_OUT: [],
  LOST: [],
};

/**
 * Vérifie si une transition est autorisée par la machine d'état.
 */
export function isExecutionTransitionAllowed(
  from: ExecutionStatus,
  to: ExecutionStatus,
): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) {
    return false;
  }
  return allowed.includes(to);
}

/**
 * Retourne les transitions autorisées depuis un état donné.
 */
export function allowedExecutionTransitionsFrom(
  status: ExecutionStatus,
): readonly ExecutionStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/**
 * Vrai si l'état est terminal (aucune transition sortante).
 */
export function isExecutionTerminal(status: ExecutionStatus): boolean {
  return (TERMINAL_EXECUTION_STATUSES as readonly string[]).includes(status);
}
