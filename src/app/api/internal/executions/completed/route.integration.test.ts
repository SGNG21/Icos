import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { POST } from "@/app/api/internal/executions/completed/route";
import { createContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import * as schema from "@/server/database/schema";

const SECRET = "completed-route-test-secret-0123456789abcdef";
const T0 = new Date("2026-09-16T10:00:00.000Z");
const WORKFLOW_ID = "workflow-correlation-test";

const ENV = {
  PERSISTENCE: "postgres",
  DATABASE_URL: TEST_DATABASE_URL,
  OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
  OMNIROUTE_API_KEY: "dummy",
  ICOS_REVIEWER_MODEL: "test-model",
  ICOS_REVIEWER_TIMEOUT_MS: "1000",
  ICOS_EXECUTION_CALLBACK_SECRET: SECRET,
};

/**
 * Correlation branches of POST /api/internal/executions/completed, against a
 * real PostgreSQL test database and the REAL callback authentication.
 * (The former "missionTask not found while the attempt exists" branch cannot
 * occur: dispatch_attempts.mission_task_id is ON DELETE CASCADE.)
 */
describe("POST /api/internal/executions/completed — workflow correlation", () => {
  let container: Container;
  const db = () => container.db!;

  beforeEach(async () => {
    Object.assign(process.env, ENV);
    container = await createContainer();
    await db().execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));
  });

  afterEach(async () => {
    await container?.db?.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));
    await container?.close();
    for (const key of Object.keys(ENV)) delete process.env[key];
  });

  async function seed(n: number) {
    const taskId = `task-${n}`;
    const missionId = `mission-${n}`;
    const missionTaskId = `mission-task-${n}`;
    await db().insert(schema.tasks).values({
      id: taskId,
      title: `Task ${n}`,
      status: "queued",
      assignedAgentId: null,
      createdAt: T0,
      updatedAt: T0,
    });
    await db().insert(schema.missions).values({
      id: missionId,
      title: `Mission ${n}`,
      objective: "correlation",
      status: "draft",
      createdAt: T0,
      updatedAt: T0,
    });
    await db().insert(schema.missionTasks).values({
      id: missionTaskId,
      missionId,
      title: `Task ${n}`,
      description: "STEP_OK",
      dependsOn: [],
      status: "queued",
      workerKind: "agent",
      taskId,
      createdAt: T0,
      updatedAt: T0,
    });
    return { taskId, missionId, missionTaskId };
  }

  const attempt = (missionId: string, missionTaskId: string, taskId: string) =>
    db().insert(schema.dispatchAttempts).values({
      id: "dispatch-attempt-test",
      missionId,
      missionTaskId,
      taskId,
      attempt: 1,
      workflowId: WORKFLOW_ID,
      prompt: "test prompt",
      workerKind: "hermes",
      state: "prepared",
      createdAt: T0,
      updatedAt: T0,
    });

  const post = (taskId: string, headers: Record<string, string> = { "x-icos-callback-secret": SECRET }) =>
    POST(
      new Request("http://localhost/api/internal/executions/completed", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({
          taskId,
          workflowId: WORKFLOW_ID,
          outcome: "failure",
          workerKind: "hermes",
          error: { code: "WORKER_FAILED", message: "synthetic worker failure" },
          startedAt: T0.toISOString(),
          completedAt: T0.toISOString(),
        }),
      }),
    );

  const expectUncorrelated = async (response: Response) => {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_input" } });
    // Nothing was persisted for an uncorrelated callback.
    const rows = await db().select().from(schema.taskExecutionResults);
    expect(rows).toHaveLength(0);
  };

  it("rejects a callback without the shared secret (real authentication)", async () => {
    const a = await seed(1);
    await attempt(a.missionId, a.missionTaskId, a.taskId);
    expect((await post(a.taskId, {})).status).toBe(401);
  });

  it("returns 400 when no dispatch attempt exists for the workflowId", async () => {
    const a = await seed(1);
    await expectUncorrelated(await post(a.taskId));
  });

  it("returns 400 when the dispatch attempt belongs to a different task", async () => {
    const a = await seed(1);
    const b = await seed(2);
    await attempt(a.missionId, a.missionTaskId, b.taskId);
    await expectUncorrelated(await post(a.taskId));
  });

  it("returns 400 when the attempt's missionTask is not the task's canonical missionTask", async () => {
    const a = await seed(1);
    const b = await seed(2);
    // Attempt for task 2 but bound to mission task 1.
    await attempt(b.missionId, a.missionTaskId, b.taskId);
    await expectUncorrelated(await post(b.taskId));
  });

  it("returns 400 when the attempt's mission differs from the missionTask's mission", async () => {
    const a = await seed(1);
    const b = await seed(2);
    // Attempt for task 2 bound to mission task 2 but to mission 1.
    await attempt(a.missionId, b.missionTaskId, b.taskId);
    await expectUncorrelated(await post(b.taskId));
  });
});
