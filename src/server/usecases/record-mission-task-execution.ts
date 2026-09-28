import type { ExecutionError, ExecutionOutcome } from "@/core/contracts";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import type { ReviewerService } from "@/server/review/ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import type { QualityControlService } from "@/server/usecases/quality-control-service";
import type { RuntimeControlGuard } from "@/server/control/runtime-control";

import { reviewExecution } from "./review-execution";
import { saveMissionCheckpoint } from "./save-mission-checkpoint";

export interface RecordMissionTaskExecutionInput {
  missionId: string;
  /** Canonical Task.id received from the execution callback. */
  taskId: string;
  workflowId: string;
  outcome: ExecutionOutcome;
  result?: string;
  error?: ExecutionError;
  completedAt: string;
}

export interface MissionAutonomyWakeup {
  wake(
    missionId: string,
  ): Promise<unknown>;
}

export interface RecordMissionTaskExecutionDeps {
  executionResults: TaskExecutionResultRepository;
  supervisor: SupervisorService;

  /**
   * Durable autonomy continuation.
   *
   * Autonomous missions resume through AutonomousMissionRunner;
   * legacy missions retain direct Supervisor continuation.
   */
  autonomyWakeup?: MissionAutonomyWakeup;
  missions: MissionRepository;
  tasks: TaskRepository;
  reviewer: ReviewerService;
  reviewDecisions: ReviewDecisionRepository;
  taskExecution?: TaskExecutionDispatcher;
  durableMemory?: DurableMemory;
  dispatchAttempts?: DispatchAttemptRepository;
  qualityControl?: QualityControlService;
  /** Runtime control (decision 0044): a held correction stays PREPARED for reconciliation. */
  control?: Pick<RuntimeControlGuard, "dispatch">;
}

/** Two correction dispatches after the original execution. */
export const MAX_CORRECTION_ATTEMPTS = 2;

function correctionPrompt(
  originalPrompt: string,
  requestedChanges: readonly { field: string; reason: string; suggestion?: string }[],
): string {
  const changes = requestedChanges
    .map(
      (change, index) =>
        `${index + 1}. ${change.field}: ${change.reason}${
          change.suggestion ? ` (suggestion: ${change.suggestion})` : ""
        }`,
    )
    .join("\n");
  return `${originalPrompt}\n\nCorrection requested by ICOS review:\n${changes}`;
}

async function checkpoint(
  deps: RecordMissionTaskExecutionDeps,
  missionId: string,
  label: string,
): Promise<void> {
  if (!deps.durableMemory) return;
  await saveMissionCheckpoint(
    { missions: deps.missions, durableMemory: deps.durableMemory },
    { missionId, label },
  );
}

async function continueMission(
  deps: RecordMissionTaskExecutionDeps,
  missionId: string,
): Promise<void> {
  if (deps.autonomyWakeup) {
    await deps.autonomyWakeup.wake(
      missionId,
    );
    return;
  }

  await deps.supervisor.run(
    missionId,
  );
}


/**
 * Applies the review gate between an execution result and MissionTask state.
 * Review decisions and workflow IDs provide the minimal durable attempt ledger.
 */
export async function recordMissionTaskExecution(
  deps: RecordMissionTaskExecutionDeps,
  input: RecordMissionTaskExecutionInput,
): Promise<void> {
  const missionTask = await deps.missions.getMissionTaskByCanonicalTaskId(input.taskId);
  if (!missionTask || missionTask.missionId !== input.missionId) {
    throw new Error(`MissionTask inconnue pour la tâche canonique : ${input.taskId}`);
  }

  if (deps.qualityControl) {
    await deps.qualityControl.registerExecution({
      missionId: input.missionId,
      missionTaskId: missionTask.id,
      taskId: input.taskId,
      workflowId: input.workflowId,
    });
    try {
      await deps.qualityControl.processPending(input.missionId);
    } catch (error) {
      if (!(error instanceof Error && error.message === "QUALITY_CONTROL_REPLAN_READY")) {
        throw error;
      }
    }
    await checkpoint(deps, input.missionId, `After task ${missionTask.id} quality control`);
    await continueMission(deps, input.missionId);
    return;
  }

  const reviewResult = await reviewExecution(
    {
      tasks: deps.tasks,
      missions: deps.missions,
      executionResults: deps.executionResults,
      reviewer: deps.reviewer,
      reviewDecisions: deps.reviewDecisions,
    },
    {
      missionId: input.missionId,
      missionTaskId: missionTask.id,
      taskId: input.taskId,
      workflowId: input.workflowId,
    },
  );

  if (!reviewResult.ok) {
    // No terminal state and no supervisor run: callback replay can retry review.
    throw new Error(`[REVIEW] ${reviewResult.message}`);
  }

  // The worker execution is durably complete once its persisted result has
  // passed the review lookup. This operation is idempotent by workflowId.
  if (deps.dispatchAttempts) {
    await deps.dispatchAttempts.markCompletedByWorkflowId(input.workflowId);
  }

  switch (reviewResult.review.decision) {
    case "APPROVE":
      await deps.missions.updateMissionTaskStatus(input.missionId, missionTask.id, "succeeded");
      await checkpoint(deps, input.missionId, `After task ${missionTask.id} review approved`);
      await continueMission(deps, input.missionId);
      return;

    case "BLOCK":
      // MissionTask storage already supports failed everywhere; this is the
      // durable terminal representation of a blocking review.
      await deps.missions.updateMissionTaskStatus(input.missionId, missionTask.id, "failed");
      await checkpoint(deps, input.missionId, `After task ${missionTask.id} review blocked`);
      await continueMission(deps, input.missionId);
      return;

    case "ESCALATE_TO_HUMAN":
      await deps.missions.updateMissionTaskStatus(
        input.missionId,
        missionTask.id,
        "awaiting_approval",
      );
      await checkpoint(deps, input.missionId, `After task ${missionTask.id} review escalated`);
      await continueMission(deps, input.missionId);
      return;

    case "REQUEST_CHANGES": {
      const decisions = await deps.reviewDecisions.listByTaskId(input.taskId);
      const correctionAttempt = decisions.filter(
        (decision) => decision.decision === "REQUEST_CHANGES",
      ).length;

      if (correctionAttempt > MAX_CORRECTION_ATTEMPTS) {
        await deps.missions.updateMissionTaskStatus(input.missionId, missionTask.id, "failed");
        await checkpoint(
          deps,
          input.missionId,
          `After task ${missionTask.id} exhausted correction retries`,
        );
        await continueMission(deps, input.missionId);
        return;
      }

      // A replay of an already-applied review must not dispatch twice. If a
      // dispatch previously failed we restore draft below, allowing recovery.
      if (reviewResult.duplicate && missionTask.status !== "draft") return;

      const workflowId = `icos-task-${input.taskId}-correction-${correctionAttempt}`;
      const prompt = correctionPrompt(
        missionTask.description || missionTask.title,
        reviewResult.review.requestedChanges ?? [],
      );

      if (!deps.dispatchAttempts) {
        throw new Error("Correction dispatch ledger unavailable");
      }
      const prepared = await deps.dispatchAttempts.prepare({
        missionId: input.missionId,
        missionTaskId: missionTask.id,
        taskId: input.taskId,
        attempt: correctionAttempt + 1,
        workflowId,
        prompt,
        workerKind: missionTask.workerKind ?? undefined,
        capability: missionTask.capability ?? undefined,
      });
      if (!prepared.acquired) return;
      // Held (paused mission, safe mode, dispatch disabled): leave the attempt PREPARED;
      // reconcilePreparedDispatches dispatches it once control releases it.
      if (deps.control && !(await deps.control.dispatch(input.missionId)).allowed) return;
      try {
        if (!deps.taskExecution) {
          throw new Error("Correction dispatcher unavailable");
        }
        await deps.taskExecution.dispatch({
          taskId: input.taskId,
          workflowId,
          prompt,
          workerKind: missionTask.workerKind ?? undefined,
          capability: missionTask.capability ?? undefined,
        });
        await deps.dispatchAttempts.markDispatched(prepared.attempt.id);
      } catch (error) {
        throw error;
      }
      await checkpoint(
        deps,
        input.missionId,
        `After task ${missionTask.id} correction ${correctionAttempt} dispatched`,
      );
      return;
    }
  }
}
