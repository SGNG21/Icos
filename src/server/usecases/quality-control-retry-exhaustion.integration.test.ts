import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { loadEnv } from "@/config/env";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import type { ReviewerService } from "@/server/review/ports";

import { MAX_EXECUTION_RETRIES, QualityControlService } from "./quality-control-service";

/**
 * CHAOS — RETRY EXHAUSTION on PostgreSQL.
 *
 * The unit suite proves the CORRECTION budget (REQUEST_CHANGES) is bounded. The EXECUTION-retry
 * budget (RETRY after a worker failure, MAX_EXECUTION_RETRIES) had no durable proof: a worker
 * that keeps timing out must be retried a bounded number of times, each as a distinct durable
 * attempt, and then be FORCED to a human — the QC job escalated, the task failed, and no further
 * attempt prepared — rather than retried for ever.
 *
 * Double: the reviewer (always answers RETRY). Everything else is the production Postgres path.
 */

const retryingReviewer = (): ReviewerService => ({
  review: vi.fn(async (input) =>
    ({
      id: `review-${input.executionResult.id}`,
      missionId: input.mission.id,
      taskId: input.task.id,
      workflowId: input.executionResult.workflowId,
      decision: "RETRY",
      reviewerKind: "llm",
      severity: "warning",
      reasons: ["the worker timed out; retry"],
      createdAt: new Date().toISOString(),
      humanOverridden: false,
    }) satisfies ReviewDecisionRecord,
  ),
});

describe("CHAOS — retry exhaustion (PostgreSQL)", () => {
  let container: Container;

  beforeAll(async () => {
    container = await buildPostgresContainer(
      TEST_DATABASE_URL,
      undefined,
      loadEnv({
        NODE_ENV: "test",
        PERSISTENCE: "postgres",
        DATABASE_URL: TEST_DATABASE_URL,
        OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
        OMNIROUTE_API_KEY: "retry-exhaustion-key",
        ICOS_REVIEWER_MODEL: "retry-exhaustion-reviewer",
        ICOS_REVIEWER_TIMEOUT_MS: "1000",
      }),
    );
  });

  afterAll(async () => {
    await container?.close();
  });

  it(`a worker that keeps failing is retried exactly ${MAX_EXECUTION_RETRIES} times, then forced to a human`, async () => {
    expect(MAX_EXECUTION_RETRIES).toBe(2);
    await container.db!.execute(
      sql`TRUNCATE TABLE quality_control_jobs, dispatch_attempts, task_execution_results, decisions, missions, tasks RESTART IDENTITY CASCADE`,
    );
    const mission = await container.mission.create({
      title: "Retry exhaustion",
      objective: "Prove the execution-retry budget is bounded",
      tasks: [
        { title: "Flaky work", description: "Always times out", dependsOn: [], workerKind: "hermes", capability: null },
      ],
    });
    const mt = (await container.mission.listTasks(mission.id))[0]!;
    await container.mission.updateMissionTaskStatus(mission.id, mt.id, "queued");
    await container.tasks.transition(mt.taskId, "queued");
    await container.tasks.transition(mt.taskId, "running");
    const first = await container.dispatchAttempts.prepare({
      missionId: mission.id,
      missionTaskId: mt.id,
      taskId: mt.taskId,
      attempt: 1,
      workflowId: workflowIdForAttempt(mt.taskId, 1),
      prompt: "Always times out",
      workerKind: "hermes",
    });
    await container.dispatchAttempts.markDispatched(first.attempt.id, { owner: "chaos", leaseMs: 60_000 });

    const qualityJobs = new PostgresQualityControlRepository(container.db!);
    const reviewer = retryingReviewer();
    const qc = new QualityControlService({
      missions: container.mission,
      tasks: container.tasks,
      executionResults: container.executionResults,
      reviewer,
      reviewDecisions: container.reviewDecisions,
      dispatchAttempts: container.dispatchAttempts,
      qualityJobs,
    });

    /* Each attempt: the worker times out, the failure is recorded, QC reviews and acts. */
    for (let attempt = 1; attempt <= MAX_EXECUTION_RETRIES + 1; attempt += 1) {
      const workflowId = workflowIdForAttempt(mt.taskId, attempt);
      const prepared = await container.dispatchAttempts.getByWorkflowId(workflowId);
      expect(prepared, `attempt ${attempt} was not prepared`).not.toBeNull();
      const recorded = await container.executionResults.record({
        taskId: mt.taskId,
        workflowId,
        outcome: "failure",
        error: { code: "WORKER_TIMEOUT", message: "Worker timed out" },
        completedAt: new Date().toISOString(),
      });
      expect(recorded.ok).toBe(true);
      await qc.registerExecution({ missionId: mission.id, missionTaskId: mt.id, taskId: mt.taskId, workflowId });
      await qc.processPending(mission.id);
      /* Duplicate processing of the same job never adds an attempt (no retry storm). */
      await qc.processPending(mission.id);
    }

    const attempts = (await container.db!.execute(
      sql`select attempt, workflow_id from dispatch_attempts where task_id = ${mt.taskId} order by attempt`,
    )) as unknown as Array<{ attempt: number; workflow_id: string }>;
    /* The original + exactly MAX_EXECUTION_RETRIES retries, each a distinct durable attempt. */
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(await container.dispatchAttempts.getByWorkflowId(workflowIdForAttempt(mt.taskId, 4))).toBeNull();

    /* FORCED TO A HUMAN: the last job escalated, the task failed (not retried, not succeeded). */
    const lastJob = await qualityJobs.getByWorkflowId(workflowIdForAttempt(mt.taskId, 3));
    expect(lastJob?.state).toBe("escalated");
    expect((await container.mission.getMissionTaskById(mt.id))?.status).toBe("failed");
    expect((await container.tasks.getById(mt.taskId))?.status).toBe("failed");
    expect((await container.reviewDecisions.listByTaskId(mt.taskId)).map((r) => r.decision)).toEqual([
      "RETRY",
      "RETRY",
      "RETRY",
    ]);
    expect(reviewer.review).toHaveBeenCalledTimes(3);

    /* A further sweep changes nothing. */
    await qc.recover(mission.id);
    expect(await container.dispatchAttempts.getByWorkflowId(workflowIdForAttempt(mt.taskId, 4))).toBeNull();
  }, 60_000);
});
