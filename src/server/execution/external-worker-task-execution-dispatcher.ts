import { randomUUID } from "node:crypto";

import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import {
  toExecutionErrorCode,
  workerTaskContractSchema,
  type WorkerExecutionOutcome,
  type WorkerFailureClass,
  type WorkerTaskContract,
} from "@/core/contracts/worker-execution";
import type { Artifact, Evidence } from "@/core/contracts/task-execution";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository, TaskRepository } from "@/server/repositories/ports";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import type { WorkerExecutor } from "@/server/workers/execution/worker-executor";
import {
  provisionWorkspace,
  type WorkerWorkspace,
  type WorkspaceMode,
} from "@/server/workers/execution/writer-workspace";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "./ports";

/**
 * Plugs the external worker executor into the EXISTING dispatcher boundary
 * (M6.3, requirement 9).
 *
 * WHY IT IMPLEMENTS TaskExecutionDispatcher INSTEAD OF BEING A NEW ENTRY POINT
 * The supervisor already dispatches through `TaskExecutionDispatcher`, and that
 * path is certified by CORE1/CORE2. Adding a parallel "external worker path" would
 * mean two places that create attempts, two places that record results and two
 * places to keep exactly-once correct — the duplicate execution path requirement 9
 * forbids. So this is an ADAPTER at the existing seam: same interface, same
 * `recordTaskExecution` usecase, same ledger.
 *
 * WHAT IT ADDS BETWEEN THOSE TWO POINTS
 *   - an execution LEASE, so only one runner may report for one logical attempt;
 *   - an isolated WORKSPACE, so a writer never touches the canonical checkout;
 *   - RESUME state carried forward, so a retry continues instead of restarting;
 *   - the operational FAILURE CLASS persisted on the attempt, so the retry decision
 *     survives the process that made the observation.
 *
 * IT DOES NOT INTEGRATE. A successful run leaves a branch and records it as
 * evidence; merging that branch is a separate, later decision. An executor that
 * also integrated would be able to land unreviewed work, which is exactly what the
 * isolation is for.
 */

export interface ExternalWorkerDispatcherDeps {
  executor: WorkerExecutor;
  workers: WorkerRegistryStore;
  dispatchAttempts: DispatchAttemptRepository;
  executionResults: TaskExecutionResultRepository;
  missions: MissionRepository;
  tasks: TaskRepository;
  /** Optional: `recordTaskExecution` does not read it, and requiring it would force a
   * composition cycle on the container (the supervisor needs a dispatcher). */
  supervisor?: SupervisorService;
  durableMemory: DurableMemory;
  /** The canonical repository. A writer is guaranteed NOT to run here. */
  repoPath: string;
  /** How long one execution may hold its fence. */
  leaseMs?: number;
  /** Where worker worktrees are created. */
  workspaceRoot?: string;
  /**
   * Writer or reader, per dispatch. Defaults to WRITER — the isolated option. A
   * wrong guess towards writer costs a worktree; a wrong guess towards reader lets
   * a worker loose in the canonical checkout.
   */
  workspaceMode?: (input: TaskExecutionDispatchInput) => WorkspaceMode;
  /**
   * Supplies a GOVERNED workspace instead of provisioning an ad-hoc one (M8, defect 19).
   *
   * When this returns a workspace, the worker runs in a REGISTERED `Workspace` that the
   * WorkspaceManager owns — so the Integration Gate can evaluate it, the applier can
   * integrate it and cleanup can reap it. Without it the executor provisions its own
   * worktree, which is fine for an isolated run but produces a branch no governed path
   * ever sees. That orphaning was defect 19's other half.
   *
   * A supplied workspace is NOT disposed here: its owner controls its lifecycle, and the
   * gate needs the worktree to still exist after execution finishes.
   */
  workspaceFor?: (input: TaskExecutionDispatchInput) => Promise<WorkerWorkspace | null>;
  /** Identifies this runner in the lease. Defaults to a per-instance uuid. */
  owner?: string;
}

export const DEFAULT_EXECUTION_LEASE_MS = 20 * 60_000;

export class ExternalWorkerTaskExecutionDispatcher implements TaskExecutionDispatcher {
  private readonly owner: string;
  private readonly leaseMs: number;

  constructor(private readonly deps: ExternalWorkerDispatcherDeps) {
    this.owner = deps.owner ?? `icos-runner-${randomUUID()}`;
    this.leaseMs = deps.leaseMs ?? DEFAULT_EXECUTION_LEASE_MS;
  }

  async dispatch(input: TaskExecutionDispatchInput): Promise<TaskExecutionDispatchResult> {
    if (!input.workflowId) {
      /*
       * The attempt ledger is keyed by workflowId. Without it there is no logical
       * attempt to lease, fence, resume or attribute — so there is nothing safe to
       * run. Fail closed rather than invent an identity.
       */
      throw new Error("EXTERNAL_WORKER_DISPATCH_REQUIRES_WORKFLOW_ID");
    }

    const attempt = await this.deps.dispatchAttempts.getByWorkflowId(input.workflowId);
    if (!attempt) {
      throw new Error(`EXTERNAL_WORKER_ATTEMPT_NOT_FOUND: ${input.workflowId}`);
    }

    const worker = attempt.workerId ? await this.deps.workers.get(attempt.workerId) : null;
    if (!worker) {
      /*
       * Routing assigned this attempt to a worker; if that worker is gone we cannot
       * know its runtime, and guessing one would launch the wrong process. The
       * attempt is recorded as retryable so re-routing can pick a live worker.
       */
      await this.settleFailure(attempt.id, input, {
        failureClass: "PROVIDER_UNAVAILABLE",
        message: `EXTERNAL_WORKER_NOT_REGISTERED: ${attempt.workerId ?? "<none>"}`,
      });
      return { workflowId: input.workflowId };
    }

    const leased = await this.deps.dispatchAttempts.acquireExecutionLease(
      attempt.id,
      this.owner,
      this.leaseMs,
    );
    if (!leased) {
      /*
       * Someone else is running this attempt. Reporting anything now — including a
       * success — would be a duplicate result for one logical attempt. Return
       * without executing and without recording: the holder will report.
       */
      return { workflowId: input.workflowId };
    }

    /* Resume state from the most recent attempt that produced any. */
    const resumable = await this.deps.dispatchAttempts.latestResumableState(
      attempt.missionTaskId,
    );

    const mode = this.deps.workspaceMode?.(input) ?? "writer";
    /*
     * A governed workspace wins when one exists. Ownership decides disposal: we remove only
     * what we created, because removing a governed worktree would delete the very thing the
     * gate is about to evaluate.
     */
    const governed = (await this.deps.workspaceFor?.(input)) ?? null;
    const workspace =
      governed ??
      (await provisionWorkspace({
        repoPath: this.deps.repoPath,
        mode,
        attemptKey: `${attempt.missionTaskId}-a${attempt.attempt}`,
        rootDir: this.deps.workspaceRoot,
      }));

    try {
      const mission = await this.deps.missions.findById(attempt.missionId);

      const contract: WorkerTaskContract = workerTaskContractSchema.parse({
        goalId: mission?.goalId ?? null,
        missionId: attempt.missionId,
        planId: mission?.planId ?? null,
        missionTaskId: attempt.missionTaskId,
        taskId: attempt.taskId,
        attempt: attempt.attempt,
        workflowId: attempt.workflowId,
        objective: input.taskTitle ?? attempt.taskId,
        instructions: attempt.prompt,
        successCriteria: [],
        /* A reader is handed NO write scope, so nothing invites it to write. */
        allowedFileScope: workspace.mode === "writer" ? ["."] : [],
        workspacePath: workspace.path,
        resumeToken: resumable?.resumeToken ?? null,
        handoff: resumable?.handoff ?? null,
      });

      const outcome = await this.deps.executor.execute({
        worker,
        contract,
        workspace,
        stillOwnsLease: () =>
          this.deps.dispatchAttempts.holdsExecutionLease(attempt.id, this.owner),
      });

      await this.settle(attempt.id, input, outcome);
      return { workflowId: input.workflowId };
    } finally {
      /* Only dispose what we provisioned: a governed workspace outlives this dispatch. */
      if (!governed) await workspace.dispose();
    }
  }

  private async settle(
    attemptId: string,
    input: TaskExecutionDispatchInput,
    outcome: WorkerExecutionOutcome,
  ): Promise<void> {
    if (!outcome.ok) {
      await this.settleFailure(attemptId, input, {
        failureClass: outcome.failureClass,
        message: outcome.message,
        resumeToken: outcome.resumeToken,
        handoff: outcome.handoff,
        outcome,
      });
      return;
    }

    await this.record({
      taskId: input.taskId,
      workflowId: input.workflowId!,
      outcome: "success",
      /*
       * `agent` and not a provider name. The provider lives in the identity axes
       * recorded as evidence; putting it here would re-hardwire providers into the
       * business record.
       */
      workerKind: "agent",
      capability: input.capability,
      result: outcome.structured?.summary ?? truncate(outcome.process.stdout),
      completedAt: new Date().toISOString(),
      artifacts: artifactsOf(outcome),
      evidence: evidenceOf(outcome),
    });
  }

  private async settleFailure(
    attemptId: string,
    input: TaskExecutionDispatchInput,
    failure: {
      failureClass: WorkerFailureClass;
      message: string;
      resumeToken?: string;
      handoff?: Record<string, unknown>;
      outcome?: WorkerExecutionOutcome;
    },
  ): Promise<void> {
    /* The attempt ledger keeps the FINE class; the business record keeps the coarse one. */
    await this.deps.dispatchAttempts.recordExecutionFailure(attemptId, {
      failureClass: failure.failureClass,
      message: failure.message,
      resumeToken: failure.resumeToken,
      handoff: failure.handoff,
    });

    await this.record({
      taskId: input.taskId,
      workflowId: input.workflowId!,
      outcome: "failure",
      workerKind: "agent",
      capability: input.capability,
      error: {
        code: toExecutionErrorCode(failure.failureClass),
        message: failure.message.slice(0, 2_000),
      },
      completedAt: new Date().toISOString(),
      artifacts: failure.outcome ? artifactsOf(failure.outcome) : undefined,
      evidence: failure.outcome ? evidenceOf(failure.outcome) : undefined,
    });
  }

  /**
   * Records the business proof, and REFUSES to do so silently.
   *
   * `recordTaskExecution` returns an outcome instead of throwing. Ignoring it would
   * mean a rejected result — an unknown task, a mis-correlated workflow — leaves the
   * task with no proof at all and therefore stuck forever, with nothing logged. A
   * throw here surfaces it as a dispatch failure that recovery can see.
   */
  private async record(
    input: Parameters<typeof recordTaskExecution>[1],
  ): Promise<void> {
    const result = await recordTaskExecution(this.recordDeps(), input);
    if (!result.ok) {
      throw new Error(
        `EXTERNAL_WORKER_RESULT_REJECTED(${result.reason}): ${result.message}`,
      );
    }
  }

  private recordDeps() {
    return {
      tasks: this.deps.tasks,
      executionResults: this.deps.executionResults,
      supervisor: this.deps.supervisor,
      missions: this.deps.missions,
      durableMemory: this.deps.durableMemory,
    };
  }
}

function truncate(text: string, max = 20_000): string | undefined {
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** The worker's branch and commits, as durable artifacts. */
function artifactsOf(outcome: WorkerExecutionOutcome): Artifact[] | undefined {
  const evidence = outcome.evidence;
  if (!evidence) return undefined;

  return [
    {
      type: "git-branch",
      path: evidence.branch,
      metadata: {
        commitHash: evidence.commitHash,
        commits: evidence.commits,
        changedFiles: evidence.changedFiles,
        dirty: evidence.dirty,
      },
    },
  ];
}

/**
 * Execution evidence: WHO ran it on what, and what the process did.
 *
 * The six identity axes are recorded separately here, which is the point of
 * keeping them distinct — a later triage can tell "this account's quota is gone"
 * from "this worker is broken".
 */
function evidenceOf(outcome: WorkerExecutionOutcome): Evidence[] | undefined {
  const timestamp = new Date().toISOString();
  const items: Evidence[] = [
    {
      type: "worker-identity",
      source: outcome.identity.workerId,
      timestamp,
      metadata: { ...outcome.identity },
    },
  ];

  const process = outcome.process;
  if (process) {
    items.push({
      type: "worker-process",
      source: outcome.identity.workerId,
      timestamp,
      metadata: {
        exitCode: process.exitCode,
        signal: process.signal,
        timedOut: process.timedOut,
        durationMs: process.durationMs,
        /* Bounded tails: enough to triage, never a full transcript. */
        stdoutTail: process.stdout.slice(-4_000),
        stderrTail: process.stderr.slice(-4_000),
      },
    });
  }

  if (outcome.structured?.testsRun?.length) {
    items.push({
      type: "tests-run",
      source: outcome.identity.workerId,
      timestamp,
      metadata: { tests: outcome.structured.testsRun },
    });
  }

  if (outcome.structured?.unresolved?.length) {
    items.push({
      type: "unresolved-issues",
      source: outcome.identity.workerId,
      timestamp,
      metadata: { unresolved: outcome.structured.unresolved },
    });
  }

  return items;
}
