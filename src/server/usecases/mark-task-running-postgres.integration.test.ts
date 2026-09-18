import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase } from "@/server/database/client";
import {
  auditEntries,
  dispatchAttempts,
  missionTasks,
  missions,
  tasks,
} from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { markTaskRunning } from "./mark-task-running";

const DATABASE_URL =
  "postgres://coco@localhost:5432/icos_n23_probe";

describe("markTaskRunning integration with PostgreSQL", () => {
  const db = createDatabase(DATABASE_URL);
  let missionRepository: PostgresMissionRepository;
  let taskRepository: PostgresTaskRepository;
  let dispatchAttemptsRepository: PostgresDispatchAttemptRepository;

  beforeAll(async () => {
    await db.db.select().from(missions).limit(1);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // Clean up the tables we use
    await db.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, mission_tasks, dispatch_attempts RESTART IDENTITY CASCADE",
      ),
    );

    const now = new Date();

    // Insert a canonical task
    await db.db.insert(tasks).values({
      id: "task-can-1",
      title: "Test Task",
      description: "Test",
      status: "draft",
      assignedAgentId: null,
      createdAt: now,
      updatedAt: now,
    });

    // Insert a mission
    await db.db.insert(missions).values({
      id: "mission-1",
      title: "Test Mission",
      objective: "Test",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    // Insert a mission task linked to the canonical task
    await db.db.insert(missionTasks).values({
      id: "mission-task-1",
      missionId: "mission-1",
      title: "Test Task",
      description: "Test",
      dependsOn: [],
      status: "draft",
      workerKind: "agent",
      capability: undefined,
      taskId: "task-can-1",
      createdAt: now,
      updatedAt: now,
    });

    missionRepository = new PostgresMissionRepository(db.db, new PostgresTaskRepository(db.db));
    taskRepository = new PostgresTaskRepository(db.db);
    dispatchAttemptsRepository = new PostgresDispatchAttemptRepository(db.db);
  });

  it("should transition task from queued to running when supervisor has queued both mission task and task", async () => {
    // Step 1: Supervisor prepares a dispatch (this sets missionTask to queued and task to queued via our fix)
    const workflowId = "icos-task-task-can-1";
    const attemptNumber = 1;
    const prepared = await dispatchAttemptsRepository.prepare({
      missionId: "mission-1",
      missionTaskId: "mission-task-1",
      taskId: "task-can-1",
      attempt: attemptNumber,
      workflowId,
      prompt: "Test prompt",
      workerKind: "agent",
      capability: undefined,
    });

    // Verify that the mission task is queued
    const missionTaskAfterPrepare = await missionRepository.getMissionTaskById("mission-task-1");
    expect(missionTaskAfterPrepare?.status).toBe("queued");

    // Verify that the canonical task is queued (this is the fix we added)
    const taskAfterPrepare = await taskRepository.getById("task-can-1");
    expect(taskAfterPrepare?.status).toBe("queued");

    // Step 2: Simulate the started callback from Temporal
    const result = await markTaskRunning(
      {
        tasks: taskRepository,
        dispatchAttempts: dispatchAttemptsRepository,
      },
      {
        taskId: "task-can-1",
        workflowId,
      },
    );

    // Expect the transition to be successful
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`Failed to mark task running: ${result.reason}`);
    }
    // Narrow the type to the success case
    const { alreadyRunning, task } = result as { ok: true; task: { status: string }; alreadyRunning: boolean };
    expect(alreadyRunning).toBe(false);
    expect(task.status).toBe("running");

    // Step 3: Duplicate callback should be idempotent
    const replay = await markTaskRunning(
      {
        tasks: taskRepository,
        dispatchAttempts: dispatchAttemptsRepository,
      },
      {
        taskId: "task-can-1",
        workflowId,
      },
    );
    expect(replay.ok).toBe(true);
    if (!replay.ok) {
      throw new Error(`Failed to mark task running (replay): ${replay.reason}`);
    }
    const { alreadyRunning: replayAlreadyRunning, task: replayTask } = replay as { ok: true; task: { status: string }; alreadyRunning: boolean };
    expect(replayAlreadyRunning).toBe(true);
    expect(replayTask.status).toBe("running");
  });

  it("should reject if the task is not queued (i.e., supervisor did not run)", async () => {
    // Do not prepare a dispatch, so mission task and task are still draft
    const workflowId = "icos-task-task-can-1";

    // We pass undefined for dispatchAttempts to skip the correlation check and go straight to transition validation
    const result = await markTaskRunning(
      {
        tasks: taskRepository,
        dispatchAttempts: undefined,
      },
      {
        taskId: "task-can-1",
        workflowId,
      },
    );

    // Expect invalid transition because task is draft, not queued
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid_transition");
      // Narrow the type to the error case
      const { message } = result as { message: string };
      expect(message).toContain("transition draft → running interdite");
    }
  });

  it("rejects an older dispatched callback after attempt 2 becomes authoritative", async () => {
    const first = await dispatchAttemptsRepository.prepare({
      missionId: "mission-1",
      missionTaskId: "mission-task-1",
      taskId: "task-can-1",
      attempt: 1,
      workflowId: "icos-task-task-can-1",
      prompt: "first",
    });
    await dispatchAttemptsRepository.markDispatched(first.attempt.id);
    const second = await dispatchAttemptsRepository.prepare({
      missionId: "mission-1",
      missionTaskId: "mission-task-1",
      taskId: "task-can-1",
      attempt: 2,
      workflowId: "icos-task-task-can-1-attempt-2",
      prompt: "second",
    });
    await dispatchAttemptsRepository.markDispatched(second.attempt.id);

    expect(
      await markTaskRunning(
        { tasks: taskRepository, dispatchAttempts: dispatchAttemptsRepository },
        { taskId: "task-can-1", workflowId: first.attempt.workflowId },
      ),
    ).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect((await taskRepository.getById("task-can-1"))?.status).toBe("queued");
    expect(
      await markTaskRunning(
        { tasks: taskRepository, dispatchAttempts: dispatchAttemptsRepository },
        { taskId: "task-can-1", workflowId: second.attempt.workflowId },
      ),
    ).toMatchObject({ ok: true, alreadyRunning: false });
  });

  it("fences a paused old callback when attempt 2 becomes authoritative", async () => {
    const first = await dispatchAttemptsRepository.prepare({
      missionId: "mission-1",
      missionTaskId: "mission-task-1",
      taskId: "task-can-1",
      attempt: 1,
      workflowId: "icos-task-task-can-1",
      prompt: "first",
    });
    await dispatchAttemptsRepository.markDispatched(first.attempt.id);

    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatchAttemptsRepository.setStartAuthorizationHookForTest?.(async () => {
      markEntered();
      await paused;
    });

    const stale = markTaskRunning(
      { tasks: taskRepository, dispatchAttempts: dispatchAttemptsRepository },
      { taskId: "task-can-1", workflowId: first.attempt.workflowId },
    );
    await entered;
    const secondRepository = new PostgresDispatchAttemptRepository(db.db);
    const second = await secondRepository.prepare({
      missionId: "mission-1",
      missionTaskId: "mission-task-1",
      taskId: "task-can-1",
      attempt: 2,
      workflowId: "icos-task-task-can-1-attempt-2",
      prompt: "second",
    });
    release();

    expect(await stale).toMatchObject({ ok: false, reason: "invalid_transition" });
    expect((await taskRepository.getById("task-can-1"))?.status).toBe("queued");
    expect(second.attempt.state).toBe("prepared");
  });

  it("handles two concurrent callbacks for the same current attempt idempotently", async () => {
    const prepared = await dispatchAttemptsRepository.prepare({
      missionId: "mission-1",
      missionTaskId: "mission-task-1",
      taskId: "task-can-1",
      attempt: 1,
      workflowId: "icos-task-task-can-1",
      prompt: "first",
    });
    await dispatchAttemptsRepository.markDispatched(prepared.attempt.id);
    const processB = new PostgresDispatchAttemptRepository(db.db);

    const results = await Promise.all([
      markTaskRunning(
        { tasks: taskRepository, dispatchAttempts: dispatchAttemptsRepository },
        { taskId: "task-can-1", workflowId: prepared.attempt.workflowId },
      ),
      markTaskRunning(
        { tasks: taskRepository, dispatchAttempts: processB },
        { taskId: "task-can-1", workflowId: prepared.attempt.workflowId },
      ),
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.alreadyRunning)).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.alreadyRunning)).toHaveLength(1);
    expect((await taskRepository.getById("task-can-1"))?.status).toBe("running");
    const transitionAudits = await db.db
      .select()
      .from(auditEntries)
      .where(sql`${auditEntries.taskId} = 'task-can-1' and ${auditEntries.eventType} = 'task.transitioned'`);
    expect(transitionAudits).toHaveLength(1);
  });
});