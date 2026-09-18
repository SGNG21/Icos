import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { POST } from "@/app/api/internal/executions/completed/route";
import { createContainer, type Container } from "@/server/container";
import { sql, eq } from "drizzle-orm";

// Mock the OmniRouteReviewer module to avoid HTTP calls in tests
vi.mock("@/server/review/omniroute-reviewer", () => {
  return {
    OmniRouteReviewer: vi.fn().mockImplementation(() => {
      return {
        review: vi.fn().mockResolvedValue({
          decision: "APPROVE",
          reasons: ["test reason"],
          requestedChanges: undefined,
          confidence: 1.0,
          providerMetadata: { provider: "omniroute", model: "test", temperature: 0 },
        }),
      };
    }),
    createOmniRouteReviewer: vi.fn().mockReturnValue({
      review: vi.fn().mockResolvedValue({
        decision: "APPROVE",
        reasons: ["test reason"],
        requestedChanges: undefined,
        confidence: 1.0,
        providerMetadata: { provider: "omniroute", model: "test", temperature: 0 },
      }),
    }),
  };
});

describe("Completed callback route - isolate HTTP 400 branch", () => {
  let container: Container | null = null;
  let db: any = null;

  const baseTime = new Date("2026-09-16T10:00:00.000Z");
  const baseTimeISO = baseTime.toISOString();

  beforeEach(async () => {
    if (container) {
      await container.close();
    }

    process.env.PERSISTENCE = "postgres";
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.OMNIROUTE_BASE_URL = "http://dummy";
    process.env.OMNIROUTE_API_KEY = "dummy";
    process.env.ICOS_REVIEWER_MODEL = "test-model";
    process.env.ICOS_REVIEWER_TIMEOUT_MS = "60000";

    container = await import("@/server/container").then(({ createContainer }) => createContainer());

    if (!container) throw new Error("Container is null");

    db = container.db;
    if (!db) throw new Error("container.db is undefined");

    // Import schema as an object to avoid destructuring issues
    const schema = await import("@/server/database/schema");
    await db.execute(sql`SET session_replication_role = replica;`);
    await db.delete(schema.missions);
    await db.delete(schema.missionTasks);
    await db.delete(schema.tasks);
    await db.delete(schema.dispatchAttempts);
    await db.delete(schema.auditEntries);
    await db.delete(schema.taskExecutionResults); // Fixed: was executionResults
    await db.delete(schema.decisions); // Corrected: was reviewDecisions
    await db.delete(schema.qualityControlJobs);
    await db.execute(sql`SET session_replication_role = origin;`);
  });

  afterEach(async () => {
    if (container) {
      await container.close();
    }
    // Clean up env
    delete process.env.PERSISTENCE;
    delete process.env.DATABASE_URL;
    delete process.env.OMNIROUTE_BASE_URL;
    delete process.env.OMNIROUTE_API_KEY;
    delete process.env.ICOS_REVIEWER_MODEL;
    delete process.env.ICOS_REVIEWER_TIMEOUT_MS;
  });

  // Helper to create a mock Request object
  const createMockRequest = (body: any) => {
    return new Request("http://localhost/api/internal/executions/completed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };

  // Helper to insert a mission and its tasks
  const insertMissionAndTasks = async (): Promise<{
    missionId: string;
    missionTaskId: string;
    taskId: string;
  }> => {
    // Import schema as an object
    const schema = await import("@/server/database/schema");

    // Insert a mission
    const missionResult = await db
      .insert(schema.missions)
      .values({
        id: "mission-test",
        title: "Test Mission",
        objective: "Test",
        status: "draft",
      })
      .returning();

    const missionId = missionResult[0].id;

    // Insert a task
    const taskResult = await db
      .insert(schema.tasks)
      .values({
        id: "task-test",
        title: "Test Task",
        status: "queued",
        assignedAgentId: null,
        createdAt: baseTime,
        updatedAt: baseTime,
      })
      .returning();

    const taskId = taskResult[0].id;

    // Insert a missionTask linking the mission and task
    const missionTaskResult = await db
      .insert(schema.missionTasks)
      .values({
        id: "mission-task-test",
        missionId: missionId,
        title: "Task A",
        description: "STEP_A_OK",
        dependsOn: [],
        status: "queued",
        workerKind: "agent",
        taskId: taskId,
        createdAt: baseTime,
        updatedAt: baseTime,
      })
      .returning();

    const missionTaskId = missionTaskResult[0].id;

    return { missionId, missionTaskId, taskId };
  };

  it("Branch B: returns 400 when dispatchAttempt not found for workflowId", async () => {
    // Insert a mission and task so that we have valid IDs
    const { missionId, missionTaskId, taskId } = await insertMissionAndTasks();

    // Do NOT insert any dispatchAttempt for the workflowId we will use

    const payload = {
      taskId: taskId,
      workflowId: "workflow-test-456", // This workflowId has no dispatchAttempt
      outcome: "failure",
      workerKind: "hermes",
      error: {
        code: "WORKER_FAILED",
        message: "synthetic worker failure"
      },
      startedAt: baseTimeISO,
      completedAt: baseTimeISO,
    };

    const request = createMockRequest(payload);
    // Mock the authentication to pass
    vi.spyOn(require("@/server/execution/callback-auth"), "verifyExecutionCallback").mockResolvedValueOnce({ ok: true });

    const response = await POST(request);
    expect(response.status).toBe(400);
    // We can also check the body if needed
    const json = await response.json();
    expect(json).toHaveProperty("error");
  });

  it("Branch C: returns 400 when dispatchAttempt exists but taskId does not match", async () => {
    // Insert a mission and task
    const { missionId, missionTaskId, taskId } = await insertMissionAndTasks();

    // Insert a dispatchAttempt with a different taskId
    const schema = await import("@/server/database/schema");
    await db
      .insert(schema.dispatchAttempts)
      .values({
        id: "dispatch-attempt-test",
        missionId: missionId,
        missionTaskId: missionTaskId,
        taskId: "different-task-id", // Different from the payload taskId
        attempt: 1,
        workflowId: "workflow-test-456",
        prompt: "test prompt",
        workerKind: "hermes",
        state: "prepared",
        createdAt: baseTime,
        updatedAt: baseTime,
      });

    const payload = {
      taskId: taskId, // This is the correct taskId from the mission/task
      workflowId: "workflow-test-456",
      outcome: "failure",
      workerKind: "hermes",
      error: {
        code: "WORKER_FAILED",
        message: "synthetic worker failure"
      },
      startedAt: baseTimeISO,
      completedAt: baseTimeISO,
    };

    const request = createMockRequest(payload);
    vi.spyOn(require("@/server/execution/callback-auth"), "verifyExecutionCallback").mockResolvedValueOnce({ ok: true });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toHaveProperty("error");
  });

  it("Branch D/E/F: returns 400 when missionTask is not found or ids mismatch", async () => {
    // Insert a mission and task
    const { missionId, missionTaskId, taskId } = await insertMissionAndTasks();

    // Insert a dispatchAttempt with the correct taskId and missionTaskId
    const schema = await import("@/server/database/schema");
    await db
      .insert(schema.dispatchAttempts)
      .values({
        id: "dispatch-attempt-test",
        missionId: missionId,
        missionTaskId: missionTaskId,
        taskId: taskId,
        attempt: 1,
        workflowId: "workflow-test-456",
        prompt: "test prompt",
        workerKind: "hermes",
        state: "prepared",
        createdAt: baseTime,
        updatedAt: baseTime,
      });

    // Now, for Branch D: missionTask not found
    // We will delete the missionTask we just inserted
    await db.delete(schema.missionTasks).where(eq(schema.missionTasks.id, missionTaskId));

    const payload = {
      taskId: taskId,
      workflowId: "workflow-test-456",
      outcome: "failure",
      workerKind: "hermes",
      error: {
        code: "WORKER_FAILED",
        message: "synthetic worker failure"
      },
      startedAt: baseTimeISO,
      completedAt: baseTimeISO,
    };

    const request = createMockRequest(payload);
    vi.spyOn(require("@/server/execution/callback-auth"), "verifyExecutionCallback").mockResolvedValueOnce({ ok: true });

    let response = await POST(request);
    expect(response.status).toBe(400);
    let json = await response.json();
    expect(json).toHaveProperty("error");

    // For Branch E: missionTask exists but missionTask.id does not match attempt.missionTaskId
    // Reinsert the missionTask but with a different id
    await db
      .insert(schema.missionTasks)
      .values({
        id: "different-mission-task-id", // Different from the one in dispatchAttempt
        missionId: missionId,
        title: "Task A",
        description: "STEP_A_OK",
        dependsOn: [],
        status: "queued",
        workerKind: "agent",
        taskId: taskId,
        createdAt: baseTime,
        updatedAt: baseTime,
      });

    response = await POST(request);
    expect(response.status).toBe(400);
    json = await response.json();
    expect(json).toHaveProperty("error");

    // For Branch F: missionTask exists but missionTask.missionId does not match attempt.missionId
    // Update the missionTask to have a different missionId
    await db
      .update(schema.missionTasks)
      .set({ missionId: "different-mission-id" })
      .where(eq(schema.missionTasks.id, "different-mission-task-id"));

    response = await POST(request);
    expect(response.status).toBe(400);
    json = await response.json();
    expect(json).toHaveProperty("error");
  });
});