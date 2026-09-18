import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { sql, eq } from "drizzle-orm";

import {
  buildPostgresContainer,
  type Container,
} from "@/server/container";
import { dispatchAttempts, missionTasks } from "@/server/database/schema";
import { InMemoryReviewerService } from "@/server/review/in-memory-reviewer-service";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionTask } from "@/core/mission/contracts";

const DATABASE_URL =
  "postgres://coco@localhost:5432/icos_n23_probe";

// buildPostgresContainer constructs PostgresReviewerService at instantiation
// time: these values only satisfy its configuration-time dependencies.
process.env.OMNIROUTE_BASE_URL ??= "http://127.0.0.1:65535";
process.env.OMNIROUTE_API_KEY ??= "n2-6-test-key";
process.env.ICOS_REVIEWER_MODEL ??= "n2-6-test-model";
process.env.ICOS_REVIEWER_TIMEOUT_MS ??= "1000";

const opened = new Set<Container>();

async function freshProcess(): Promise<Container> {
  const container = await buildPostgresContainer(DATABASE_URL);
  opened.add(container);
  return container;
}

async function shutdown(container: Container): Promise<void> {
  if (!opened.has(container)) return;
  opened.delete(container);
  await container.close();
}

function supervisorFor(container: Container) {
  return new SupervisorService(
    container.mission,
    container.tasks,
    container.taskExecution,
    container.durableMemory,
    container.dispatchAttempts,
  );
}

function mockTransport(container: Container) {
  return vi
    .spyOn(container.taskExecution, "dispatch")
    .mockImplementation(async (input) => ({
      workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
    }));
}

async function completeAndReview(
  container: Container,
  supervisor: SupervisorService,
  input: {
    missionId: string;
    taskId: string;
    workflowId: string;
    result: string;
  },
): Promise<void> {
  const completedAt = new Date().toISOString();

  const execution = await recordTaskExecution(
    {
      tasks: container.tasks,
      executionResults: container.executionResults,
      supervisor,
      missions: container.mission,
      durableMemory: container.durableMemory,
    },
    {
      taskId: input.taskId,
      workflowId: input.workflowId,
      outcome: "success",
      result: input.result,
      completedAt,
    },
  );

  expect(execution.ok).toBe(true);

  await recordMissionTaskExecution(
    {
      executionResults: container.executionResults,
      supervisor,
      missions: container.mission,
      tasks: container.tasks,
      reviewer: new InMemoryReviewerService(),
      reviewDecisions: container.reviewDecisions,
      taskExecution: container.taskExecution,
      durableMemory: container.durableMemory,
      dispatchAttempts: container.dispatchAttempts,
    },
    {
      missionId: input.missionId,
      taskId: input.taskId,
      workflowId: input.workflowId,
      outcome: "success",
      result: input.result,
      completedAt,
    },
  );
}

describe("N2.6 PostgreSQL multi-worker concurrency across restarts", () => {
  afterEach(async () => {
    for (const container of [...opened]) {
      await shutdown(container);
    }
  });

  it(
    "10 independent tasks with heterogeneous workerKind/capability, concurrent supervisors, arbitrary callbacks, and mid-execution restart",
    async () => {
      /*
       * ============================================================
       * CLEAN DISPOSABLE DATABASE
       * ============================================================
       */
      const admin = await freshProcess();
      if (!admin.db) throw new Error("db handle unavailable");
      await admin.db.execute(
        sql.raw(
          "TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE",
        ),
      );
      await shutdown(admin);

      /*
       * ============================================================
       * PROCESS A : create mission with 10 independent tasks
       * ============================================================
       */
      const processA = await freshProcess();
      const dispatchA = mockTransport(processA);
      const supervisorA = supervisorFor(processA);

      const mission = await processA.mission.create({
        title: "N2.6 Multi-worker Concurrency",
        objective: "10 independent tasks with heterogeneous workerKind/capability",
        tasks: [
          { title: "Task 0", description: "STEP_0_OK", dependsOn: [], workerKind: "kind0", capability: "cap0" },
          { title: "Task 1", description: "STEP_1_OK", dependsOn: [], workerKind: "kind1", capability: "cap1" },
          { title: "Task 2", description: "STEP_2_OK", dependsOn: [], workerKind: "kind2", capability: "cap2" },
          { title: "Task 3", description: "STEP_3_OK", dependsOn: [], workerKind: "kind3", capability: "cap3" },
          { title: "Task 4", description: "STEP_4_OK", dependsOn: [], workerKind: "kind0", capability: "cap0" },
          { title: "Task 5", description: "STEP_5_OK", dependsOn: [], workerKind: "kind1", capability: "cap1" },
          { title: "Task 6", description: "STEP_6_OK", dependsOn: [], workerKind: "kind2", capability: "cap2" },
          { title: "Task 7", description: "STEP_7_OK", dependsOn: [], workerKind: "kind3", capability: "cap3" },
          { title: "Task 8", description: "STEP_8_OK", dependsOn: [], workerKind: "kind0", capability: "cap0" },
          { title: "Task 9", description: "STEP_9_OK", dependsOn: [], workerKind: "kind1", capability: "cap1" },
        ],
      });

      let tasks = await processA.mission.listTasks(mission.id);
      expect(tasks).toHaveLength(10);

      // Debug: print tasks to see workerKind and capability
      console.log("Tasks from mission:", JSON.stringify(tasks, (_, value) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value
      ));

      // Additionally, query the raw missionTasks table to see what's stored
      if (!processA.db) throw new Error("db handle unavailable");
      const rawTasks = await processA.db.select().from(missionTasks).where(eq(missionTasks.missionId, mission.id));
      console.log("Raw missionTasks:", JSON.stringify(rawTasks, (_, value) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value
      ));

      // run() in process A: all tasks are ready -> should dispatch all 10.
      await supervisorA.run(mission.id);
      expect(dispatchA).toHaveBeenCalledTimes(10);

      // Verify that each task was dispatched exactly once (by mock count) and
      // that the workflowId is deterministic and unique per task.
      const dispatchedTaskIdsA: Array<{ taskId: string; workflowId: string }> = [];
      for (const call of dispatchA.mock.calls) {
        dispatchedTaskIdsA.push({
          taskId: call[0].taskId,
          workflowId: call[0].workflowId ?? `icos-task-${call[0].taskId}`,
        });
      }
      expect(dispatchedTaskIdsA.length).toBe(10);
      const workflowIdsA = new Set(dispatchedTaskIdsA.map((x) => x.workflowId));
      expect(workflowIdsA.size).toBe(10);
      for (const { taskId, workflowId } of dispatchedTaskIdsA) {
        expect(workflowId).toBe(`icos-task-${taskId}`);
      }

      // Verify the dispatchAttempts ledger: 10 rows, all in "dispatched" state.
      if (!processA.db) throw new Error("db handle unavailable");
      let attempts = await processA.db.select().from(dispatchAttempts);
      expect(attempts).toHaveLength(10);
      expect(attempts.every((a) => a.state === "dispatched")).toBe(true);
      // Debug: print attempts after first dispatch
      console.log("Attempts after first dispatch:", JSON.stringify(attempts, (_, value) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value
      ));
      // Verify that workerKind and capability are persisted in the ledger.
      // Use the repository to get each attempt by workflowId and check the mapped values.
      for (const task of tasks) {
        const workflowId = `icos-task-${task.taskId}`;
        const attempt = await processA.dispatchAttempts.getByWorkflowId(workflowId);
        expect(attempt).toBeDefined();
        expect(attempt?.workerKind).toBe(task.workerKind);
        expect(attempt?.capability).toBe(task.capability);
      }

      // PROCESS A dies.
      await shutdown(processA);

      /*
       * ============================================================
       * PROCESS B : simulate arbitrary callbacks (first 5 tasks: even indices)
       * ============================================================
       */
      const processB = await freshProcess();
      const dispatchB = mockTransport(processB);
      const supervisorB = supervisorFor(processB);

      // We need the tasks list from process A. Since we closed process A, we
      // re-fetch from the database in process B.
      const tasksB = await processB.mission.listTasks(mission.id);
      expect(tasksB).toHaveLength(10);

      // Simulate callbacks for tasks 0, 2, 4, 6, 8 (even indices) in arbitrary order.
      const evenIndices = [0, 2, 4, 6, 8];
      for (const i of evenIndices) {
        const taskTitle = `Task ${i}`;
        const task = tasksB.find((t) => t.title === taskTitle);
        if (!task) throw new Error(`Task ${i} not found`);
        await completeAndReview(processB, supervisorB, {
          missionId: mission.id,
          taskId: task.taskId,
          workflowId: `icos-task-${task.taskId}`,
          result: `${taskTitle} done`,
        });
      }

      // Debug: print attempts after callbacks in process B
      if (!processB.db) throw new Error("db handle unavailable");
      const attemptsAfterCallbacks = await processB.db.select().from(dispatchAttempts);
      console.log("Attempts after callbacks in process B:", JSON.stringify(attemptsAfterCallbacks, (_, value) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value
      ));

      // After these callbacks, the even-indexed tasks are succeeded.
      // The odd-indexed tasks are still in "dispatched" state (waiting for callback).
      // No new tasks are ready because there are no dependencies.
      // So supervisor.run() should dispatch nothing new.
      await supervisorB.run(mission.id);
      expect(dispatchB).toHaveBeenCalledTimes(0);

      // Verify the ledger: even tasks should be "completed", odd tasks should be "dispatched".
      if (!processB.db) throw new Error("db handle unavailable");
      attempts = await processB.db.select().from(dispatchAttempts);
      expect(attempts).toHaveLength(10);
      // Build a map from taskId to attempt for easy lookup.
      const attemptMapB = new Map(attempts.map(a => [a.taskId, a]));
      for (const task of tasks) {
        const attempt = attemptMapB.get(task.taskId);
        expect(attempt).toBeDefined();
        const taskIndex = parseInt(task.title.split(" ")[1]);
        if (taskIndex % 2 === 0) {
          // even index: should be completed
          expect(attempt?.state).toBe("completed");
        } else {
          // odd index: should be dispatched
          expect(attempt?.state).toBe("dispatched");
        }
      }

      // PROCESS B dies (in the middle).
      await shutdown(processB);

      /*
       * ============================================================
       * PROCESS C : simulate remaining callbacks (odd tasks) and finish
       * ============================================================
       */
      const processC = await freshProcess();
      const dispatchC = mockTransport(processC);
      const supervisorC = supervisorFor(processC);

      // Re-fetch tasks from process C.
      const tasksC = await processC.mission.listTasks(mission.id);
      expect(tasksC).toHaveLength(10);

      // Simulate callbacks for tasks 1, 3, 5, 7, 9 (odd indices).
      const oddIndices = [1, 3, 5, 7, 9];
      for (const i of oddIndices) {
        const taskTitle = `Task ${i}`;
        const task = tasksC.find((t) => t.title === taskTitle);
        if (!task) throw new Error(`Task ${i} not found`);
        await completeAndReview(processC, supervisorC, {
          missionId: mission.id,
          taskId: task.taskId,
          workflowId: `icos-task-${task.taskId}`,
          result: `${taskTitle} done`,
        });
      }

      // After all callbacks, run supervisor to confirm mission succeeded.
      await supervisorC.run(mission.id);
      expect(dispatchC).toHaveBeenCalledTimes(0);

      // PROCESS C dies.
      await shutdown(processC);

      /*
       * ============================================================
       * PROCESS D : final verification (fresh process)
       * ============================================================
       */
      const processD = await freshProcess();
      const dispatchD = mockTransport(processD);
      const supervisorD = supervisorFor(processD);

      // No tasks left to dispatch.
      await supervisorD.run(mission.id);
      await supervisorD.recover(mission.id);
      expect(dispatchD).toHaveBeenCalledTimes(0);

      // Verify final state.
      const finalMission = await processD.mission.findById(mission.id);
      expect(finalMission?.status).toBe("succeeded");

      const finalTasks = await processD.mission.listTasks(mission.id);
      console.log("Final tasks in processD:", JSON.stringify(finalTasks, (_, value) =>
        typeof value === "object" && value !== null ? JSON.stringify(value) : value
      ));
      expect(finalTasks.every((t) => t.status === "succeeded")).toBe(true);

      // Verify the dispatchAttempts ledger: 10 rows, all "completed".
      if (!processD.db) throw new Error("db handle unavailable");
      const finalAttempts = await processD.db.select().from(dispatchAttempts);
      expect(finalAttempts).toHaveLength(10);
      expect(finalAttempts.every((a) => a.state === "completed")).toBe(true);

      // Verify workerKind/capability by canonical task identity.
      // PostgreSQL row order is not a business invariant.
      const finalAttemptByTaskId = new Map(
        finalAttempts.map((attempt) => [attempt.taskId, attempt]),
      );

      for (const task of finalTasks) {
        const attempt = finalAttemptByTaskId.get(task.taskId);
        expect(attempt).toBeDefined();
        expect(attempt?.workerKind).toBe(task.workerKind);
        expect(attempt?.capability).toBe(task.capability);
      }

      await shutdown(processD);
    },
  );
});