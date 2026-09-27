import { getContainer } from "@/server/container";
import { verifyExecutionCallback } from "@/server/execution/callback-auth";
import { zodDetails } from "@/server/http/errors";
import { executionCompletedBodySchema } from "@/server/http/execution-schemas";
import { toErrorResponse } from "@/server/http/map-error";
import { apiError, json, readJson } from "@/server/http/respond";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { loadEnv } from "@/config/env";

/**
 * Callback interne Temporal → ICOS : complétion durable du workflow.
 *
 * Ferme la boucle : persiste la preuve métier canonique et applique la
 * transition terminale de la tâche (`succeeded` ou `failed`). Fail-closed :
 * un échec exige une erreur normalisée ; aucun `succeeded` implicite n'est
 * possible. Idempotent par `workflowId`.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  try {
    const container = await getContainer();

    const auth = verifyExecutionCallback(request, container.executionCallbackSecret);
    if (!auth.ok) {
      if (auth.reason === "unconfigured") {
        return apiError("persistence_unavailable", "callback d'exécution non configuré");
      }
      return apiError("unauthenticated", "callback non autorisé");
    }

    const body = await readJson(request);
    if (!body.ok) {
      return apiError("invalid_input", "corps JSON invalide");
    }

    const parsed = executionCompletedBodySchema.safeParse(body.value);
    if (!parsed.success) {
      return apiError("invalid_input", "paramètres invalides", zodDetails(parsed.error));
    }

    const attempt = await container.dispatchAttempts.getByWorkflowId(parsed.data.workflowId);
    if (!attempt || attempt.taskId !== parsed.data.taskId) {
      return apiError("invalid_input", "workflow d'exécution non corrélé");
    }

    const missionTask = await container.mission.getMissionTaskByCanonicalTaskId(parsed.data.taskId);
    if (
      !missionTask ||
      missionTask.id !== attempt.missionTaskId ||
      missionTask.missionId !== attempt.missionId
    ) {
      return apiError("invalid_input", "workflow d'exécution non corrélé");
    }

    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      container.taskExecution,
      container.durableMemory,
      container.dispatchAttempts,
      undefined,
      container.capabilityRouter,
    );

    const result = await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: container.executionResults,
        missions: container.mission,
        durableMemory: container.durableMemory,
        dispatchAttempts: container.dispatchAttempts,
        supervisor,
      },
      parsed.data,
    );

    if (!result.ok) {
      if (result.reason === "task_not_found") {
        return apiError("not_found", result.message);
      }
      if (result.reason === "invalid_input") {
        return apiError("invalid_input", result.message);
      }
      return apiError("audit_failed", result.message);
    }

    // Register for quality control (fire-and-forget)
    const qualityControl = new QualityControlService({
      missions: container.mission,
      tasks: container.tasks,
      executionResults: container.executionResults,
      reviewer: container.reviewer,
      reviewDecisions: container.reviewDecisions,
      dispatchAttempts: container.dispatchAttempts,
      qualityJobs: container.qualityControlJobs,
    });
    void qualityControl.registerExecution({
      missionId: attempt.missionId,
      missionTaskId: missionTask.id,
      taskId: parsed.data.taskId,
      workflowId: parsed.data.workflowId,
    }).catch(err => {
      console.error("Failed to register for quality control:", err);
    });

    return json({
      record: result.record,
      duplicate: result.duplicate,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}