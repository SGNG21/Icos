import { describe, expect, it, vi } from "vitest";

import type { ReviewDecision, ReviewDecisionRecord } from "@/core/contracts/review";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryQualityControlRepository } from "@/server/services/in-memory/quality-control-repository";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import type { ReviewerService } from "@/server/review/ports";
import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

import { QualityControlService } from "./quality-control-service";

interface ReviewResponse {
  decision: ReviewDecision;
  requestedChanges?: ReviewDecisionRecord["requestedChanges"];
}

async function fixture(
  responses: ReviewResponse[] = [{ decision: "APPROVE" }],
  options: { runtime?: AutonomousMissionRuntimeRepository } = {},
) {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit, []);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "Phase 5 mission",
    objective: "Accept only independently reviewed work",
    tasks: [
      {
        title: "Produce result",
        description: "Produce evidence-backed output",
        dependsOn: [],
        workerKind: "hermes",
        capability: null,
      },
    ],
  });
  const missionTask = (await missions.listTasks(mission.id))[0];

  const executionResults = new InMemoryTaskExecutionResultRepository(audit, tasks);
  const reviewDecisions = new InMemoryReviewDecisionRepository();
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(missions, tasks);
  const original = await dispatchAttempts.prepare({
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    attempt: 1,
    workflowId: `icos-task-${missionTask.taskId}`,
    prompt: missionTask.description ?? missionTask.title,
    workerKind: missionTask.workerKind ?? undefined,
    capability: missionTask.capability ?? undefined,
  });
  await dispatchAttempts.markDispatched(original.attempt.id);
  await tasks.transition(missionTask.taskId, "running");

  let responseIndex = 0;
  const reviewer: ReviewerService = {
    review: vi.fn(async (input) => {
      const response = responses[responseIndex++] ?? responses.at(-1)!;
      return ({
        id: `review-${input.executionResult.id}`,
        missionId: input.mission.id,
        taskId: input.task.id,
        workflowId: input.executionResult.workflowId,
        decision: response.decision,
        reviewerKind: "llm",
        severity: response.decision === "APPROVE" ? "info" : "warning",
        reasons: [`Reviewer chose ${response.decision}`],
        requestedChanges: response.requestedChanges,
        createdAt: new Date().toISOString(),
        humanOverridden: false,
      }) satisfies ReviewDecisionRecord;
    }),
  };

  const dispatched: string[] = [];
  const qualityJobs = new InMemoryQualityControlRepository(
    missions,
    tasks,
    executionResults,
    reviewDecisions,
    dispatchAttempts,
    options.runtime,
  );

  const qualityControl = new QualityControlService({
    missions,
    tasks,
    executionResults,
    reviewer,
    reviewDecisions,
    dispatchAttempts,
    qualityJobs,
    dispatchPrepared: async (attempt) => {
      dispatched.push(attempt.workflowId);
      await dispatchAttempts.markDispatched(attempt.id);
    },
  });

  return {
    tasks,
    missions,
    mission,
    missionTask,
    executionResults,
    reviewDecisions,
    reviewer,
    dispatchAttempts,
    original,
    qualityJobs,
    dispatched,
    runtime: options.runtime,
    qualityControl,
  };
}

async function recordAndRegister(
  f: Awaited<ReturnType<typeof fixture>>,
  workflowId: string,
  input: {
    outcome?: "success" | "failure";
    result?: string;
    error?: { code: "WORKER_TIMEOUT"; message: string };
  } = {},
): Promise<void> {
  const recorded = await f.executionResults.record({
    taskId: f.missionTask.taskId,
    workflowId,
    outcome: input.outcome ?? "success",
    result: input.result ?? (input.outcome === "failure" ? undefined : "Worker output"),
    error: input.error,
    completedAt: new Date().toISOString(),
  });
  expect(recorded.ok).toBe(true);
  await f.qualityControl.registerExecution({
    missionId: f.mission.id,
    missionTaskId: f.missionTask.id,
    taskId: f.missionTask.taskId,
    workflowId,
  });
}

describe("QualityControlService", () => {
  it("accepts a good worker result only after a persisted independent review", async () => {
    const f = await fixture();
    const workflowId = `icos-task-${f.missionTask.taskId}`;
    const recorded = await f.executionResults.record({
      taskId: f.missionTask.taskId,
      workflowId,
      outcome: "success",
      result: "Evidence-backed output",
      completedAt: new Date().toISOString(),
    });
    expect(recorded.ok).toBe(true);

    await f.qualityControl.registerExecution({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      workflowId,
    });
    await f.qualityControl.processPending(f.mission.id);

    expect(f.reviewer.review).toHaveBeenCalledTimes(1);
    expect(await f.reviewDecisions.getByWorkflowId(workflowId)).toMatchObject({
      decision: "APPROVE",
    });
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("recovers a persisted result that crashed before quality registration", async () => {
    const f = await fixture();
    const workflowId = `icos-task-${f.missionTask.taskId}`;
    const recorded = await f.executionResults.record({
      taskId: f.missionTask.taskId,
      workflowId,
      outcome: "success",
      result: "Persisted before crash",
      completedAt: new Date().toISOString(),
    });
    expect(recorded.ok).toBe(true);

    await f.qualityControl.recover(f.mission.id);

    expect(f.reviewer.review).toHaveBeenCalledTimes(1);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("does not persist or act when ownership is lost after the external review call", async () => {
    const f = await fixture();
    const workflowId = `icos-task-${f.missionTask.taskId}`;
    await recordAndRegister(f, workflowId);
    const assertOwned = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST"));
    const qualityControl = new QualityControlService({
      missions: f.missions,
      tasks: f.tasks,
      executionResults: f.executionResults,
      reviewer: f.reviewer,
      reviewDecisions: f.reviewDecisions,
      dispatchAttempts: f.dispatchAttempts,
      qualityJobs: f.qualityJobs,
      assertOwned,
    });

    await expect(qualityControl.processPending(f.mission.id)).rejects.toThrow(
      "AUTONOMOUS_RUNTIME_OWNERSHIP_LOST",
    );

    expect(await f.reviewDecisions.getByWorkflowId(workflowId)).toBeNull();
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe(
      "review_pending",
    );
  });

  it("fails closed on a structurally invalid reviewer record", async () => {
    const f = await fixture();
    const workflowId = `icos-task-${f.missionTask.taskId}`;
    await recordAndRegister(f, workflowId);
    vi.mocked(f.reviewer.review).mockResolvedValueOnce({
      ...(await f.reviewer.review({
        mission: f.mission,
        missionTask: f.missionTask,
        task: {
          id: f.missionTask.taskId,
          title: f.missionTask.title,
          description: f.missionTask.description ?? undefined,
        },
        executionResult: (await f.executionResults.getByWorkflowId(workflowId))!,
        artifacts: [],
        evidence: [],
        findings: [],
      })),
      reasons: [],
    });

    await expect(f.qualityControl.processPending(f.mission.id)).rejects.toThrow(
      "QUALITY_CONTROL_INVALID_REVIEW",
    );
    expect(await f.reviewDecisions.getByWorkflowId(workflowId)).toBeNull();
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe(
      "review_pending",
    );
  });

  it("persists and dispatches a deterministic correction attempt through the dispatch ledger", async () => {
    const f = await fixture([
      {
        decision: "REQUEST_CHANGES",
        requestedChanges: [
          {
            field: "result",
            reason: "Missing evidence",
            suggestion: "Add the test output",
          },
        ],
      },
    ]);
    const workflowId = `icos-task-${f.missionTask.taskId}`;
    const recorded = await f.executionResults.record({
      taskId: f.missionTask.taskId,
      workflowId,
      outcome: "success",
      result: "Incomplete output",
      completedAt: new Date().toISOString(),
    });
    expect(recorded.ok).toBe(true);

    await f.qualityControl.registerExecution({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      workflowId,
    });
    await f.qualityControl.processPending(f.mission.id);

    const correctionWorkflowId = `icos-task-${f.missionTask.taskId}-attempt-2`;
    expect(await f.dispatchAttempts.getByWorkflowId(correctionWorkflowId)).toMatchObject({
      attempt: 2,
      state: "dispatched",
      prompt: expect.stringContaining("Missing evidence"),
    });
    expect(await f.dispatchAttempts.getByWorkflowId(f.original.attempt.workflowId)).toMatchObject({
      state: "failed",
      lastError: "DISPATCH_ATTEMPT_SUPERSEDED",
    });
    expect(f.dispatched).toEqual([correctionWorkflowId]);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("queued");
  });

  it("maps a retry-worthy worker failure to RETRY and prepares a distinct attempt", async () => {
    const f = await fixture([{ decision: "RETRY" }]);
    const workflowId = `icos-task-${f.missionTask.taskId}`;
    await recordAndRegister(f, workflowId, {
      outcome: "failure",
      error: { code: "WORKER_TIMEOUT", message: "Worker timed out" },
    });

    await f.qualityControl.processPending(f.mission.id);

    expect(
      await f.dispatchAttempts.getByWorkflowId(`icos-task-${f.missionTask.taskId}-attempt-2`),
    ).toMatchObject({ attempt: 2, state: "dispatched" });
  });

  it("reviews a corrected result again and accepts it", async () => {
    const f = await fixture([
      {
        decision: "REQUEST_CHANGES",
        requestedChanges: [{ field: "result", reason: "Add proof" }],
      },
      { decision: "APPROVE" },
    ]);
    const first = `icos-task-${f.missionTask.taskId}`;
    await recordAndRegister(f, first, { result: "Incomplete" });
    await f.qualityControl.processPending(f.mission.id);

    const second = `icos-task-${f.missionTask.taskId}-attempt-2`;
    await recordAndRegister(f, second, { result: "Corrected with proof" });
    await f.qualityControl.processPending(f.mission.id);

    expect(f.reviewer.review).toHaveBeenCalledTimes(2);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("exhausts the correction budget deterministically and escalates without dispatching again", async () => {
    const requestChanges: ReviewResponse = {
      decision: "REQUEST_CHANGES",
      requestedChanges: [{ field: "result", reason: "Still incomplete" }],
    };
    const f = await fixture([requestChanges, requestChanges, requestChanges]);
    const first = `icos-task-${f.missionTask.taskId}`;
    await recordAndRegister(f, first, { result: "bad 1" });
    await f.qualityControl.processPending(f.mission.id);

    const second = `icos-task-${f.missionTask.taskId}-attempt-2`;
    await recordAndRegister(f, second, { result: "bad 2" });
    await f.qualityControl.processPending(f.mission.id);

    const third = `icos-task-${f.missionTask.taskId}-attempt-3`;
    await recordAndRegister(f, third, { result: "bad 3" });
    await f.qualityControl.processPending(f.mission.id);

    expect(
      await f.dispatchAttempts.getByWorkflowId(`icos-task-${f.missionTask.taskId}-attempt-4`),
    ).toBeNull();
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("failed");
  });

  it("persists a reviewer REPLAN request for canonical runner continuation", async () => {
    let current: AutonomousMissionRuntime = {
      missionId: "placeholder",
      state: "waiting",
      startedAt: new Date(),
      updatedAt: new Date(),
      lastHeartbeatAt: new Date(),
      lastProgressAt: new Date(),
      cycleCount: 1,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 20,
      maxReplans: 2,
      maxRuntimeMs: 60_000,
      maxStagnationCycles: 3,
    };
    const runtime = {
      create: vi.fn(),
      createIfAbsent: vi.fn(),
      get: vi.fn(async () => current),
      listRecoverable: vi.fn(),
      save: vi.fn(async (next: AutonomousMissionRuntime) => {
        current = next;
      }),
      claim: vi.fn(),
      release: vi.fn(),
      saveOwned: vi.fn(),
      renewClaim: vi.fn(),
    } satisfies AutonomousMissionRuntimeRepository;
    const f = await fixture([{ decision: "REPLAN" }], { runtime });
    current = { ...current, missionId: f.mission.id };
    await recordAndRegister(f, `icos-task-${f.missionTask.taskId}`);

    await expect(f.qualityControl.processPending(f.mission.id)).rejects.toThrow(
      "QUALITY_CONTROL_REPLAN_READY",
    );

    expect(current.state).toBe("replanning");
    expect(current.lastReason).toContain("AUTONOMY_REVIEW_REPLAN");
    expect(current.replanCount).toBe(0);
  });
});
