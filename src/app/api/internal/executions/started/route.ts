import { getContainer } from "@/server/container";
import { verifyExecutionCallback } from "@/server/execution/callback-auth";
import { zodDetails } from "@/server/http/errors";
import { executionStartedBodySchema } from "@/server/http/execution-schemas";
import { toErrorResponse } from "@/server/http/map-error";
import { apiError, json, readJson } from "@/server/http/respond";
import { markTaskRunning } from "@/server/usecases/mark-task-running";

/**
 * Callback interne Temporal → ICOS : démarrage réel du travail par le worker.
 *
 * SÉCURITÉ : authentification par en-tête `x-icos-callback-secret` comparé en
 * temps constant. Aucune session utilisateur, aucun cookie. Le secret n'est
 * jamais journalisé ni renvoyé.
 * IDEMPOTENCE : rejouer le callback (retry Temporal, replay) ne cause pas
 * d'erreur si la tâche est déjà `running`.
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

    const parsed = executionStartedBodySchema.safeParse(body.value);
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

    const result = await markTaskRunning(
      {
        tasks: container.tasks,
        dispatchAttempts: container.dispatchAttempts,
      },
      { taskId: parsed.data.taskId, workflowId: parsed.data.workflowId },
    );

    if (!result.ok) {
      if (result.reason === "task_not_found") {
        return apiError("not_found", result.message);
      }
      if (result.reason === "invalid_transition") {
        return apiError("invalid_transition", result.message);
      }
      return apiError("audit_failed", result.message);
    }

    return json({
      task: result.task,
      alreadyRunning: result.alreadyRunning,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
