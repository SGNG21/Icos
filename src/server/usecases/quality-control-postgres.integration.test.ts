import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import { buildPostgresContainer, type Container } from "@/server/container";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import type { ReviewerService } from "@/server/review/ports";

import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";

import { QualityControlService } from "./quality-control-service";

const DATABASE_URL = TEST_DATABASE_URL;

function reviewer(decision: ReviewDecisionRecord["decision"]): ReviewerService {
  return {
    review: vi.fn(async (input) =>
      ({
        id: `review-${input.executionResult.id}`,
        missionId: input.mission.id,
        taskId: input.task.id,
        workflowId: input.executionResult.workflowId,
        decision,
        reviewerKind: "llm",
        severity: decision === "APPROVE" ? "info" : "warning",
        reasons: [`Reviewer chose ${decision}`],
        requestedChanges:
          decision === "REQUEST_CHANGES"
            ? [{ field: "result", reason: "Add proof", suggestion: "Attach test output" }]
            : undefined,
        createdAt: new Date().toISOString(),
        humanOverridden: false,
      }) satisfies ReviewDecisionRecord,
    ),
  };
}

describe("PostgreSQL durable quality control", () => {
  let container: Container;

  beforeAll(async () => {
    const env = loadEnv({
      NODE_ENV: "test",
      PERSISTENCE: "postgres",
      DATABASE_URL,
      OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
      OMNIROUTE_API_KEY: "phase-5-controlled-key",
      ICOS_REVIEWER_MODEL: "phase-5-controlled-reviewer",
      ICOS_REVIEWER_TIMEOUT_MS: "1000",
    });
    container = await buildPostgresContainer(DATABASE_URL, undefined, env);
  });

  afterAll(async () => {
    if (container?.db) {
      await container.db.execute(
        sql`TRUNCATE TABLE quality_control_jobs, missions, tasks RESTART IDENTITY CASCADE`,
      );
    }
    await container?.close();
  });

  async function seed(reviewDecision: ReviewDecisionRecord["decision"]) {
    if (!container.db) throw new Error("PostgreSQL handle missing");
    await container.db.execute(
      sql`TRUNCATE TABLE quality_control_jobs, missions, tasks RESTART IDENTITY CASCADE`,
    );
    const mission = await container.mission.create({
      title: "Phase 5 PostgreSQL proof",
      objective: "Prove durable quality action",
      tasks: [
        {
          title: "Deliver result",
          description: "Produce a reviewed result",
          dependsOn: [],
          workerKind: "hermes",
          capability: null,
        },
      ],
    });
    const missionTask = (await container.mission.listTasks(mission.id))[0];
    await container.mission.updateMissionTaskStatus(mission.id, missionTask.id, "queued");
    await container.tasks.transition(missionTask.taskId, "queued");
    await container.tasks.transition(missionTask.taskId, "running");
    const workflowId = `icos-task-${missionTask.taskId}`;
    const prepared = await container.dispatchAttempts.prepare({
      missionId: mission.id,
      missionTaskId: missionTask.id,
      taskId: missionTask.taskId,
      attempt: 1,
      workflowId,
      prompt: missionTask.description ?? missionTask.title,
      workerKind: "hermes",
    });
    await container.dispatchAttempts.markDispatched(prepared.attempt.id, { owner: "test-owner", leaseMs: 60_000 });
    const recorded = await container.executionResults.record({
      taskId: missionTask.taskId,
      workflowId,
      outcome: "success",
      result: "Worker result",
      completedAt: new Date().toISOString(),
    });
    expect(recorded.ok).toBe(true);

    const qualityJobs = new PostgresQualityControlRepository(container.db);
    const service = new QualityControlService({
      missions: container.mission,
      tasks: container.tasks,
      executionResults: container.executionResults,
      reviewer: reviewer(reviewDecision),
      reviewDecisions: container.reviewDecisions,
      dispatchAttempts: container.dispatchAttempts,
      qualityJobs,
    });
    return { mission, missionTask, workflowId, qualityJobs, service };
  }

  it("recovers result-before-review and accepts exactly once", async () => {
    const f = await seed("APPROVE");

    expect(await f.qualityJobs.recoverUnregistered(f.mission.id)).toBe(1);
    await f.service.recover(f.mission.id);
    await f.service.recover(f.mission.id);

    expect((await container.mission.getMissionTaskById(f.missionTask.id))?.status).toBe(
      "succeeded",
    );
    expect(await container.reviewDecisions.listByTaskId(f.missionTask.taskId)).toHaveLength(1);
    expect((await f.qualityJobs.getByWorkflowId(f.workflowId))?.state).toBe("action_applied");
  });

  it("resumes decision-before-action once after an expired claim", async () => {
    const f = await seed("REQUEST_CHANGES");
    await f.service.registerExecution({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      workflowId: f.workflowId,
    });
    const claimed = await f.qualityJobs.claimNext(f.mission.id, "crashed-owner", 60_000);
    expect(claimed).not.toBeNull();
    const review = await reviewer("REQUEST_CHANGES").review({
      mission: f.mission,
      missionTask: f.missionTask,
      task: {
        id: f.missionTask.taskId,
        title: f.missionTask.title,
        description: f.missionTask.description ?? undefined,
      },
      executionResult: (await container.executionResults.getByWorkflowId(f.workflowId))!,
      artifacts: [],
      evidence: [],
      findings: [],
    });
    await f.qualityJobs.saveDecision(f.workflowId, "crashed-owner", {
      review,
      action: "CORRECT",
    });
    await container.db!.execute(
      sql`UPDATE quality_control_jobs SET claim_until = now() - interval '1 second' WHERE workflow_id = ${f.workflowId}`,
    );

    await f.service.recover(f.mission.id);
    await f.service.recover(f.mission.id);

    expect(
      await container.dispatchAttempts.getByWorkflowId(
        `icos-task-${f.missionTask.taskId}-attempt-2`,
      ),
    ).toMatchObject({ attempt: 2, state: "prepared" });
    expect(await container.dispatchAttempts.getByWorkflowId(f.workflowId)).toMatchObject({
      state: "failed",
      lastError: "DISPATCH_ATTEMPT_SUPERSEDED",
    });
  });

  it("does not duplicate a correction action when two recoverers race", async () => {
    const f = await seed("REQUEST_CHANGES");
    await f.service.registerExecution({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      workflowId: f.workflowId,
    });

    const outcomes = await Promise.allSettled([
      f.service.recover(f.mission.id),
      f.service.recover(f.mission.id),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(0);
    expect(await container.reviewDecisions.listByTaskId(f.missionTask.taskId)).toHaveLength(1);
    const rows = await container.db!.execute(sql`
      SELECT count(*)::int AS count
      FROM dispatch_attempts
      WHERE mission_task_id = ${f.missionTask.id} AND attempt = 2
    `);
    expect((rows[0] as { count: number }).count).toBe(1);
  });

  it("crash-gap: the wake-up outbox is persisted with the applied action and resumed once after a restart", async () => {
    const f = await seed("APPROVE");
    await f.service.registerExecution({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      workflowId: f.workflowId,
    });
    await f.service.processPending(f.mission.id); // action applied, then "the process dies" before waking

    const restarted = new PostgresQualityControlRepository(container.db!);
    expect((await restarted.getByWorkflowId(f.workflowId))?.state).toBe("action_applied");
    expect(await restarted.listWakeupMissionIds()).toEqual([f.mission.id]);

    const wake = vi.fn().mockResolvedValue(null);
    const sweeper = new QualityControlRecoverySweeper(f.service, restarted, wake);
    await sweeper.sweep();
    await sweeper.sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(f.mission.id);
    expect(await restarted.listWakeupMissionIds()).toEqual([]);
  });

  it("three reviewer failures park the review as unavailable without failing the task, then recover", async () => {
    const f = await seed("APPROVE");
    const failing: ReviewerService = { review: vi.fn().mockRejectedValue(new Error("reviewer down")) };
    const down = new QualityControlService({
      missions: container.mission,
      tasks: container.tasks,
      executionResults: container.executionResults,
      reviewer: failing,
      reviewDecisions: container.reviewDecisions,
      dispatchAttempts: container.dispatchAttempts,
      qualityJobs: f.qualityJobs,
    });
    await down.registerExecution({
      missionId: f.mission.id,
      missionTaskId: f.missionTask.id,
      taskId: f.missionTask.taskId,
      workflowId: f.workflowId,
    });
    const taskStatusBefore = (await container.tasks.getById(f.missionTask.taskId))?.status;
    for (let i = 0; i < 3; i++) await expect(down.processPending(f.mission.id)).rejects.toThrow();
    await down.processPending(f.mission.id);

    const parked = await f.qualityJobs.getByWorkflowId(f.workflowId);
    expect(parked).toMatchObject({
      state: "review_unavailable",
      lastError: "QUALITY_CONTROL_REVIEW_UNAVAILABLE",
      wakeupPending: false,
    });
    expect((await container.tasks.getById(f.missionTask.taskId))?.status).toBe(taskStatusBefore);
    expect(taskStatusBefore).not.toBe("failed");
    expect((await container.mission.getMissionTaskById(f.missionTask.id))?.status).toBe("review_pending");
    expect((await container.executionResults.getByWorkflowId(f.workflowId))?.outcome).toBe("success");

    // Cool-down elapsed + reviewer back => fresh budget, accepted.
    await container.db!.execute(
      sql`UPDATE quality_control_jobs SET claim_until = now() - interval '1 second' WHERE workflow_id = ${f.workflowId}`,
    );
    await f.service.recover(f.mission.id);
    expect((await container.tasks.getById(f.missionTask.taskId))?.status).toBe("succeeded");
    expect((await f.qualityJobs.getByWorkflowId(f.workflowId))?.state).toBe("action_applied");
  });
});
