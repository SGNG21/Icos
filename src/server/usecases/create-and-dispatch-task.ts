import type { Task } from "@/core/contracts";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { AgentLookup, CreateTaskInput, TaskRepository } from "@/server/repositories/ports";

import { createTask } from "./create-task";

export interface CreateAndDispatchTaskDeps {
  tasks: TaskRepository;
  agents: AgentLookup;
  taskExecution: TaskExecutionDispatcher;
}

export type CreateAndDispatchTaskResult =
  | {
      ok: true;
      task: Task;
      workflowId: string;
    }
  | {
      ok: false;
      reason:
        "invalid_input" | "agent_not_found" | "audit_failed" | "dispatch_failed" | "queue_failed";
      message: string;
    };

/**
 * Crée une Task en `draft`, la dispatche vers Temporal, puis applique la
 * transition `draft → queued` pour refléter qu'elle est réellement prise en
 * charge par le moteur d'exécution durable.
 *
 * Le retour final (`succeeded` / `failed`) est appliqué par le callback
 * Temporal → ICOS via `recordTaskExecution` ; ce use case ne fait rien de plus.
 *
 * INVARIANTS :
 * - aucun appel externe dans une transaction DB (dispatch ≠ écriture DB) ;
 * - si le dispatch échoue, la Task reste `draft` : l'utilisateur voit l'échec
 *   et peut réessayer proprement (pas de trace fantôme `queued`) ;
 * - si le dispatch réussit mais que la transition `draft → queued` échoue
 *   (course concurrente, indisponibilité audit), on retourne `queue_failed`
 *   MAIS le workflow Temporal est déjà lancé : la boucle de complétion pourra
 *   toujours réconcilier via `recordTaskExecution`.
 */
export async function createAndDispatchTask(
  deps: CreateAndDispatchTaskDeps,
  input: CreateTaskInput,
): Promise<CreateAndDispatchTaskResult> {
  const created = await createTask(
    {
      tasks: deps.tasks,
      agents: deps.agents,
    },
    input,
  );

  if (!created.ok) {
    return created;
  }

  let workflowId: string;
  try {
    const dispatched = await deps.taskExecution.dispatch({
      taskId: created.task.id,
      prompt: input.description ?? input.title,
    });
    workflowId = dispatched.workflowId;
  } catch {
    return {
      ok: false,
      reason: "dispatch_failed",
      message: "échec du démarrage de l'exécution",
    };
  }

  const queued = await deps.tasks.transition(created.task.id, "queued");
  if (!queued.ok) {
    // Le workflow tourne côté Temporal ; la boucle de complétion arrivera
    // quand même. On surface l'anomalie sans casser la promesse durable.
    return {
      ok: false,
      reason: "queue_failed",
      message: `dispatch réussi mais mise en file échouée : ${
        "message" in queued ? queued.message : "transition invalide"
      }`,
    };
  }

  return {
    ok: true,
    task: queued.task,
    workflowId,
  };
}
