import type { WorkerStatus } from "./contract";
import { TERMINAL_WORKER_STATUSES } from "./contract";

/**
 * Transitions valides d'un worker.
 * La clé est l'état source, la valeur est l'ensemble des états cibles autorisés.
 */
const VALID_TRANSITIONS: Record<WorkerStatus, readonly WorkerStatus[]> = {
  CREATED: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "FAILED", "TIMED_OUT", "CANCELLED", "LOST"],
  SUCCEEDED: [],
  FAILED: [],
  TIMED_OUT: [],
  CANCELLED: [],
  LOST: [],
};

/**
 * Vérifie si une transition est autorisée.
 */
export function isWorkerTransitionAllowed(
  from: WorkerStatus,
  to: WorkerStatus,
): boolean {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

/**
 * Retourne les transitions autorisées depuis un état donné.
 */
export function allowedWorkerTransitionsFrom(
  status: WorkerStatus,
): readonly WorkerStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

/**
 * Vrai si l'état du worker est terminal.
 */
export function isWorkerTerminal(status: WorkerStatus): boolean {
  return (TERMINAL_WORKER_STATUSES as readonly string[]).includes(status);
}
