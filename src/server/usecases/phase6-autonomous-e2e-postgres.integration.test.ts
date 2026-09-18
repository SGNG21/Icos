import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase } from "@/server/database/client";

import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";

import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import { FakeReviewer } from "@/server/review/fake-reviewer";

import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { startAutonomousMission } from "@/server/usecases/start-autonomous-mission";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import type { AutonomousMissionPlanner } from "@/server/autonomy/autonomous-mission-runner";
import type { MissionPlan } from "@/server/mission/mission-plan";
import type {
  TaskExecutionDispatcher,
  TaskExecutionDispatchInput,
  TaskExecutionDispatchResult,
} from "@/server/execution/ports";

/**
 * Phase 6 — PostgreSQL-backed autonomous E2E.
 *
 * Proves the ignition → plan → dispatch → callback → durable review → ACCEPT →
 * completion loop against the REAL PostgreSQL repositories (durable dispatch
 * ledger, quality control jobs, review decisions, autonomous runtime), using
 * only the external worker boundary as a double and a fixed-plan planner.
 *
 * Authorized disposable database only: icos_n23_probe.
 */
const DATABASE_URL = "postgres://coco@localhost:5432/icos_n23_probe";

class RecordingDispatcher implements TaskExecutionDispatcher {
  readonly dispatches: { workflowId: string; taskId: string; prompt: string }[] = [];
  async dispatch(input: TaskExecutionDispatchInput): Promise<TaskExecutionDispatchResult> {
    const workflowId = input.workflowId ?? `wf-${input.taskId}`;
    this.dispatches.push({ workflowId, taskId: input.taskId, prompt: input.prompt });
    return { workflowId };
  }
}

class FixedPlanPlanner implements AutonomousMissionPlanner {
  planCalls = 0;
  constructor(private readonly plans: MissionPlan[]) {}
  async plan(): Promise<MissionPlan> {
    const plan = this.plans[Math.min(this.planCalls, this.plans.length - 1)];
    this.planCalls += 1;
    if (!plan) throw new Error("FIXED_PLANNER_NO_PLAN");
    return plan;
  }
}

describe("Phase 6 — autonomous E2E (PostgreSQL, icos_n23_probe)", () => {
  const handle = createDatabase(DATABASE_URL);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE quality_control_jobs, decisions, task_execution_results, " +
          "dispatch_attempts, autonomous_mission_runtime, mission_tasks, missions, tasks " +
          "RESTART IDENTITY CASCADE",
      ),
    );
  });

  function compose(planner: AutonomousMissionPlanner, llmDecision: FakeReviewer) {
    const tasks = new PostgresTaskRepository(handle.db);
    const missions = new PostgresMissionRepository(handle.db, tasks);
    const dispatchAttempts = new PostgresDispatchAttemptRepository(handle.db);
    const executionResults = new PostgresTaskExecutionResultRepository(handle.db);
    const reviewDecisions = new PostgresReviewDecisionRepository(handle.db);
    const runtimeRepository = new PostgresAutonomousMissionRuntimeRepository(handle.db);
    const durableMemory = new PostgresDurableMemory(handle.db);
    const qualityJobs = new PostgresQualityControlRepository(handle.db);
    const dispatcher = new RecordingDispatcher();

    const reviewer = new ReviewerServiceImpl(
      llmDecision,
      new DeterministicReviewer(),
      reviewDecisions,
    );

    const supervisor = new SupervisorService(
      missions,
      tasks,
      dispatcher,
      durableMemory,
      dispatchAttempts,
    );

    const qualityControl = new QualityControlService({
      missions,
      tasks,
      executionResults,
      reviewer,
      reviewDecisions,
      dispatchAttempts,
      qualityJobs,
      dispatchPrepared: async (prepared, signal) => {
        const result = await dispatcher.dispatch({
          missionId: prepared.missionId,
          taskId: prepared.taskId,
          prompt: prepared.prompt,
          workflowId: prepared.workflowId,
          workerKind: prepared.workerKind,
          capability: prepared.capability,
          signal,
        });
        if (result.workflowId !== prepared.workflowId) {
          throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
        }
        await dispatchAttempts.markDispatched(prepared.id);
      },
    });

    const autonomyWakeup = new AutonomyWakeupService(
      missions,
      supervisor,
      runtimeRepository,
      undefined,
      planner,
    );

    return {
      tasks,
      missions,
      dispatchAttempts,
      executionResults,
      reviewDecisions,
      runtimeRepository,
      durableMemory,
      qualityJobs,
      dispatcher,
      reviewer,
      supervisor,
      qualityControl,
      autonomyWakeup,
    };
  }

  async function completeWorker(
    ctx: ReturnType<typeof compose>,
    planner: AutonomousMissionPlanner,
    workflowId: string,
  ): Promise<void> {
    const attempt = await ctx.dispatchAttempts.getByWorkflowId(workflowId);
    if (!attempt) throw new Error(`NO_ATTEMPT:${workflowId}`);
    const rec = await recordTaskExecution(
      {
        tasks: ctx.tasks,
        executionResults: ctx.executionResults,
        supervisor: ctx.supervisor,
        missions: ctx.missions,
        durableMemory: ctx.durableMemory,
        dispatchAttempts: ctx.dispatchAttempts,
      },
      {
        taskId: attempt.taskId,
        workflowId,
        outcome: "success",
        result: "Worker output",
        completedAt: new Date().toISOString(),
      },
    );
    expect(rec.ok).toBe(true);
    await recordMissionTaskExecution(
      {
        executionResults: ctx.executionResults,
        supervisor: ctx.supervisor,
        missions: ctx.missions,
        tasks: ctx.tasks,
        reviewer: ctx.reviewer,
        reviewDecisions: ctx.reviewDecisions,
        taskExecution: ctx.dispatcher,
        durableMemory: ctx.durableMemory,
        dispatchAttempts: ctx.dispatchAttempts,
        qualityControl: ctx.qualityControl,
        autonomyWakeup: ctx.autonomyWakeup,
      },
      {
        missionId: attempt.missionId,
        taskId: attempt.taskId,
        workflowId,
        outcome: "success",
        result: "Worker output",
        completedAt: new Date().toISOString(),
      },
    );
    void planner;
  }

  it("SCENARIO 1 (PostgreSQL) — one objective → plan → dispatch → APPROVE → mission succeeded", async () => {
    const planner = new FixedPlanPlanner([
      {
        version: 1,
        tasks: [
          { key: "a", title: "Task A", description: "Do A", dependsOn: [], workerKind: "hermes" },
          {
            key: "b",
            title: "Task B",
            description: "Do B",
            dependsOn: ["a"],
            workerKind: "hermes",
          },
        ],
      },
    ]);
    const llm = new FakeReviewer({
      defaultResponse: { decision: "APPROVE", reasons: ["approved"] },
    });
    const ctx = compose(planner, llm);

    const mission = await ctx.missions.create({
      title: "Autonomous PG mission",
      objective: "Prove the durable autonomous loop end to end",
      tasks: [],
    });

    await startAutonomousMission(
      {
        missions: ctx.missions,
        runtimeRepository: ctx.runtimeRepository,
        supervisor: ctx.supervisor,
        planner,
      },
      { missionId: mission.id },
    );

    // Initial planning produced a 2-task DAG; only A is ready and dispatched.
    let tasks = await ctx.missions.listTasks(mission.id);
    expect(tasks).toHaveLength(2);
    expect(ctx.dispatcher.dispatches).toHaveLength(1);
    const taskA = tasks.find((t) => t.title === "Task A")!;
    expect(ctx.dispatcher.dispatches[0].workflowId).toBe(`icos-task-${taskA.taskId}`);

    // Drain: complete each dispatched worker in order until terminal.
    let processed = 0;
    for (let step = 0; step < 20; step += 1) {
      const pending = ctx.dispatcher.dispatches.slice(processed);
      if (pending.length === 0) {
        const m = await ctx.missions.findById(mission.id);
        if (m && ["succeeded", "failed", "blocked", "cancelled"].includes(m.status)) break;
        await ctx.autonomyWakeup.wake(mission.id);
        if (ctx.dispatcher.dispatches.length === processed) break;
        continue;
      }
      processed += 1;
      await completeWorker(ctx, planner, pending[0].workflowId);
    }

    const finalMission = await ctx.missions.findById(mission.id);
    expect(finalMission?.status).toBe("succeeded");
    tasks = await ctx.missions.listTasks(mission.id);
    expect(tasks.every((t) => t.status === "succeeded")).toBe(true);
    const finalRuntime = await ctx.runtimeRepository.get(mission.id);
    expect(finalRuntime?.state).toBe("succeeded");
    expect(finalRuntime?.ownerToken).toBeNull();
    expect(finalRuntime?.leaseUntil).toBeNull();

    // Durable review decisions were persisted for each accepted task.
    for (const t of tasks) {
      const decision = await ctx.reviewDecisions.getByWorkflowId(`icos-task-${t.taskId}`);
      expect(decision?.decision).toBe("APPROVE");
    }
  });

  it("SCENARIO 4 (PostgreSQL) — REPLAN supersedes obsolete graph atomically and completes", async () => {
    const planner = new FixedPlanPlanner([
      {
        version: 1,
        tasks: [
          {
            key: "bad",
            title: "Bad approach",
            description: "Wrong",
            dependsOn: [],
            workerKind: "hermes",
          },
        ],
      },
      {
        version: 1,
        tasks: [
          {
            key: "good",
            title: "Good approach",
            description: "Right",
            dependsOn: [],
            workerKind: "hermes",
          },
        ],
      },
    ]);
    // First review → REPLAN, second → APPROVE, keyed by attempt order.
    let call = 0;
    const llm = new FakeReviewer();
    const originalReview = llm.review.bind(llm);
    llm.review = async () => {
      call += 1;
      void originalReview;
      return {
        decision: call === 1 ? "REPLAN" : "APPROVE",
        reasons: [call === 1 ? "graph cannot satisfy objective" : "approved"],
      };
    };
    const ctx = compose(planner, llm);

    const mission = await ctx.missions.create({
      title: "Replannable PG mission",
      objective: "Reach the objective even if the first graph is wrong",
      tasks: [],
    });

    await startAutonomousMission(
      {
        missions: ctx.missions,
        runtimeRepository: ctx.runtimeRepository,
        supervisor: ctx.supervisor,
        planner,
      },
      { missionId: mission.id },
    );

    const before = await ctx.missions.listTasks(mission.id);
    const originalTaskId = before[0].taskId;

    let processed = 0;
    for (let step = 0; step < 20; step += 1) {
      const pending = ctx.dispatcher.dispatches.slice(processed);
      if (pending.length === 0) {
        const m = await ctx.missions.findById(mission.id);
        if (m && ["succeeded", "failed", "blocked", "cancelled"].includes(m.status)) break;
        await ctx.autonomyWakeup.wake(mission.id);
        if (ctx.dispatcher.dispatches.length === processed) break;
        continue;
      }
      processed += 1;
      await completeWorker(ctx, planner, pending[0].workflowId);
    }

    expect(planner.planCalls).toBe(2);
    const finalMission = await ctx.missions.findById(mission.id);
    expect(finalMission?.status).toBe("succeeded");
    const finalRuntime = await ctx.runtimeRepository.get(mission.id);
    expect(finalRuntime?.state).toBe("succeeded");
    expect(finalRuntime?.ownerToken).toBeNull();
    expect(finalRuntime?.leaseUntil).toBeNull();

    const tasks = await ctx.missions.listTasks(mission.id);
    const original = tasks.find((t) => t.taskId === originalTaskId);
    expect(original?.status).toBe("superseded");
    expect(tasks.some((t) => t.taskId !== originalTaskId && t.status === "succeeded")).toBe(true);
  });
});
