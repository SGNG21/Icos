import { getContainer } from "@/server/container";
import { verifyExecutionCallback } from "@/server/execution/callback-auth";
import { zodDetails } from "@/server/http/errors";
import { executionCompletedBodySchema } from "@/server/http/execution-schemas";
import { toErrorResponse } from "@/server/http/map-error";
import { apiError, json, readJson } from "@/server/http/respond";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { finalizeSuccessfulWorkerExecution } from "@/server/usecases/finalize-successful-worker-execution";
import { commitWorkerChanges } from "@/server/workspace-manager/git-authority";
import { Git } from "@/server/workspace-manager/git";
import { QualityControlService } from "@/server/usecases/quality-control-service";
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
      /*
       * WHICH correlation failed. Two different invariants shared one message, and a
       * refused callback is invisible from outside: the dispatch succeeded, the worker
       * reported, ICOS refused, Temporal retried twenty times, and the attempt sat
       * `dispatched` for ever. The message is unchanged — it is the stable contract — and
       * the discriminator rides in `details`, a fixed code, never a field value.
       */
      return apiError("invalid_input", "workflow d'exécution non corrélé", {
        reason: !attempt ? "EXECUTION_ATTEMPT_UNKNOWN" : "EXECUTION_ATTEMPT_TASK_MISMATCH",
      });
    }

    const missionTask = await container.mission.getMissionTaskByCanonicalTaskId(parsed.data.taskId);
    if (
      !missionTask ||
      missionTask.id !== attempt.missionTaskId ||
      missionTask.missionId !== attempt.missionId
    ) {
      /* Same discrimination for the MISSION-TASK invariant, which shared the message. */
      return apiError("invalid_input", "workflow d'exécution non corrélé", {
        reason: !missionTask
          ? "MISSION_TASK_UNKNOWN"
          : missionTask.id !== attempt.missionTaskId
            ? "MISSION_TASK_ATTEMPT_MISMATCH"
            : "MISSION_TASK_MISSION_MISMATCH",
      });
    }

    /*
     * No supervisor is built here (P0, 2026-09-30). This route used to construct an ungoverned
     * `SupervisorService` (no workspace coordinator) and hand it to `recordTaskExecution`, which
     * never reads it. The HTTP layer constructs no execution authority: continuation is the
     * durable wake-up / scheduler path's job.
     */
    /*
     * MATERIALIZE BEFORE THE RESULT IS DURABLE (ADR 0073), because the moment it is durable
     * the review may claim it — and a review must judge a commit, never a loose tree. The
     * worker holds no Git authority, so this is the only place its work becomes a commit on
     * the Temporal path. Fail-closed: a refusal is reported as a failed completion rather
     * than recorded as a success nobody can integrate.
     */
    /* Set when the trusted capture refused; it becomes the recorded outcome below. */
    let refusal: string | null = null;
    if (parsed.data.outcome === "success" && container.workspaceManager) {
      const finalized = await finalizeSuccessfulWorkerExecution(
        {
          workspaces: container.workspaceManager,
          /* Built per execution, from the row — never the container's pinned port. */
          gitFor: (repoDir) => new Git(repoDir),
          materialize: commitWorkerChanges,
          tasks: container.tasks,
        },
        { workflowId: parsed.data.workflowId, taskId: parsed.data.taskId },
      );
      if (!finalized.finalized) {
        refusal = finalized.reason;
      }
    }

    /*
     * THE REFUSAL IS THE OUTCOME. Recorded through the same path as any other failure, so the
     * review, the gate and settlement all see it; answering the callback with an error instead
     * left the execution with no recorded result at all and the task hung.
     */
    const recorded = refusal
      ? {
          taskId: parsed.data.taskId,
          workflowId: parsed.data.workflowId,
          outcome: "failure" as const,
          workerKind: parsed.data.workerKind,
          startedAt: parsed.data.startedAt,
          completedAt: parsed.data.completedAt,
          error: {
            code: "INVALID_RESULT" as const,
            message: `GOVERNED_WORK_NOT_MATERIALIZED: ${refusal}`.slice(0, 500),
          },
        }
      : parsed.data;

    const result = await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: container.executionResults,
        missions: container.mission,
        durableMemory: container.durableMemory,
        dispatchAttempts: container.dispatchAttempts,
      },
      recorded,
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