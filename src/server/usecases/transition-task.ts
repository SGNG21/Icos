import type { TaskStatus } from "@/core/contracts";
import type { TaskRepository, TransitionTaskResult } from "@/server/repositories/ports";

export interface TransitionTaskDeps {
  tasks: TaskRepository;
}

/**
 * Transition du cycle de vie d'une tâche. Les invariants (transitions permises,
 * états terminaux, audit) sont portés par le repository ; ce use case fournit un
 * point d'entrée homogène pour la couche API.
 */
export function transitionTask(
  deps: TransitionTaskDeps,
  input: { taskId: string; to: TaskStatus },
): Promise<TransitionTaskResult> {
  return deps.tasks.transition(input.taskId, input.to);
}
