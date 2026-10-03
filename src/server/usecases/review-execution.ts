import type { TaskExecutionResult } from "@/core/contracts";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { ReviewerService } from "@/server/review/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import type { TaskRepository } from "@/server/repositories/ports";
import { runWithAttribution } from "@/server/budget/attribution-context";
import type { MissionRepository } from "@/server/mission/ports";

export interface ReviewExecutionDeps {
  tasks: TaskRepository;
  missions: MissionRepository;
  executionResults: {
    getByTaskId(taskId: string): Promise<TaskExecutionResult | null>;
    getByWorkflowId(workflowId: string): Promise<TaskExecutionResult | null>;
  };
  reviewer: ReviewerService;
  reviewDecisions: ReviewDecisionRepository;
}

export interface ReviewExecutionInput {
  missionId: string;
  missionTaskId: string;
  taskId: string;
  workflowId: string;
}

export type ReviewExecutionResult =
  | { ok: true; review: ReviewDecisionRecord; duplicate: boolean }
  | {
      ok: false;
      reason:
        | "mission_not_found"
        | "mission_task_not_found"
        | "task_not_found"
        | "execution_result_not_found"
        | "review_failed";
      message: string;
    };

/**
 * Effectue la revue d'un résultat d'exécution après enregistrement.
 *
 * Flux :
 * 1. Charge mission, missionTask, task, executionResult
 * 2. Construit ReviewInput complet
 * 3. Appelle ReviewerService.review()
 * 4. Persiste la décision via ReviewDecisionRepository
 * 5. Retourne la décision
 *
 * Idempotence : par workflowId (même clé que TaskExecutionResult).
 */
export async function reviewExecution(
  deps: ReviewExecutionDeps,
  input: ReviewExecutionInput,
): Promise<ReviewExecutionResult> {
  // Replays must not invoke review infrastructure again. If a previous review
  // failed there is no record, so the same callback remains recoverable.
  const existingReview = await deps.reviewDecisions.getByWorkflowId(input.workflowId);
  if (existingReview) {
    return { ok: true, review: existingReview, duplicate: true };
  }

  // 1. Charger la mission
  const mission = await deps.missions.findById(input.missionId);
  if (!mission) {
    return {
      ok: false,
      reason: "mission_not_found",
      message: `Mission inconnue : ${input.missionId}`,
    };
  }

  // 2. Charger la MissionTask
  const missionTask = await deps.missions.getMissionTaskById(input.missionTaskId);
  if (!missionTask) {
    return {
      ok: false,
      reason: "mission_task_not_found",
      message: `MissionTask inconnue : ${input.missionTaskId}`,
    };
  }

  // 3. Charger la tâche canonique
  const task = await deps.tasks.getById(input.taskId);
  if (!task) {
    return {
      ok: false,
      reason: "task_not_found",
      message: `Tâche canonique inconnue : ${input.taskId}`,
    };
  }

  // 4. Charger le résultat d'exécution
  const executionResult = await deps.executionResults.getByWorkflowId(input.workflowId);
  if (!executionResult) {
    return {
      ok: false,
      reason: "execution_result_not_found",
      message: `Résultat d'exécution inconnu pour workflow : ${input.workflowId}`,
    };
  }

  // 5. Construire l'entrée de revue complète
  const reviewInput = {
    mission,
    missionTask,
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
    },
    executionResult,
    artifacts: executionResult.artifacts ?? [],
    evidence: executionResult.evidence ?? [],
    findings: executionResult.findings ?? [],
  };

  // 6. Effectuer la revue
  let review: ReviewDecisionRecord;
  try {
    /*
     * PORTÉE D'IMPUTATION DE LA RELECTURE (décision du propriétaire : budget de relecture
     * système, strictement borné).
     *
     * Une relecture appelle un modèle, donc elle dépense, donc elle doit être imputée.
     * Deux cas, et UN SEUL repli possible :
     *
     *   mission AVEC goal  -> BUDGET DU GOAL, et rien d'autre. Si ce budget n'est pas
     *                         applicable, la relecture ÉCHOUE. Elle ne retombe jamais sur
     *                         le budget de relecture système : ce repli-là transformerait
     *                         « mon goal n'a plus de budget » en « relis quand même », et
     *                         viderait le plafond de son sens.
     *
     *   mission SANS goal  -> BUDGET DE RELECTURE SYSTÈME, par mission, strictement borné.
     *                         Une relecture indépendante est un CONTRÔLE DE SÛRETÉ : la
     *                         refuser faute de budget n'est pas « fermé par défaut », c'est
     *                         éteindre le contrôle. Une mission générique n'a pourtant
     *                         aucun budget d'exécution à débiter — d'où ce cas, et aucun
     *                         autre.
     *
     * POURQUOI ON NE PEUT PAS CONTOURNER. `goalId` n'est PAS une entrée de cette fonction :
     * il est lu sur la MISSION PERSISTÉE, chargée à l'étape 1 par son id. Un appelant ne
     * peut donc pas l'omettre pour obtenir le budget souple — il n'a jamais eu la main
     * dessus. Et `attributionKey` donne de toute façon la priorité au goal, donc même une
     * imputation portant les deux tombe sur le goal.
     */
    const scope = mission.goalId
      ? { goalId: mission.goalId }
      : { systemReviewMissionId: mission.id };
    review = await runWithAttribution(scope, () => deps.reviewer.review(reviewInput));
  } catch (error) {
    return {
      ok: false,
      reason: "review_failed",
      message: `Échec de la revue : ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // 7. Persister la décision (idempotent par workflowId)
  // The callback correlation is authoritative. Some reviewer adapters create
  // provisional identifiers; normalize them before the single persistence
  // boundary owned by this use case.
  const saved = await deps.reviewDecisions.save({
    ...review,
    missionId: input.missionId,
    taskId: input.taskId,
    workflowId: input.workflowId,
  });
  return { ok: true, review: saved, duplicate: false };
}
