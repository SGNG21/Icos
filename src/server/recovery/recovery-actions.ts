import type { RecoveryDispatchRef } from "@/core/contracts/recovery";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { AutonomousSupervisor } from "@/server/autonomy/autonomous-mission-runner";
import type { RuntimeRecoveryActions } from "@/server/recovery/runtime-recovery-sweeper";

export interface RecoveryActionDeps {
  wakeup: { wake(missionId: string): Promise<unknown> };
  supervisor: Pick<AutonomousSupervisor, "reconcilePreparedDispatches">;
  dispatcher: TaskExecutionDispatcher;
  missions: Pick<MissionRepository, "getMissionTaskById">;
  executionResults: Pick<TaskExecutionResultRepository, "getByWorkflowId" | "record">;
  dispatchAttempts: Pick<DispatchAttemptRepository, "getByWorkflowId">;
  digitalosFacadePath?: string;
  now?: () => Date;
}

/** Branche les effets de reprise sur les services canoniques (aucune logique d'exécution nouvelle). */
export function createRecoveryActions(deps: RecoveryActionDeps): RuntimeRecoveryActions {
  const now = deps.now ?? (() => new Date());

  return {
    wake: (missionId) => deps.wakeup.wake(missionId),

    reconcileDispatches: (missionId) => deps.supervisor.reconcilePreparedDispatches(missionId),

    async redispatch(ref: RecoveryDispatchRef) {
      const attempt = await deps.dispatchAttempts.getByWorkflowId(ref.workflowId);
      if (!attempt) throw new Error("RECOVERY_DISPATCH_ATTEMPT_NOT_FOUND");
      const result = await deps.dispatcher.dispatch({
        missionId: attempt.missionId,
        taskId: attempt.taskId,
        taskTitle: (await deps.missions.getMissionTaskById(attempt.missionTaskId))?.title,
        prompt: attempt.prompt,
        // Same deterministic workflowId: Temporal (REJECT_DUPLICATE + USE_EXISTING) can never fork it.
        workflowId: attempt.workflowId,
        workerKind: attempt.workerKind,
        capability: attempt.capability,
        digitalosFacadePath: deps.digitalosFacadePath,
      });
      if (result.workflowId !== attempt.workflowId) {
        throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
      }
    },

    async recordLostExecution(ref: RecoveryDispatchRef) {
      // A late real callback wins: never overwrite or duplicate a persisted result.
      if (await deps.executionResults.getByWorkflowId(ref.workflowId)) return;
      const recorded = await deps.executionResults.record({
        taskId: ref.taskId,
        workflowId: ref.workflowId,
        // A worker/infrastructure failure — never a success, never a reviewer failure.
        outcome: "failure",
        error: {
          code: "UNKNOWN_EFFECT",
          message: "Workflow closed without an ICOS completion callback (recovered by 7C).",
        },
        completedAt: now().toISOString(),
      });
      if (!recorded.ok && !(await deps.executionResults.getByWorkflowId(ref.workflowId))) {
        throw new Error("RECOVERY_LOST_EXECUTION_RECORD_FAILED");
      }
    },
  };
}
