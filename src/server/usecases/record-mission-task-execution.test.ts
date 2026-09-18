import { describe, expect, it, vi } from "vitest";

import type {
  ReviewDecision,
  ReviewDecisionRecord,
  RequestedChange,
} from "@/core/contracts/review";
import { InMemoryAuditLog } from "@/server/audit/in-memory-audit-log";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { InMemoryTaskRepository } from "@/server/services/in-memory/task-repository";
import type { ReviewerService } from "@/server/review/ports";
import type { SupervisorService } from "@/server/supervisor/supervisor-service";

import { recordMissionTaskExecution } from "./record-mission-task-execution";

function decision(
  input: Parameters<ReviewerService["review"]>[0],
  value: ReviewDecision,
  requestedChanges?: RequestedChange[],
): ReviewDecisionRecord {
  return {
    id: `review-${input.executionResult.workflowId}`,
    missionId: input.mission.id,
    taskId: input.task.id,
    workflowId: input.executionResult.workflowId,
    decision: value,
    reviewerKind: "deterministic",
    severity: value === "APPROVE" ? "info" : value === "REQUEST_CHANGES" ? "warning" : "critical",
    reasons: [`decision: ${value}`],
    requestedChanges,
    createdAt: new Date().toISOString(),
    humanOverridden: false,
  };
}

async function fixture(reviews: Array<ReviewDecision | Error>) {
  const audit = new InMemoryAuditLog();
  const tasks = new InMemoryTaskRepository(audit, []);
  const missions = new InMemoryMissionRepository(tasks);
  const mission = await missions.create({
    title: "N1 mission",
    objective: "Close the loop",
    tasks: [
      {
        title: "Implement",
        description: "Implement the requested change",
        dependsOn: [],
        workerKind: "hermes",
        capability: null,
      },
    ],
  });
  const missionTask = (await missions.listTasks(mission.id))[0];
  const dispatchAttempts = new InMemoryDispatchAttemptRepository(missions, tasks);
  const original = await dispatchAttempts.prepare({
    missionId: mission.id,
    missionTaskId: missionTask.id,
    taskId: missionTask.taskId,
    attempt: 1,
    workflowId: "icos-task-original",
    prompt: missionTask.description ?? missionTask.title,
    workerKind: missionTask.workerKind ?? undefined,
    capability: missionTask.capability ?? undefined,
  });
  await dispatchAttempts.markDispatched(original.attempt.id);
  await tasks.transition(missionTask.taskId, "running");

  const executionResults = new InMemoryTaskExecutionResultRepository(audit, tasks);
  const reviewDecisions = new InMemoryReviewDecisionRepository();
  let reviewIndex = 0;
  const reviewer: ReviewerService = {
    review: vi.fn(async (input) => {
      const next = reviews[reviewIndex++] ?? reviews.at(-1) ?? "APPROVE";
      if (next instanceof Error) throw next;
      return decision(
        input,
        next,
        next === "REQUEST_CHANGES"
          ? [
              {
                field: "result",
                reason: "Address the review",
                suggestion: "Return corrected output",
              },
            ]
          : undefined,
      );
    }),
  };
  const taskExecution: TaskExecutionDispatcher = {
    dispatch: vi.fn(async (input) => ({ workflowId: input.workflowId! })),
  };
  const supervisor = { run: vi.fn(async () => undefined) } as unknown as SupervisorService;

  const deps = {
    tasks,
    missions,
    executionResults,
    reviewDecisions,
    reviewer,
    taskExecution,
    dispatchAttempts,
    supervisor,
  };

  async function recordResult(workflowId: string, result = "output") {
    const recorded = await executionResults.record({
      taskId: missionTask.taskId,
      workflowId,
      outcome: "success",
      result,
      completedAt: new Date().toISOString(),
    });
    expect(recorded.ok).toBe(true);
  }

  async function callback(workflowId: string) {
    return recordMissionTaskExecution(deps, {
      missionId: mission.id,
      taskId: missionTask.taskId,
      workflowId,
      outcome: "success",
      result: "output",
      completedAt: new Date().toISOString(),
    });
  }

  return { ...deps, mission, missionTask, recordResult, callback };
}

describe("recordMissionTaskExecution N1 review loop", () => {
  it("soumet aussi un échec worker à la revue au lieu de terminaliser directement", async () => {
    const f = await fixture(["APPROVE"]);
    const recorded = await f.executionResults.record({
      taskId: f.missionTask.taskId,
      workflowId: "icos-task-original",
      outcome: "failure",
      error: { code: "WORKER_FAILED", message: "synthetic worker failure" },
      completedAt: "2026-09-16T10:05:00.000Z",
    });
    expect(recorded.ok).toBe(true);

    await recordMissionTaskExecution(f, {
      missionId: f.mission.id,
      taskId: f.missionTask.taskId,
      workflowId: "icos-task-original",
      outcome: "failure",
      error: { code: "WORKER_FAILED", message: "synthetic worker failure" },
      completedAt: "2026-09-16T10:05:00.000Z",
    });

    expect(f.reviewer.review).toHaveBeenCalledTimes(1);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("APPROVE makes the MissionTask succeeded", async () => {
    const f = await fixture(["APPROVE"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("REQUEST_CHANGES redispatches correction context without succeeding", async () => {
    const f = await fixture(["REQUEST_CHANGES"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("queued");
    expect(f.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: f.missionTask.taskId,
        workflowId: `icos-task-${f.missionTask.taskId}-correction-1`,
        prompt: expect.stringContaining("Address the review"),
      }),
    );
  });

  it("reviews a corrected result again and APPROVE then succeeds", async () => {
    const f = await fixture(["REQUEST_CHANGES", "APPROVE"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    const correctedWorkflowId = `icos-task-${f.missionTask.taskId}-correction-1`;
    await f.recordResult(correctedWorkflowId, "corrected");
    await f.callback(correctedWorkflowId);
    expect(f.reviewer.review).toHaveBeenCalledTimes(2);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("BLOCK fails the MissionTask so it cannot succeed", async () => {
    const f = await fixture(["BLOCK"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("failed");
    expect(f.taskExecution.dispatch).not.toHaveBeenCalled();
  });

  it("ESCALATE_TO_HUMAN stays non-terminal awaiting approval", async () => {
    const f = await fixture(["ESCALATE_TO_HUMAN"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe(
      "awaiting_approval",
    );
  });

  it("review failure fails closed and recovers on callback replay", async () => {
    const f = await fixture([new Error("review unavailable"), "APPROVE"]);
    await f.recordResult("icos-task-original");
    await expect(f.callback("icos-task-original")).rejects.toThrow("review unavailable");
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("queued");
    await f.callback("icos-task-original");
    expect(f.reviewer.review).toHaveBeenCalledTimes(2);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("succeeded");
  });

  it("duplicate callback does not duplicate correction dispatch or review", async () => {
    const f = await fixture(["REQUEST_CHANGES"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    await f.callback("icos-task-original");
    expect(f.reviewer.review).toHaveBeenCalledTimes(1);
    expect(f.taskExecution.dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses a distinct deterministic workflowId for every correction", async () => {
    const f = await fixture(["REQUEST_CHANGES", "REQUEST_CHANGES"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    const firstCorrection = `icos-task-${f.missionTask.taskId}-correction-1`;
    await f.recordResult(firstCorrection, "first correction");
    await f.callback(firstCorrection);
    expect(f.taskExecution.dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        workflowId: `icos-task-${f.missionTask.taskId}-correction-2`,
      }),
    );
  });

  it("fails closed after the bounded correction budget is exhausted", async () => {
    const f = await fixture(["REQUEST_CHANGES", "REQUEST_CHANGES", "REQUEST_CHANGES"]);
    await f.recordResult("icos-task-original");
    await f.callback("icos-task-original");
    const firstCorrection = `icos-task-${f.missionTask.taskId}-correction-1`;
    await f.recordResult(firstCorrection, "first correction");
    await f.callback(firstCorrection);
    const secondCorrection = `icos-task-${f.missionTask.taskId}-correction-2`;
    await f.recordResult(secondCorrection, "second correction");
    await f.callback(secondCorrection);
    expect(f.taskExecution.dispatch).toHaveBeenCalledTimes(2);
    expect((await f.missions.getMissionTaskById(f.missionTask.id))?.status).toBe("failed");
  });
});
