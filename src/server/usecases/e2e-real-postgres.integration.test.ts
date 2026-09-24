import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import { InMemoryReviewerService } from "@/server/review/in-memory-reviewer-service";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

// Stable but unique UUID-shaped values keep the PostgreSQL proof deterministic.
let uuidIndex = 0;
vi.mock("node:crypto", () => ({
  randomUUID: () => {
    uuidIndex += 1;
    return `00000000-0000-4000-8000-${uuidIndex.toString().padStart(12, "0")}`;
  },
}));

describe("Real E2E with PostgreSQL + Temporal + Hermes (simulated)", () => {
  let container!: Container;
  let supervisor!: SupervisorService;
  let missionRepository!: MissionRepository;
  let taskExecutionResultRepository!: TaskExecutionResultRepository;
  let taskRepository!: TaskRepository;
  const reviewer = new InMemoryReviewerService();
  const reviewDecisions = new InMemoryReviewDecisionRepository();

  beforeEach(async () => {
    uuidIndex = 0;
    // Close existing container if any
    if (container) {
      await container.close();
    }
    // Set environment to use postgres
    process.env.PERSISTENCE = "postgres";
    // Phase 4 database safety: only the authorized disposable probe is used.
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:65535";
    process.env.OMNIROUTE_API_KEY = "phase-4-e2e-test-key";
    process.env.ICOS_REVIEWER_MODEL = "phase-4-e2e-reviewer";
    // Create a fresh container
    container = await import("@/server/container").then(({ createContainer }) => createContainer());
    if (!container) throw new Error("Container is null");
    missionRepository = container.mission;
    taskExecutionResultRepository = container.executionResults;
    taskRepository = container.tasks;

    const db = container.db;
    if (!db) throw new Error("container.db is undefined for a postgres-backed container");
    await db.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));

    // Get the dispatcher and mock its dispatch method to return a deterministic workflowId
    const dispatcher = container.taskExecution;
    vi.spyOn(dispatcher, "dispatch").mockImplementation((input) => {
      return Promise.resolve({ workflowId: `icos-task-${input.taskId}` });
    });

    supervisor = new SupervisorService(
      missionRepository,
      container.tasks,
      dispatcher,
      container.durableMemory,
      container.dispatchAttempts,
    );
  });

  afterEach(async () => {
    if (container) {
      // Clear the database using the container's db
      const db = container.db;
      if (db) {
        await db.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));
      }
      await container.close();
    }
    // Clean up env
    delete process.env.PERSISTENCE;
    delete process.env.DATABASE_URL;
    delete process.env.OMNIROUTE_BASE_URL;
    delete process.env.OMNIROUTE_API_KEY;
    delete process.env.ICOS_REVIEWER_MODEL;
  });

  it("should process a mission A->B->C with real PostgreSQL repository and end with mission succeeded", async () => {
    if (!container || !supervisor) throw new Error("Container or supervisor not initialized");

    // Step 1: Create mission with tasks A, B, C with empty dependsOn (we will update via SQL after creation)
    const mission = await missionRepository.create({
      title: "Real E2E Test Mission",
      objective: "Test the supervisor loop with PostgreSQL",
      tasks: [
        { title: "Task A", description: "STEP_A_OK", dependsOn: [], workerKind: "agent" },
        { title: "Task B", description: "STEP_B_OK", dependsOn: [], workerKind: "agent" },
        {
          title: "Task C",
          description: "SUPERVISOR_MISSION_OK",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });

    // Expect mission to be created
    expect(mission).not.toBeNull();
    const missionId = mission.id;
    expect(missionId).toMatch(/^00000000-0000-4000-8000-\d{12}$/);

    // Get the mission tasks to get their actual IDs
    let tasks = await missionRepository.listTasks(missionId);
    expect(tasks).toHaveLength(3);

    // Find each task by title
    const taskA = tasks.find((t) => t.title === "Task A");
    const taskB = tasks.find((t) => t.title === "Task B");
    const taskC = tasks.find((t) => t.title === "Task C");

    expect(taskA).not.toBeNull();
    expect(taskB).not.toBeNull();
    expect(taskC).not.toBeNull();

    const taskAId = taskA!.id;
    const taskBId = taskB!.id;
    const taskCId = taskC!.id;

    // Update the dependsOn for taskB and taskC via SQL (since PostgreSQL repository doesn't have update method)
    const { missionTasks } = await import("@/server/database/schema");
    const db = container.db;
    if (!db) throw new Error("container.db is undefined for a postgres-backed container");
    await db
      .update(missionTasks)
      .set({ dependsOn: [taskAId] })
      .where(eq(missionTasks.id, taskBId));
    await db
      .update(missionTasks)
      .set({ dependsOn: [taskBId] })
      .where(eq(missionTasks.id, taskCId));

    // Refresh tasks to get the updated dependsOn
    tasks = await missionRepository.listTasks(missionId);
    const taskAWithDeps = tasks.find((t) => t.title === "Task A");
    const taskBWithDeps = tasks.find((t) => t.title === "Task B");
    const taskCWithDeps = tasks.find((t) => t.title === "Task C");

    expect(taskAWithDeps).not.toBeNull();
    expect(taskBWithDeps).not.toBeNull();
    expect(taskCWithDeps).not.toBeNull();

    if (!taskAWithDeps || !taskBWithDeps || !taskCWithDeps) {
      throw new Error("Tasks not found");
    }

    const taskAIdWithDeps = taskAWithDeps.id;
    const taskBIdWithDeps = taskBWithDeps.id;
    const taskCIdWithDeps = taskCWithDeps.id;

    // Expect the dependsOn to be set correctly
    expect(taskAWithDeps?.dependsOn).toEqual([]);
    expect(taskBWithDeps?.dependsOn).toEqual([taskAIdWithDeps]);
    expect(taskCWithDeps?.dependsOn).toEqual([taskBIdWithDeps]);

    // Initially, all tasks should be draft
    expect(taskAWithDeps?.status).toBe("draft");
    expect(taskBWithDeps?.status).toBe("draft");
    expect(taskCWithDeps?.status).toBe("draft");

    // Run supervisor for the first time: should dispatch A only
    await supervisor.run(missionId);

    // Check that dispatcher.dispatch was called once for task A
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(1);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        taskId: taskAWithDeps.taskId,
        taskTitle: taskAWithDeps.title,
        prompt: taskAWithDeps.description || taskAWithDeps.title,
      }),
    );

    // After running supervisor, task A should be queued
    const updatedTasksAfterRun1 = await missionRepository.listTasks(missionId);
    const queuedTaskA = updatedTasksAfterRun1.find((t) => t.id === taskAIdWithDeps);
    const queuedTaskB = updatedTasksAfterRun1.find((t) => t.id === taskBIdWithDeps);
    const queuedTaskC = updatedTasksAfterRun1.find((t) => t.id === taskCIdWithDeps);

    expect(queuedTaskA?.status).toBe("queued");
    expect(queuedTaskB?.status).toBe("draft"); // B should not be queued yet
    expect(queuedTaskC?.status).toBe("draft"); // C should not be queued yet

    // Simulate successful callback for task A (as if Hermes completed it)
    // Simulate successful callback for task A (as if Hermes completed it)
    const resultA = await recordTaskExecution(
      {
        tasks: taskRepository,
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        durableMemory: container.durableMemory,
        dispatchAttempts: container.dispatchAttempts,
      },
      {
        taskId: taskAWithDeps.taskId,
        workflowId: `icos-task-${taskAWithDeps.taskId}`,
        outcome: "success",
        result: "Task A completed",
        completedAt: new Date().toISOString(),
      },
    );
    expect(resultA.ok).toBe(true);
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        tasks: container.tasks,
        reviewer,
        reviewDecisions,
      },
      {
        missionId: missionId,
        taskId: taskAWithDeps.taskId,
        workflowId: `icos-task-${taskAWithDeps.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );

    // After callback, task A should be succeeded
    const tasksAfterACallback = await missionRepository.listTasks(missionId);
    const succeededTaskA = tasksAfterACallback.find((t) => t.id === taskAIdWithDeps);
    expect(succeededTaskA?.status).toBe("succeeded");

    // Run supervisor again: now B should be queued (since A succeeded)
    await supervisor.run(missionId);

    // Check that dispatcher.dispatch was called again for task B
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(2);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        taskId: taskBWithDeps.taskId,
        taskTitle: taskBWithDeps.title,
        prompt: taskBWithDeps.description || taskBWithDeps.title,
      }),
    );

    // After running supervisor, task B should be queued
    const tasksAfterBDispatch = await missionRepository.listTasks(missionId);
    const queuedTaskBAfter = tasksAfterBDispatch.find((t) => t.id === taskBIdWithDeps);
    const queuedTaskCAfter = tasksAfterBDispatch.find((t) => t.id === taskCIdWithDeps);
    expect(queuedTaskBAfter?.status).toBe("queued");
    expect(queuedTaskCAfter?.status).toBe("draft"); // C should not be queued yet

    // Simulate successful callback for task B
    const resultB = await recordTaskExecution(
      {
        tasks: taskRepository,
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        durableMemory: container.durableMemory,
        dispatchAttempts: container.dispatchAttempts,
      },
      {
        taskId: taskBWithDeps.taskId,
        workflowId: `icos-task-${taskBWithDeps.taskId}`,
        outcome: "success",
        result: "Task B completed",
        completedAt: new Date().toISOString(),
      },
    );
    expect(resultB.ok).toBe(true);
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        tasks: container.tasks,
        reviewer,
        reviewDecisions,
      },
      {
        missionId: missionId,
        taskId: taskBWithDeps.taskId,
        workflowId: `icos-task-${taskBWithDeps.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );

    // After callback, task B should be succeeded
    const tasksAfterBCallback = await missionRepository.listTasks(missionId);
    const succeededTaskB = tasksAfterBCallback.find((t) => t.id === taskBIdWithDeps);
    expect(succeededTaskB?.status).toBe("succeeded");

    // Run supervisor again: now C should be queued
    await supervisor.run(missionId);

    // Check that dispatcher.dispatch was called again for task C
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(3);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        taskId: taskCWithDeps.taskId,
        taskTitle: taskCWithDeps.title,
        prompt: taskCWithDeps.description || taskCWithDeps.title,
      }),
    );

    // After running supervisor, task C should be queued
    const tasksAfterCDispatch = await missionRepository.listTasks(missionId);
    const queuedTaskCAfter2 = tasksAfterCDispatch.find((t) => t.id === taskCIdWithDeps);
    expect(queuedTaskCAfter2?.status).toBe("queued");

    // Simulate successful callback for task C
    const resultC = await recordTaskExecution(
      {
        tasks: taskRepository,
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        durableMemory: container.durableMemory,
        dispatchAttempts: container.dispatchAttempts,
      },
      {
        taskId: taskCWithDeps.taskId,
        workflowId: `icos-task-${taskCWithDeps.taskId}`,
        outcome: "success",
        result: "Task C completed",
        completedAt: new Date().toISOString(),
      },
    );
    expect(resultC.ok).toBe(true);
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        tasks: container.tasks,
        reviewer,
        reviewDecisions,
      },
      {
        missionId: missionId,
        taskId: taskCWithDeps.taskId,
        workflowId: `icos-task-${taskCWithDeps.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );

    // After callback, task C should be succeeded
    const tasksAfterCCallback = await missionRepository.listTasks(missionId);
    const succeededTaskC = tasksAfterCCallback.find((t) => t.id === taskCIdWithDeps);
    expect(succeededTaskC?.status).toBe("succeeded");

    // Run supervisor one more time: now the mission should be succeeded
    await supervisor.run(missionId);

    // Check the mission status
    const finalMission = await missionRepository.findById(missionId);
    expect(finalMission?.status).toBe("succeeded");

    // Clean up: delete the mission
    if (missionRepository.deleteMission) {
      await missionRepository.deleteMission(missionId);
    }
  });
});
