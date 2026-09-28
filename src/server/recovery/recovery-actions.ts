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
  dispatchAttempts: Pick<
    DispatchAttemptRepository,
    "getByWorkflowId" | "recordExecutionFailure"
  >;
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

    /**
     * M7 — reclaims an EXTERNAL WORKER execution whose lease expired (decision 0039).
     *
     * ORDER MATTERS. The attempt is settled FIRST, because that is what frees the
     * capacity: durable load is derived by counting non-terminal attempts, so an
     * attempt left `dispatched` holds its worker's slot for ever. That lost slot — not
     * the missing result — is defect 17.
     *
     * The failure class is LEASE_EXPIRED, which maps to the fail-closed UNKNOWN_EFFECT:
     * the worker died mid-run, so we do not know what it had already written. Its
     * branch survives as evidence either way.
     *
     * No resume token is carried. The runner died before recording one, and inventing
     * a continuation from an unknown state would be worse than starting clean.
     */
    async reclaimAbandonedExecution(ref: RecoveryDispatchRef) {
      /*
       * A real result landing between the scan and here means the worker finished after
       * all. A late real callback always wins: never overwrite it, and never settle an
       * attempt whose work actually completed.
       */
      if (await deps.executionResults.getByWorkflowId(ref.workflowId)) return;

      await deps.dispatchAttempts.recordExecutionFailure(ref.id, {
        failureClass: "LEASE_EXPIRED",
        message: `RECOVERY_EXECUTION_LEASE_EXPIRED: attempt ${ref.attempt} of ${ref.missionTaskId} was abandoned by its runner (recovered by M7).`,
      });

      const recorded = await deps.executionResults.record({
        taskId: ref.taskId,
        workflowId: ref.workflowId,
        /* A worker/infrastructure failure — never a success. */
        outcome: "failure",
        error: {
          code: "UNKNOWN_EFFECT",
          message:
            "External worker execution lease expired without a result; effect unknown (recovered by M7).",
        },
        completedAt: now().toISOString(),
      });
      if (!recorded.ok && !(await deps.executionResults.getByWorkflowId(ref.workflowId))) {
        throw new Error("RECOVERY_ABANDONED_EXECUTION_RECORD_FAILED");
      }
    },
  };
}
