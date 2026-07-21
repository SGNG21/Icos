import type { TaskStatus } from "@/core/contracts";
import type { TaskService, TransitionTaskResult } from "@/server/services/ports";

export interface TransitionTaskDeps {
  tasks: TaskService;
}

/**
 * Transition du cycle de vie d'une tâche. Les invariants (transitions permises,
 * états terminaux, audit) sont portés par le service ; ce use case fournit un
 * point d'entrée homogène pour la couche API.
 */
export function transitionTask(
  deps: TransitionTaskDeps,
  input: { taskId: string; to: TaskStatus },
): TransitionTaskResult {
  return deps.tasks.transition(input.taskId, input.to);
}
