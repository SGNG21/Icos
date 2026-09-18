import type { Task } from "@/core/contracts";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { TaskRepository } from "@/server/repositories/ports";

export interface MarkTaskRunningDeps {
  tasks: TaskRepository;
  dispatchAttempts?: DispatchAttemptRepository;
}

export interface MarkTaskRunningInput {
  taskId: string;
  workflowId: string;
}

export type MarkTaskRunningResult =
  | { ok: true; task: Task; alreadyRunning: boolean }
  | {
      ok: false;
      reason: "task_not_found" | "invalid_transition" | "audit_failed";
      message: string;
    };

/**
 * Signale à ICOS le démarrage réel du travail par le worker (Temporal Activity).
 *
 * Idempotent : si la tâche est déjà `running` (rejeu du signal), retour
 * `alreadyRunning: true` sans transition ni erreur. Terminal → refus explicite
 * (une tâche `succeeded`/`failed`/`cancelled` ne retourne jamais à `running`).
 */
export async function markTaskRunning(
  deps: MarkTaskRunningDeps,
  input: MarkTaskRunningInput,
): Promise<MarkTaskRunningResult> {
  if (deps.dispatchAttempts) {
    const authorization = await deps.dispatchAttempts.authorizeStart(
      input.taskId,
      input.workflowId,
    );
    if (authorization.ok) return authorization;
    return {
      ok: false,
      reason:
        authorization.reason === "task_not_found"
          ? "task_not_found"
          : authorization.reason === "audit_failed"
            ? "audit_failed"
            : "invalid_transition",
      message: authorization.message,
    };
  }

  const current = await deps.tasks.getById(input.taskId);
  if (!current) {
    return { ok: false, reason: "task_not_found", message: `tâche inconnue : ${input.taskId}` };
  }

  if (current.status === "running") {
    return { ok: true, task: current, alreadyRunning: true };
  }

  const transition = await deps.tasks.transition(input.taskId, "running");
  if (!transition.ok) {
    if (transition.reason === "invalid_transition") {
      return {
        ok: false,
        reason: "invalid_transition",
        message: `transition ${transition.from} → running interdite`,
      };
    }
    if (transition.reason === "task_not_found") {
      return { ok: false, reason: "task_not_found", message: transition.message };
    }
    return { ok: false, reason: "audit_failed", message: transition.message };
  }

  return { ok: true, task: transition.task, alreadyRunning: false };
}
