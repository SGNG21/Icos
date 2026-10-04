import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { MissionRepository } from "@/server/mission/ports";
import type {
  RecordTaskExecutionResultInput,
  RecordTaskExecutionResultOutcome,
} from "@/server/repositories/ports";
import type { DurableMemory } from "@/core/context/durable-memory";

export interface RecordTaskExecutionDeps {
  tasks: TaskRepository;
  executionResults: TaskExecutionResultRepository;
  /**
   * DECLARED BUT UNUSED by this usecase, and therefore OPTIONAL (M8).
   *
   * It is not removed because callers pass it and the symmetry with
   * `recordMissionTaskExecution` is worth keeping. It is optional because requiring it
   * created a real COMPOSITION CYCLE: the supervisor needs a `TaskExecutionDispatcher`,
   * and the external worker dispatcher needs to record results — so the container could
   * not build either first. A dependency nothing reads must not dictate composition order.
   */
  supervisor?: SupervisorService;
  missions: MissionRepository;
  durableMemory: DurableMemory;
  dispatchAttempts?: DispatchAttemptRepository;
}

/**
 * Ferme la boucle d'exécution : Temporal rapporte la complétion, ICOS persiste
 * la preuve métier canonique. Le statut de MissionTask reste non terminal
 * jusqu'à ce que la revue ait rendu sa décision.
 *
 * INVARIANTS :
 * - idempotent par `workflowId` : un rejeu (retry Temporal, replay de workflow,
 *   redémarrage de worker) ne duplique rien et ne produit pas d'état
 *   contradictoire ;
 * - fail-closed : un échec exige une erreur normalisée ; aucun `succeeded`
 *   implicite ne peut être produit ;
 * - corrélation vérifiée : un `workflowId` déjà associé à une AUTRE tâche est
 *   rejeté plutôt que réattribué silencieusement ;
 * - aucun appel externe : cette fonction n'exécute que des écritions ICOS
 *   courtes et déterministes.
 */
export async function recordTaskExecution(
  deps: RecordTaskExecutionDeps,
  input: RecordTaskExecutionResultInput,
): Promise<RecordTaskExecutionResultOutcome> {
  if (deps.dispatchAttempts) {
    const attempt = await deps.dispatchAttempts.getByWorkflowId(input.workflowId);

    if (!attempt || attempt.taskId !== input.taskId) {
      return {
        ok: false,
        reason: "invalid_input",
        message: "workflow d'exécution non corrélé",
      };
    }
  }

  // Corrélation : le même workflow ne peut pas changer de tâche.
  const existing = await deps.executionResults.getByWorkflowId(input.workflowId);
  if (existing && existing.taskId !== input.taskId) {
    return {
      ok: false,
      reason: "invalid_input",
      message: "workflow déjà associé à une autre tâche",
    };
  }
  // Même workflow et même tâche : `record()` reste l'arbitre de l'idempotence
  // (duplicate) ET du conflit de résultat ; ne pas court-circuiter ici.

  // Aucune création implicite de tâche : une complétion orpheline échoue.
  if (!(await deps.tasks.getById(input.taskId))) {
    return {
      ok: false,
      reason: "task_not_found",
      message: `tâche inconnue : ${input.taskId}`,
    };
  }

  // Enregistrement de l'exécution (cela inclut la transition du statut de la tâche dans le repository)
  const executionResult = await deps.executionResults.record(input);

  /*
   * THE ATTEMPT IS CLOSED HERE, where the result becomes durable.
   *
   * This is the production completion path — the internal callback route calls it — and it
   * recorded the result without ever settling the attempt. The attempt therefore stayed
   * `dispatched`, holding a slot on a worker of concurrency 1, for every execution that
   * ever succeeded. Nineteen finished executions, fifteen of them successful, ate the
   * fleet's whole capacity that way before anything noticed.
   *
   * Success must not depend on lease expiry to give the worker back: the lease is the
   * safety net for a runner that DIED, not the normal way capacity is returned.
   * Idempotent by workflowId, so a Temporal replay settles nothing twice.
   */
  if (deps.dispatchAttempts) {
    await deps.dispatchAttempts.markCompletedByWorkflowId(input.workflowId);
  }

  return executionResult;
}