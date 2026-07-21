import type { Task, TaskStatus } from "@/core/contracts";

/**
 * Transitions autorisées du cycle de vie d'une tâche. Les statuts terminaux
 * (`succeeded`, `failed`, `cancelled`) n'autorisent aucune sortie : aucun
 * retour implicite vers un état actif n'est possible.
 */
const allowedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ["queued", "cancelled"],
  queued: ["awaiting_approval", "running", "cancelled"],
  awaiting_approval: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export type TransitionResult =
  | { ok: true; task: Task }
  | { ok: false; reason: "invalid_transition"; from: TaskStatus; to: TaskStatus };

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (allowedTransitions[from] ?? []).includes(to);
}

/**
 * Applique une transition sans modifier la tâche reçue. Une transition
 * invalide retourne un refus typé, jamais une exception.
 */
export function transitionTask(
  task: Task,
  to: TaskStatus,
  at: string = new Date().toISOString(),
): TransitionResult {
  if (!canTransition(task.status, to)) {
    return { ok: false, reason: "invalid_transition", from: task.status, to };
  }

  return { ok: true, task: { ...task, status: to, updatedAt: at } };
}
