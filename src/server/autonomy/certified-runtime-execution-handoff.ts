import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import type { WorkspaceManager } from "@/server/workspace-manager/manager";
import type {
  CanonicalExecutionHandoff,
  CanonicalExecutionRequest,
  CanonicalExecutionResult,
  CanonicalRepairRequest,
} from "./governed-self-development-coordinator";

/**
 * THE adapter that enters the CERTIFIED runtime path (M11, defect 25 link 2).
 *
 * `CanonicalExecutionHandoff` was an injected function, so self-development executed through
 * whatever a caller supplied. Composing the coordinator would NOT have fixed that: it would
 * still have bypassed everything CORE3 certifies — runtime-based dispatch, governed workspace
 * allocation, capability routing, the execution lease and recovery. An injected seam is not
 * neutral; it is a second execution authority waiting to diverge.
 *
 * THIS DUPLICATES NO SEMANTICS. It calls `supervisor.run(missionId)` — the same entry point
 * an ordinary autonomous mission uses — and then READS the durable state that path produced:
 * the registered workspace, the dispatch attempt's assigned worker, the recorded execution
 * result. It decides nothing about allocation, routing, leasing or recovery, because those
 * decisions already have owners.
 *
 * IT FAILS CLOSED WITHOUT A GOVERNED WORKSPACE. If no registered workspace exists for the
 * attempt's workflow, the certified path did not run — the work went somewhere else — and
 * this refuses rather than handing the coordinator a result it cannot govern. That refusal is
 * what makes a regression to the bypass detectable instead of silent.
 */

export interface CertifiedRuntimeExecutionHandoffDeps {
  /** The certified entry point. The same one ordinary autonomous work goes through. */
  supervisor: { run(missionId: string, signal?: AbortSignal): Promise<unknown> };
  workspaces: Pick<WorkspaceManager, "list">;
  dispatchAttempts: Pick<DispatchAttemptRepository, "getByWorkflowId">;
  executionResults: Pick<TaskExecutionResultRepository, "getByWorkflowId">;
}

export class CertifiedRuntimeExecutionHandoff implements CanonicalExecutionHandoff {
  constructor(private readonly deps: CertifiedRuntimeExecutionHandoffDeps) {}

  execute(input: CanonicalExecutionRequest): Promise<CanonicalExecutionResult> {
    return this.runCertified(input.missionId, input.taskId, 1, input);
  }

  /**
   * A repair is the SAME certified path on the next attempt, not a different mechanism.
   *
   * The attempt number comes from the canonical workflow id the coordinator already holds,
   * so a repair continues the same logical task rather than starting a parallel one.
   */
  repair(input: CanonicalRepairRequest): Promise<CanonicalExecutionResult> {
    return this.runCertified(
      input.missionId,
      input.taskId,
      attemptOf(input.canonicalWorkflowId, input.taskId) + 1,
      input,
    );
  }

  private async runCertified(
    missionId: string,
    taskId: string,
    attempt: number,
    request: CanonicalExecutionRequest,
  ): Promise<CanonicalExecutionResult> {
    /*
     * ENTER the certified path. Everything that matters — readiness, governed allocation,
     * routing, worker selection, lease, dispatch, recovery — happens inside this call, owned
     * by the components CORE3 certifies.
     */
    await this.deps.supervisor.run(missionId);

    const workflowId = workflowIdForAttempt(taskId, attempt);

    const workspace = (await this.deps.workspaces.list()).find(
      (w) => w.workflowId === workflowId && w.releasedAt === null,
    );
    if (!workspace) {
      /*
       * THE BYPASS DETECTOR. A governed workspace is allocated during attempt preparation for
       * every writer (decision 0042). Its absence means the work did not go through the
       * certified path, and a result produced outside governance must never be reviewed,
       * gated or integrated as though it had been.
       */
      return {
        status: "UNKNOWN",
        reason: `NO_GOVERNED_WORKSPACE:${workflowId} — the certified path did not allocate one`,
      };
    }
    if (!workspace.leaseOwner) {
      /* A workspace nobody holds cannot authorise an integration later. */
      return { status: "UNKNOWN", reason: `NO_WORKSPACE_LEASE:${workspace.workspaceId}` };
    }

    const dispatchAttempt = await this.deps.dispatchAttempts.getByWorkflowId(workflowId);
    if (!dispatchAttempt?.workerId) {
      /* No routed worker means no producer identity, so reviewer independence is unprovable. */
      return { status: "UNKNOWN", reason: `NO_ROUTED_WORKER:${workflowId}` };
    }

    const executionResult = await this.deps.executionResults.getByWorkflowId(workflowId);
    if (!executionResult) {
      /* Still running, or recovery will reclaim it. Not a failure — simply not done yet. */
      return { status: "UNKNOWN", reason: `NO_EXECUTION_RESULT:${workflowId}` };
    }

    return {
      status: "COMPLETED",
      candidateId: request.candidate.id,
      missionId,
      missionTaskId: request.missionTaskId,
      taskId,
      workspaceId: workspace.workspaceId,
      /* The lease the CERTIFIED path took. Integration is fenced by the same evidence. */
      workspaceLease: { owner: workspace.leaseOwner, fencingToken: workspace.fencingToken },
      producerWorkerId: dispatchAttempt.workerId,
      executionResult,
    };
  }
}

/** Recovers the attempt number from a canonical workflow id. Attempt 1 has no suffix. */
function attemptOf(workflowId: string, taskId: string): number {
  const prefix = `icos-task-${taskId}-attempt-`;
  if (!workflowId.startsWith(prefix)) return 1;
  const parsed = Number.parseInt(workflowId.slice(prefix.length), 10);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}
