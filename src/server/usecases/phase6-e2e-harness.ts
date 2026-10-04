import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { ReviewDecision, ReviewDecisionRecord } from "@/core/contracts/review";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "@/server/execution/ports";
import type { ReviewerService, ReviewInput } from "@/server/review/ports";
import type { AutonomousMissionPlanner } from "@/server/autonomy/autonomous-mission-runner";
import type { MissionPlan } from "@/server/mission/mission-plan";

import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { InMemoryQualityControlRepository } from "@/server/services/in-memory/quality-control-repository";
import { InMemoryAutonomousMissionRuntimeRepository } from "@/server/services/in-memory/autonomous-mission-runtime-repository";
import { InMemoryDurableMemory } from "@/core/context/durable-memory";

import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { startAutonomousMission } from "@/server/usecases/start-autonomous-mission";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";
import { loadEnv } from "@/config/env";
import { DEFAULT_EXECUTION_LEASE_MS } from "@/server/execution/external-worker-task-execution-dispatcher";

/**
 * Phase 6 — Deterministic autonomous E2E harness.
 *
 * Drives the REAL ICOS production use-cases end to end:
 *   startAutonomousMission → AutonomousMissionRunner → planner → applyPlan →
 *   SupervisorService dispatch → (worker double) → callback
 *   (recordTaskExecution + recordMissionTaskExecution) → QualityControlService →
 *   ACCEPT/CORRECT/RETRY/REPLAN → AutonomyWakeup continuation → completion.
 *
 * ONLY the external boundary is doubled:
 *   - the Temporal/worker dispatcher (ScriptedWorkerDispatcher), which records
 *     dispatches and lets the test emit the corresponding worker callback;
 *   - the reviewer (ScriptedReviewer), whose decisions are scripted per attempt.
 *
 * Everything between — planning validation, DAG readiness, durable dispatch
 * ledger, deterministic workflow identity, review_pending gating, quality
 * decisions, correction/retry/replan, ownership/fencing, completion gating — is
 * the production code path, not re-implemented here.
 */

export interface ScriptedReviewStep {
  decision: ReviewDecision;
  requestedChanges?: ReviewDecisionRecord["requestedChanges"];
  reasons?: string[];
}

/**
 * Scripted reviewer keyed by canonical taskId. Each call to review() consumes
 * the next scripted step for that task; the last step repeats if exhausted.
 * A `throwOn` set forces a fail-closed reviewer error for named workflowIds.
 */
export class ScriptedReviewer implements ReviewerService {
  private readonly indexByTask = new Map<string, number>();

  constructor(
    private readonly stepsByTask: Map<string, ScriptedReviewStep[]>,
    private readonly options: { throwForTask?: Set<string>; malformedForTask?: Set<string> } = {},
  ) {}

  reviewCalls = 0;

  async review(input: ReviewInput): Promise<ReviewDecisionRecord> {
    this.reviewCalls += 1;
    const taskId = input.task.id;

    if (this.options.throwForTask?.has(taskId)) {
      throw new Error("REVIEWER_UNAVAILABLE");
    }

    const steps = this.stepsByTask.get(taskId);
    if (!steps || steps.length === 0) {
      throw new Error(`SCRIPTED_REVIEWER_NO_STEP:${taskId}`);
    }
    const idx = this.indexByTask.get(taskId) ?? 0;
    const step = steps[Math.min(idx, steps.length - 1)];
    this.indexByTask.set(taskId, idx + 1);

    if (this.options.malformedForTask?.has(taskId)) {
      // A structurally invalid record (missing required reasons) forces the
      // QualityControlService normalization to fail closed.
      return {
        id: `review-${input.executionResult.id}`,
        missionId: input.mission.id,
        taskId,
        workflowId: input.executionResult.workflowId,
        decision: step.decision,
        reviewerKind: "llm",
        severity: "warning",
        reasons: [],
        createdAt: new Date().toISOString(),
        humanOverridden: false,
      } as unknown as ReviewDecisionRecord;
    }

    return {
      id: `review-${input.executionResult.id}`,
      missionId: input.mission.id,
      taskId,
      workflowId: input.executionResult.workflowId,
      decision: step.decision,
      reviewerKind: "llm",
      severity: step.decision === "APPROVE" ? "info" : "warning",
      reasons: step.reasons ?? [`Reviewer chose ${step.decision}`],
      requestedChanges: step.requestedChanges,
      createdAt: new Date().toISOString(),
      humanOverridden: false,
    } satisfies ReviewDecisionRecord;
  }
}

export interface RecordedDispatch {
  workflowId: string;
  taskId: string;
  prompt: string;
  missionId?: string;
}

/**
 * Worker boundary double. It behaves like the Temporal dispatcher: it echoes
 * the requested deterministic workflowId (ack), and records every dispatch so
 * the test can emit the matching callback. Optionally fails closed for named
 * workflowIds (Temporal-unavailable simulation) or returns a mismatched ack.
 */
export class ScriptedWorkerDispatcher implements TaskExecutionDispatcher {
  readonly dispatches: RecordedDispatch[] = [];

  constructor(
    private readonly options: {
      failForWorkflowIds?: Set<string>;
      mismatchAckForWorkflowIds?: Set<string>;
    } = {},
  ) {}

  async dispatch(input: TaskExecutionDispatchInput): Promise<TaskExecutionDispatchResult> {
    const workflowId = input.workflowId ?? `wf-${input.taskId}`;
    if (this.options.failForWorkflowIds?.has(workflowId)) {
      throw new Error("TEMPORAL_UNAVAILABLE");
    }
    this.dispatches.push({
      workflowId,
      taskId: input.taskId,
      prompt: input.prompt,
      missionId: input.missionId,
    });
    if (this.options.mismatchAckForWorkflowIds?.has(workflowId)) {
      return { workflowId: `${workflowId}-MISMATCH` };
    }
    return { workflowId };
  }
}

export class FixedPlanPlanner implements AutonomousMissionPlanner {
  planCalls = 0;

  constructor(private readonly plans: MissionPlan[]) {}

  async plan(): Promise<MissionPlan> {
    const plan = this.plans[Math.min(this.planCalls, this.plans.length - 1)];
    this.planCalls += 1;
    if (!plan) throw new Error("FIXED_PLANNER_NO_PLAN");
    return plan;
  }
}

export class UnavailablePlanner implements AutonomousMissionPlanner {
  async plan(): Promise<MissionPlan> {
    throw new Error("AUTONOMY_PLANNER_PROVIDER_FAILURE");
  }
}

export interface HarnessOptions {
  planner: AutonomousMissionPlanner;
  reviewer: ReviewerService;
  dispatcher?: ScriptedWorkerDispatcher;
  now?: () => Date;
}

export function createHarness(options: HarnessOptions) {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit, []);
  const missions = new InMemoryMissionRepository(tasks);
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(missions, tasks);
  const executionResults = new InMemoryTaskExecutionResultRepository(audit, tasks);
  const reviewDecisions = new InMemoryReviewDecisionRepository();
  const durableMemory = new InMemoryDurableMemory();
  const runtimeRepository = new InMemoryAutonomousMissionRuntimeRepository(options.now);
  const dispatcher = options.dispatcher ?? new ScriptedWorkerDispatcher();

  const qualityJobs = new InMemoryQualityControlRepository(
    missions,
    tasks,
    executionResults,
    reviewDecisions,
    dispatchAttempts,
    runtimeRepository,
  );

  const supervisor = new SupervisorService(
    missions,
    tasks,
    dispatcher,
    durableMemory,
    dispatchAttempts,
  );

  const dispatchPrepared = async (
    prepared: {
      id: string;
      missionId: string;
      missionTaskId: string;
      taskId: string;
      prompt: string;
      workflowId: string;
      workerKind?: string;
      capability?: string;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await dispatcher.dispatch({
      missionId: prepared.missionId,
      taskId: prepared.taskId,
      taskTitle: (await missions.getMissionTaskById(prepared.missionTaskId))?.title,
      prompt: prepared.prompt,
      workflowId: prepared.workflowId,
      workerKind: prepared.workerKind,
      capability: prepared.capability,
      signal,
    });
    if (result.workflowId !== prepared.workflowId) {
      throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
    }
    signal?.throwIfAborted();
    await dispatchAttempts.markDispatched(prepared.id, {
      owner: prepared.workflowId,
      leaseMs: DEFAULT_EXECUTION_LEASE_MS,
    });
  };

  const qualityControl = new QualityControlService({
    missions,
    tasks,
    executionResults,
    reviewer: options.reviewer,
    reviewDecisions,
    dispatchAttempts,
    qualityJobs,
    dispatchPrepared,
  });

  const autonomyWakeup = new AutonomyWakeupService(
    missions,
    supervisor,
    runtimeRepository,
    options.now,
    options.planner,
  );

  const recoverySweeper = new AutonomyRecoverySweeper(runtimeRepository, autonomyWakeup);

  async function ignite(input: { title: string; objective: string; goalId: string }): Promise<Mission> {
    const mission = await missions.create({
      title: input.title,
      objective: input.objective,
      goalId: input.goalId,
      tasks: [],
    });
    await startAutonomousMission(
      {
        missions,
        runtimeRepository,
        supervisor,
        planner: options.planner,
        now: options.now,
      },
      { missionId: mission.id, goalId: input.goalId },
    );
    return mission;
  }

  /**
   * Emit the worker callback for the most recent (or a specified) dispatch,
   * exactly as the production callback route would: recordTaskExecution then
   * recordMissionTaskExecution (which runs quality control + continuation).
   */
  async function completeWorker(input: {
    workflowId: string;
    outcome?: "success" | "failure";
    result?: string;
    error?: { code: "WORKER_TIMEOUT"; message: string };
  }): Promise<void> {
    const attempt = await dispatchAttempts.getByWorkflowId(input.workflowId);
    if (!attempt) throw new Error(`HARNESS_NO_ATTEMPT_FOR_WORKFLOW:${input.workflowId}`);

    const rec = await recordTaskExecution(
      {
        tasks,
        executionResults,
        supervisor,
        missions,
        durableMemory,
        dispatchAttempts,
      },
      {
        taskId: attempt.taskId,
        workflowId: input.workflowId,
        outcome: input.outcome ?? "success",
        result: input.result ?? (input.outcome === "failure" ? undefined : "Worker output"),
        error: input.error,
        completedAt: new Date().toISOString(),
      },
    );
    if (!rec.ok) throw new Error(`HARNESS_RECORD_FAILED:${rec.message}`);

    await recordMissionTaskExecution(
      {
        executionResults,
        supervisor,
        missions,
        tasks,
        reviewer: options.reviewer,
        reviewDecisions,
        taskExecution: dispatcher,
        durableMemory,
        dispatchAttempts,
        qualityControl,
        autonomyWakeup,
      },
      {
        missionId: attempt.missionId,
        taskId: attempt.taskId,
        workflowId: input.workflowId,
        outcome: input.outcome ?? "success",
        result: input.result,
        error: input.error,
        completedAt: new Date().toISOString(),
      },
    );
  }

  /**
   * Drain the mission to a terminal state by completing every dispatched worker
   * in order and re-waking until no new dispatch appears. Bounded to avoid
   * infinite loops if a budget invariant regresses.
   */
  async function runToCompletion(
    missionId: string,
    completion: (dispatch: RecordedDispatch) => {
      outcome?: "success" | "failure";
      result?: string;
      error?: { code: "WORKER_TIMEOUT"; message: string };
    } = () => ({ outcome: "success" }),
    maxSteps = 50,
  ): Promise<Mission> {
    let processed = 0;
    for (let step = 0; step < maxSteps; step += 1) {
      const pending = dispatcher.dispatches.slice(processed);
      if (pending.length === 0) {
        const mission = await missions.findById(missionId);
        if (mission && ["succeeded", "failed", "blocked", "cancelled"].includes(mission.status)) {
          return mission;
        }
        // No pending worker and not terminal: try a recovery wake to resume any
        // prepared/replanning state, then re-check for new dispatches.
        await autonomyWakeup.wake(missionId);
        if (dispatcher.dispatches.length === processed) {
          return (await missions.findById(missionId))!;
        }
        continue;
      }
      const dispatch = pending[0];
      processed += 1;
      await completeWorker({ workflowId: dispatch.workflowId, ...completion(dispatch) });
    }
    return (await missions.findById(missionId))!;
  }

  return {
    audit,
    tasks,
    missions,
    dispatchAttempts,
    executionResults,
    reviewDecisions,
    durableMemory,
    runtimeRepository,
    dispatcher,
    qualityJobs,
    qualityControl,
    supervisor,
    autonomyWakeup,
    recoverySweeper,
    ignite,
    completeWorker,
    runToCompletion,
    listTasks: (missionId: string): Promise<MissionTask[]> => missions.listTasks(missionId),
  };
}

export function singleTaskPlan(key = "task-1", title = "Do the work"): MissionPlan {
  return {
    version: 1,
    tasks: [
      { key, title, description: `Objective step: ${title}`, dependsOn: [], workerKind: "hermes" },
    ],
  };
}

// Silence unused import in some builds; loadEnv is used indirectly by supervisor.
void loadEnv;
