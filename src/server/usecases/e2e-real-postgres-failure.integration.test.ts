import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createContainer, type Container } from "@/server/container";

import { SupervisorService } from "@/server/supervisor/supervisor-service";

import { recordTaskExecution } from "@/server/usecases/record-task-execution";

import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";

import type { MissionRepository } from "@/server/mission/ports";

import type { TaskExecutionResultRepository } from "@/server/repositories/ports";

import type { TaskRepository } from "@/server/repositories/ports";

import type { DurableMemory } from "@/server/repositories/ports";

import type { ReviewerService } from "@/server/review/ports";

import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";

import { sql } from "drizzle-orm";

import { missionTasks } from "@/server/database/schema";

import { eq } from "drizzle-orm";

const COMPLETED_AT = "2026-09-16T10:00:00.000Z";

describe("Real E2E failure with PostgreSQL + Temporal + Hermes (simulated)", () => {
  let container: Container | null = null;

  let realFetch: typeof fetch = global.fetch;

  let supervisor: SupervisorService | null = null;

  let dispatchSpy: ReturnType<typeof vi.spyOn>;

  let missionRepository: MissionRepository;

  let taskExecutionResultRepository: TaskExecutionResultRepository;

  let taskRepository: TaskRepository;

  beforeEach(async () => {
    if (container) {
      await container.close();
    }

    process.env.PERSISTENCE = "postgres";

    process.env.DATABASE_URL = TEST_DATABASE_URL;

    // Set dummy environment variables for OmniRoute reviewer to allow PostgreSQL container creation
    process.env.OMNIROUTE_BASE_URL = "http://dummy";
    process.env.OMNIROUTE_API_KEY = "dummy";
    process.env.ICOS_REVIEWER_MODEL = "dummy";
    process.env.ICOS_REVIEWER_TIMEOUT_MS = "60000";

    /*
     * Un VRAI `Response`, pas un objet qui en a la forme utile.
     *
     * Le faux précédent (`{ ok, json }` forcé en `any`) n'avait ni `headers` ni
     * `clone()`. Il suffisait tant que le relecteur ne lisait que `ok` et `json`,
     * mais il ment sur `typeof fetch` : depuis que la dépense est mesurée à cette
     * couture, le compteur a besoin du content-type et d'un clone pour lire la
     * consommation. Un faux qui ne respecte pas le contrat qu'il prétend remplir
     * finit toujours par faire échouer le vrai code pour une mauvaise raison.
     *
     * Il porte aussi un bloc `usage` : sans lui chaque appel serait UNMETERED, et
     * une fenêtre non mesurée refuse — à juste titre — tout appel suivant.
     */
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "dummy",
            choices: [
              {
                message: {
                  content: JSON.stringify({ decision: "APPROVE", reasons: ["test"] }),
                },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ) as unknown as typeof fetch;
    realFetch = global.fetch;
    global.fetch = fetchMock;

    container = await import("@/server/container").then(({ createContainer }) => createContainer());

    if (!container) throw new Error("Container is null");

    missionRepository = container.mission;

    taskRepository = container.tasks;

    taskExecutionResultRepository = container.executionResults;

    // Test database only (createDatabase refuses anything else): TRUNCATE CASCADE,
    // never DELETE on append-only tables and never disabling triggers.
    const db = container.db;
    if (!db) throw new Error("container.db is undefined for a postgres-backed container");
    await db.execute(
      sql.raw("TRUNCATE TABLE missions, tasks, actions, decisions RESTART IDENTITY CASCADE"),
    );

    // Get the dispatcher and mock its dispatch method to return a deterministic workflowId

    const dispatcher = container.taskExecution;

    dispatchSpy = vi.spyOn(dispatcher, "dispatch").mockImplementation((input) => {
      return Promise.resolve({ workflowId: `icos-task-${input.taskId}` });
    });

    supervisor = new SupervisorService(
      missionRepository,

      taskRepository,

      dispatcher,

      container.durableMemory,
    );
  });

  afterEach(async () => {
    // Test database only: TRUNCATE CASCADE, never DELETE on append-only tables.
    const db = container?.db;
    if (db) {
      await db.execute(
        sql.raw("TRUNCATE TABLE missions, tasks, actions, decisions RESTART IDENTITY CASCADE"),
      );
    }
    global.fetch = realFetch;

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

  it("should process a mission A->B(fail)->C with real PostgreSQL repository and end with mission failed, C never dispatched", async () => {
    if (!container) throw new Error("Container not initialized");

    if (!supervisor) throw new Error("Supervisor not initialized");

    // Create mission with dependsOn set to empty array (we will set dependsOn after getting the tasks)

    const mission = await missionRepository.create({
      title: "Real E2E Failure Test Mission",

      objective: "Test the supervisor loop with PostgreSQL on failure",

      tasks: [
        { title: "Task A", description: "STEP_A_OK", dependsOn: [], workerKind: "agent" },

        { title: "Task B", description: "STEP_B_FAIL", dependsOn: [], workerKind: "agent" },

        {
          title: "Task C",

          description: "SUPERVISOR_MISSION_OK",

          dependsOn: [],

          workerKind: "agent",
        },
      ],
    });

    // Get the mission tasks

    let tasks = await missionRepository.listTasks(mission.id);

    expect(tasks).toHaveLength(3);

    // Find each task by title

    let missionTaskA = tasks.find((t) => t.title === "Task A")!;

    let missionTaskB = tasks.find((t) => t.title === "Task B")!;

    let missionTaskC = tasks.find((t) => t.title === "Task C")!;

    // Update dependsOn in the database: B depends on A, C depends on B

    const db = container.db;

    if (!db) throw new Error("container.db is undefined for a postgres-backed container");

    await db

      .update(missionTasks)

      .set({ dependsOn: [missionTaskA.id] })

      .where(eq(missionTasks.id, missionTaskB.id));

    await db

      .update(missionTasks)

      .set({ dependsOn: [missionTaskB.id] })

      .where(eq(missionTasks.id, missionTaskC.id));

    // Refresh tasks to get the updated dependsOn (though we don't need it for the test, but for consistency)

    tasks = await missionRepository.listTasks(mission.id);

    missionTaskA = tasks.find((t) => t.title === "Task A")!;

    missionTaskB = tasks.find((t) => t.title === "Task B")!;

    missionTaskC = tasks.find((t) => t.title === "Task C")!;

    // Initially, all tasks should be draft

    expect(missionTaskA.status).toBe("draft");

    expect(missionTaskB.status).toBe("draft");

    expect(missionTaskC.status).toBe("draft");

    // Run supervisor for the first time: should dispatch A only

    await supervisor.run(mission.id);

    // Check that dispatcher.dispatch was called once for task A (using canonical task ID)

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(1);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: missionTaskA.taskId,
        prompt: missionTaskA.description || missionTaskA.title,
        workerKind: "agent",
        capability: undefined,
        digitalosFacadePath: undefined,
      }),
    );

    // After running supervisor, task A should be queued

    const updatedTasksAfterRun1 = await missionRepository.listTasks(mission.id);

    const queuedTaskA = updatedTasksAfterRun1.find((t) => t.id === missionTaskA.id)!;

    const queuedTaskB = updatedTasksAfterRun1.find((t) => t.id === missionTaskB.id)!;

    const queuedTaskC = updatedTasksAfterRun1.find((t) => t.id === missionTaskC.id)!;

    expect(queuedTaskA.status).toBe("queued");

    expect(queuedTaskB.status).toBe("draft"); // B should not be queued yet

    expect(queuedTaskC.status).toBe("draft"); // C should not be queued yet

    // Simulate successful callback for task A (as if Hermes completed it)

    const resultA = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskA.taskId,

        workflowId: `icos-task-${missionTaskA.taskId}`,

        outcome: "success",

        result: "Task A completed",

        completedAt: new Date().toISOString(),
      },
    );

    expect(resultA.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: mission.id,

        taskId: missionTaskA.taskId,

        workflowId: `icos-task-${missionTaskA.taskId}`,

        outcome: "success",

        completedAt: new Date().toISOString(),
      },
    );

    // After callback, task A should be succeeded

    const tasksAfterACallback = await missionRepository.listTasks(mission.id);

    const succeededTaskA = tasksAfterACallback.find((t) => t.id === missionTaskA.id)!;

    expect(succeededTaskA.status).toBe("succeeded");

    // Run supervisor again: now B should be queued (since A succeeded)

    await supervisor.run(mission.id);

    // Check that dispatcher.dispatch was called again for task B (using canonical task ID)

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(2);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: missionTaskB.taskId,
        prompt: missionTaskB.description || missionTaskB.title,
      }),
    );

    // After running supervisor, task B should be queued

    const tasksAfterBDispatch = await missionRepository.listTasks(mission.id);

    const queuedTaskBAfter = tasksAfterBDispatch.find((t) => t.id === missionTaskB.id)!;

    const queuedTaskCAfter = tasksAfterBDispatch.find((t) => t.id === missionTaskC.id)!;

    expect(queuedTaskBAfter.status).toBe("queued");

    expect(queuedTaskCAfter.status).toBe("draft"); // C should not be queued yet

    const resultB = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskB.taskId,

        workflowId: `icos-task-${missionTaskB.taskId}`,

        outcome: "failure",

        error: { code: "WORKER_FAILED", message: "Task B failed intentionally" },

        completedAt: new Date().toISOString(),
      },
    );

    expect(resultB.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: mission.id,

        taskId: missionTaskB.taskId,

        workflowId: `icos-task-${missionTaskB.taskId}`,

        outcome: "failure",

        completedAt: new Date().toISOString(),
      },
    );

    // After callback, task B should be failed

    const tasksAfterBCallback = await missionRepository.listTasks(mission.id);

    const failedTaskB = tasksAfterBCallback.find((t) => t.id === missionTaskB.id)!;

    expect(failedTaskB.status).toBe("failed");

    // Run supervisor again: C should NOT be queued because B failed

    await supervisor.run(mission.id);

    // Check that dispatcher.dispatch was NOT called for task C

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(2); // Still only 2 calls

    // Verify task C is still draft (never queued)

    const tasksAfterSupervisorRun = await missionRepository.listTasks(mission.id);

    const taskCStatus = tasksAfterSupervisorRun.find((t) => t.id === missionTaskC.id)!.status;

    expect(taskCStatus).toBe("draft"); // C should remain draft, never dispatched

    // Check mission status: based on V1 rule, mission should be failed when any required task fails

    const finalMission = await missionRepository.findById(mission.id);

    expect(finalMission?.status).toBe("failed");
  });

  it("should demonstrate idempotence: replaying callbacks does not cause extra dispatches or duplicate execution results", async () => {
    if (!container) throw new Error("Container not initialized");

    if (!supervisor) throw new Error("Supervisor not initialized");

    // Create mission with dependsOn set to empty, then we will set dependsOn after getting the tasks.

    const mission = await missionRepository.create({
      title: "Idempotence Test Mission",

      objective: "Test idempotence of callback processing",

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

    expect(mission).not.toBeNull();

    const missionId = mission.id;

    // Get tasks

    let tasks = await missionRepository.listTasks(missionId);

    expect(tasks).toHaveLength(3);

    let missionTaskA = tasks.find((t) => t.title === "Task A")!;

    let missionTaskB = tasks.find((t) => t.title === "Task B")!;

    let missionTaskC = tasks.find((t) => t.title === "Task C")!;

    expect(missionTaskA).not.toBeNull();

    expect(missionTaskB).not.toBeNull();

    expect(missionTaskC).not.toBeNull();

    // Update dependsOn in the database: B depends on A, C depends on B

    const db = container.db;

    if (!db) throw new Error("container.db is undefined for a postgres-backed container");

    await db

      .update(missionTasks)

      .set({ dependsOn: [missionTaskA.id] })

      .where(eq(missionTasks.id, missionTaskB.id));

    await db

      .update(missionTasks)

      .set({ dependsOn: [missionTaskB.id] })

      .where(eq(missionTasks.id, missionTaskC.id));

    // Refresh tasks to get the updated dependsOn (though we don't need it for the test, but for consistency)

    tasks = await missionRepository.listTasks(missionId);

    missionTaskA = tasks.find((t) => t.title === "Task A")!;

    missionTaskB = tasks.find((t) => t.title === "Task B")!;

    missionTaskC = tasks.find((t) => t.title === "Task C")!;

    // --- Step 1: Initial supervisor run -> dispatch A ---

    await supervisor.run(missionId);

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(1);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: missionTaskA.taskId,
        prompt: missionTaskA.description || missionTaskA.title,
        workerKind: "agent",
        capability: undefined,
        digitalosFacadePath: undefined,
      }),
    );

    const resultA = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskA.taskId,

        workflowId: `icos-task-${missionTaskA.taskId}`,

        outcome: "success",

        result: "Task A completed",

        completedAt: COMPLETED_AT,
      },
    );

    expect(resultA.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: missionId,

        taskId: missionTaskA.taskId,

        workflowId: `icos-task-${missionTaskA.taskId}`,

        outcome: "success",

        completedAt: new Date().toISOString(),
      },
    );

    // --- Step 2: After A success, supervisor run -> dispatch B ---

    await supervisor.run(missionId);

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(2);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: missionTaskB.taskId,
        prompt: missionTaskB.description || missionTaskB.title,
      }),
    );

    // Simulate B success callback

    const resultB = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskB.taskId,

        workflowId: `icos-task-${missionTaskB.taskId}`,

        outcome: "success",

        result: "Task B completed",

        completedAt: COMPLETED_AT,
      },
    );

    expect(resultB.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: missionId,

        taskId: missionTaskB.taskId,

        workflowId: `icos-task-${missionTaskB.taskId}`,

        outcome: "success",

        completedAt: new Date().toISOString(),
      },
    );

    // --- Step 3: After B success, supervisor run -> dispatch C ---

    await supervisor.run(missionId);

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(3);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: missionTaskC.taskId,
        prompt: missionTaskC.description || missionTaskC.title,
      }),
    );

    // Simulate C success callback

    const resultC = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskC.taskId,

        workflowId: `icos-task-${missionTaskC.taskId}`,

        outcome: "success",

        result: "Task C completed",

        completedAt: COMPLETED_AT,
      },
    );

    expect(resultC.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: missionId,

        taskId: missionTaskC.taskId,

        workflowId: `icos-task-${missionTaskC.taskId}`,

        outcome: "success",

        completedAt: new Date().toISOString(),
      },
    );

    // --- Step 4: After C success, supervisor run -> mission succeeded ---

    await supervisor.run(missionId);

    const finalMission = await missionRepository.findById(missionId);

    expect(finalMission?.status).toBe("succeeded");

    // At this point, we have dispatched each task exactly once.

    // Let's record the dispatch count and execution result counts.

    const dispatchCountAfterSuccess = dispatchSpy.mock.calls.length;

    expect(dispatchCountAfterSuccess).toBe(3);

    // Now, replay the callbacks for A, B, C in any order and ensure no extra dispatches.

    // Replay A success callback

    const resultAReply = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskA.taskId,

        workflowId: `icos-task-${missionTaskA.taskId}`,

        outcome: "success",

        result: "Task A completed",

        completedAt: COMPLETED_AT,
      },
    );

    expect(resultAReply.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: missionId,

        taskId: missionTaskA.taskId,

        workflowId: `icos-task-${missionTaskA.taskId}`,

        outcome: "success",

        completedAt: new Date().toISOString(),
      },
    );

    // Replay B success callback

    const resultBReply = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskB.taskId,

        workflowId: `icos-task-${missionTaskB.taskId}`,

        outcome: "success",

        result: "Task B completed",

        completedAt: COMPLETED_AT,
      },
    );

    expect(resultBReply.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: missionId,

        taskId: missionTaskB.taskId,

        workflowId: `icos-task-${missionTaskB.taskId}`,

        outcome: "success",

        result: "Task B completed",

        completedAt: COMPLETED_AT,
      },
    );

    // Replay C success callback

    const resultCReply = await recordTaskExecution(
      {
        tasks: taskRepository,

        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        durableMemory: container.durableMemory,
      },

      {
        taskId: missionTaskC.taskId,

        workflowId: `icos-task-${missionTaskC.taskId}`,

        outcome: "success",

        result: "Task C completed",

        completedAt: COMPLETED_AT,
      },
    );

    expect(resultCReply.ok).toBe(true);

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,

        supervisor,

        missions: missionRepository,

        tasks: container.tasks,

        reviewer: container.reviewer,

        reviewDecisions: container.reviewDecisions,
      },

      {
        missionId: missionId,

        taskId: missionTaskC.taskId,

        workflowId: `icos-task-${missionTaskC.taskId}`,

        outcome: "success",

        completedAt: new Date().toISOString(),
      },
    );

    // After all replays, dispatch count should still be 3

    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(3);

    // Verify that there are no duplicate task execution results for each task (should be exactly 1: only the original, because replay did not insert a new one)

    const resultsForA = await taskExecutionResultRepository.listByTaskIds([missionTaskA.taskId]);

    expect(resultsForA).toHaveLength(1); // only the original record

    const resultsForB = await taskExecutionResultRepository.listByTaskIds([missionTaskB.taskId]);

    expect(resultsForB).toHaveLength(1);

    const resultsForC = await taskExecutionResultRepository.listByTaskIds([missionTaskC.taskId]);

    expect(resultsForC).toHaveLength(1);

    // Also verify that the mission status remains succeeded (no change)

    const missionAfterReplays = await missionRepository.findById(missionId);

    expect(missionAfterReplays?.status).toBe("succeeded");
  });
});
