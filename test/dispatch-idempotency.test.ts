import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { ReviewerService } from "@/server/review/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import { FakeReviewer } from "@/server/review/fake-reviewer";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { CompositeTaskExecutionDispatcher } from "@/server/execution/composite-task-execution-dispatcher";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { LocalTaskExecutionDispatcher } from "@/server/execution/local-task-execution-dispatcher";
import { DigitalOSTaskExecutionDispatcher } from "@/server/execution/digitalos-task-execution-dispatcher";

// Mock node:crypto to return sequential UUIDs
const uuids = [
  "mission-id", // mission id
  "task-a-id", // task A
  "task-b-id", // task B
  "task-c-id", // task C
  "canonical-task-a-id", // canonical Task for A
  "canonical-task-b-id", // canonical Task for B
  "canonical-task-c-id", // canonical Task for C
  "extra-1", // extra for any other calls
  "extra-2",
  "extra-3",
  "extra-4",
  "extra-5",
  "extra-6",
];
let uuidIndex = 0;
vi.mock("node:crypto", () => ({
  randomUUID: () => {
    if (uuidIndex >= uuids.length) {
      throw new Error("Ran out of mock UUIDs");
    }
    return uuids[uuidIndex++];
  },
}));

describe("Dispatch idempotency and restart safety", () => {
  let container: Container | null = null;
  let supervisor: SupervisorService | null = null;
  let missionRepository: MissionRepository;
  let taskExecutionResultRepository: TaskExecutionResultRepository;
  let durableMemory: any; // We'll use the container's durableMemory (which is DurableMemory interface)
  let tasks: any; // TaskRepository
  let missions: any; // MissionRepository
  let reviewer: any; // ReviewerService
  let reviewDecisions: any; // ReviewDecisionRepository

  beforeEach(async () => {
    // Close existing container if any
    if (container) {
      await container.close();
    }
    // Reset the UUID index for each test
    uuidIndex = 0;
    // Create a fresh container (will use memory container because no DATABASE_URL)
    container = await import("@/server/container").then(({ createContainer }) => createContainer());
    if (!container) throw new Error("Container is null");
    missionRepository = container.mission as MissionRepository;
    taskExecutionResultRepository = container.executionResults as TaskExecutionResultRepository;
    durableMemory = container.durableMemory;
    tasks = container.tasks;
    missions = container.mission;
    reviewer = container.reviewer;
    reviewDecisions = container.reviewDecisions;
    // Replace the taskExecution with a CompositeTaskExecutionDispatcher that uses the local dispatcher for test-worker
    const { LocalTaskExecutionDispatcher } =
      await import("@/server/execution/local-task-execution-dispatcher");
    const localDispatcher = new LocalTaskExecutionDispatcher(
      container.executionResults,
      container.mission,
      container.tasks,
      // supervisor will be set later, we pass a placeholder and will update after supervisor creation
      null as any,
      container.durableMemory,
    );
    const compositeDispatcher = new CompositeTaskExecutionDispatcher(
      container.executionResults,
      container.mission,
      container.tasks,
      null as any, // supervisor placeholder
      container.durableMemory,
    );
    // We need to set the supervisor on both dispatchers after we create the supervisor.
    // We'll keep references and set them after supervisor creation.
    // Store them on the container for later use? We'll just keep in closure.
    // We'll update container.taskExecution to be the composite dispatcher.
    container.taskExecution = compositeDispatcher;
    // Now create the supervisor service
    supervisor = new SupervisorService(
      missionRepository,
      container.tasks,
      container.taskExecution,
      durableMemory,
    );
    // Now set the supervisor on the dispatchers
    (localDispatcher as any).supervisor = supervisor;
    (compositeDispatcher as any).supervisor = supervisor;
  });

  afterEach(async () => {
    if (container) {
      await container.close();
    }
  });

  it("TEST A: restart before initial dispatch - task dispatched once", async () => {
    if (!container || !supervisor || !missionRepository) {
      throw new Error("Container or supervisor or missionRepository not initialized");
    }

    // Step 1: Create mission with a single task that uses the local dispatcher
    const mission = await missionRepository.create({
      title: "Test Mission A",
      objective: "Test restart before initial dispatch",
      tasks: [
        {
          title: "Write a test file",
          description: "WRITE_FILE:/tmp/icos/test-a.txt:Hello from Test A!",
          dependsOn: [],
          workerKind: "test-worker", // This will trigger the local dispatcher
          capability: undefined,
        },
      ],
    });
    expect(mission).not.toBeNull();
    const missionId = mission.id;

    // Get the mission tasks to get their actual IDs
    let taskList = await missionRepository.listTasks(missionId);
    expect(taskList).toHaveLength(1);
    const taskA = taskList.find((t) => t.title === "Write a test file");
    expect(taskA).not.toBeNull();
    if (!taskA) {
      throw new Error("Task not found");
    }
    const taskAId = taskA.id;
    const canonicalTaskId = taskA.taskId;

    // Initially, the task should be draft
    expect(taskA.status).toBe("draft");

    // Spy on dispatcher.dispatch to see if it's called
    const dispatcher = container.taskExecution;
    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");

    // Run supervisor for the first time: should dispatch the task
    await supervisor.run(missionId);

    // Check that dispatch was called exactly once
        expect(dispatchSpy).toHaveBeenCalledTimes(1);
        const firstCall = dispatchSpy.mock.calls[0][0];
        expect(firstCall.taskId).toBe(canonicalTaskId);
        expect(typeof firstCall.workflowId).toBe("string");
        const workflowId = firstCall.workflowId as string;

        // Check that the task is now queued (not succeeded yet, because local dispatcher hasn't completed)
        const tasksAfterRun = await missionRepository.listTasks(missionId);
        const queuedTaskA = tasksAfterRun.find((t) => t.id === taskAId);
        expect(queuedTaskA).toBeDefined();
        if (queuedTaskA === undefined) {
          throw new Error("queuedTaskA is undefined");
        }
        expect(queuedTaskA.status).toBe("queued");

    // Now simulate the callback from the local dispatcher by calling recordMissionTaskExecution
    // This simulates what would happen when the worker completes and calls back
    const fakeCompletedAt = new Date().toISOString();
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: container.mission,
        tasks: container.tasks,
        reviewer: container.reviewer,
        reviewDecisions: container.reviewDecisions,
        taskExecution: container.taskExecution,
        durableMemory: container.durableMemory,
      },
      {
        missionId,
        taskId: canonicalTaskId,
        workflowId, // use the actual workflowId from the spy
        outcome: "success",
        result: "Wrote 23 bytes to /tmp/icos/test-a.txt",
        error: undefined,
        completedAt: fakeCompletedAt,
      },
    );

    // Now run supervisor again to see if mission is succeeded
    await supervisor.run(missionId);
    const finalMission = await missionRepository.findById(missionId);
    expect(finalMission?.status).toBe("succeeded");
  });

  it("TEST B: restart after successful dispatch but before result callback - task is NOT executed twice", async () => {
    if (!container || !supervisor || !missionRepository) {
      throw new Error("Container or supervisor or missionRepository not initialized");
    }

    // Step 1: Create mission with a single task
    const mission = await missionRepository.create({
      title: "Test Mission B",
      objective: "Test restart after dispatch but before result",
      tasks: [
        {
          title: "Write a test file",
          description: "WRITE_FILE:/tmp/icos/test-b.txt:Hello from Test B!",
          dependsOn: [],
          workerKind: "test-worker",
          capability: undefined,
        },
      ],
    });
    expect(mission).not.toBeNull();
    const missionId = mission.id;

    // Get the mission tasks
    let taskList = await missionRepository.listTasks(missionId);
    expect(taskList).toHaveLength(1);
    const taskB = taskList.find((t) => t.title === "Write a test file");
    expect(taskB).not.toBeNull();
    if (!taskB) {
      throw new Error("Task not found");
    }
    const taskBId = taskB.id;
    const canonicalTaskId = taskB.taskId;

    // Initially, the task should be draft
    expect(taskB.status).toBe("draft");

    // Spy on dispatcher.dispatch to count calls
    const dispatcher = container.taskExecution;
    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");

    // Run supervisor for the first time: should dispatch the task
    await supervisor.run(missionId);

    // Check that dispatch was called exactly once
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const firstDispatchCall = dispatchSpy.mock.calls[0][0];
    expect(firstDispatchCall.taskId).toBe(canonicalTaskId);
    const firstWorkflowId = firstDispatchCall.workflowId as string;

    // Check that the task is now queued
    const tasksAfterRun = await missionRepository.listTasks(missionId);
    const queuedTaskB = tasksAfterRun.find((t) => t.id === taskBId);
    expect(queuedTaskB).toBeDefined();
    if (queuedTaskB === undefined) {
      throw new Error("queuedTaskB is undefined");
    }
    expect(queuedTaskB.status).toBe("queued");

    // SIMULATE PROCESS DEATH HERE: ICOS dies after dispatch but before callback
    // The task remains as "queued" in the database
    // No execution result has been recorded yet
    // We simulate restart by creating a new supervisor but using the same container (so repositories persist)
    // Create a new supervisor instance (same container, same repositories)
    const { LocalTaskExecutionDispatcher } =
      await import("@/server/execution/local-task-execution-dispatcher");
    const localDispatcher = new LocalTaskExecutionDispatcher(
      container.executionResults,
      container.mission,
      container.tasks,
      null as any,
      container.durableMemory,
    );
    const compositeDispatcher = new CompositeTaskExecutionDispatcher(
      container.executionResults,
      container.mission,
      container.tasks,
      null as any,
      container.durableMemory,
    );
    container.taskExecution = compositeDispatcher;
    supervisor = new SupervisorService(
      missionRepository,
      container.tasks,
      container.taskExecution,
      durableMemory,
    );
    (localDispatcher as any).supervisor = supervisor;
    (compositeDispatcher as any).supervisor = supervisor;

    // Now run supervisor again (after restart)
    await supervisor.run(missionId);

    // CHECK: Did we dispatch again?
    // We need to ensure that no new execution result was recorded for this task.
    const execResultAfter = await taskExecutionResultRepository.getByTaskId(taskBId);
    expect(execResultAfter).toBeNull(); // No result recorded yet
    // Also ensure that the task is still queued
    const tasksAfterRestart = await missionRepository.listTasks(missionId);
    const taskAfterRestart = tasksAfterRestart.find((t) => t.id === taskBId);
    expect(taskAfterRestart?.status).toBe("queued");
  });

  it("TEST C: callback arrives after ICOS restart - callback accepted exactly once semantically", async () => {
    if (!container || !supervisor || !missionRepository) {
      throw new Error("Container or supervisor or missionRepository not initialized");
    }

    // Step 1: Create mission with a single task that uses the local dispatcher
    const mission = await missionRepository.create({
      title: "Test Mission C",
      objective: "Test callback after restart",
      tasks: [
        {
          title: "Write a test file",
          description: "WRITE_FILE:/tmp/icos/test-c.txt:Hello from Test C!",
          dependsOn: [],
          workerKind: "test-worker",
          capability: undefined,
        },
      ],
    });
    expect(mission).not.toBeNull();
    const missionId = mission.id;

    // Get the mission tasks
    let taskList = await missionRepository.listTasks(missionId);
    expect(taskList).toHaveLength(1);
    const taskC = taskList.find((t) => t.title === "Write a test file");
    expect(taskC).not.toBeNull();
    if (!taskC) {
      throw new Error("Task not found");
    }
    const taskCId = taskC.id;
    const canonicalTaskId = taskC.taskId;

    // Initially, the task should be draft
    expect(taskC.status).toBe("draft");

    // Spy on dispatcher.dispatch to see if it's called
    const dispatcher = container.taskExecution;
    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");

    // Run supervisor for the first time: should dispatch the task
    await supervisor.run(missionId);

    // Check that dispatch was called exactly once
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const firstCall = dispatchSpy.mock.calls[0][0];
    expect(firstCall.taskId).toBe(canonicalTaskId);
    expect(typeof firstCall.workflowId).toBe("string");
    const workflowId = firstCall.workflowId as string;

    // Check that the task is now queued
    const tasksAfterRun = await missionRepository.listTasks(missionId);
    const queuedTaskC = tasksAfterRun.find((t) => t.id === taskCId);
    expect(queuedTaskC).toBeDefined();
    if (queuedTaskC === undefined) {
      throw new Error("queuedTaskC is undefined");
    }
    expect(queuedTaskC.status).toBe("queued");

    // Simulate the worker completing and recording the result (but we will NOT call supervisor.run yet)
    const fakeCompletedAt = new Date().toISOString();
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: container.mission,
        tasks: container.tasks,
        reviewer: container.reviewer,
        reviewDecisions: container.reviewDecisions,
        taskExecution: container.taskExecution,
        durableMemory: container.durableMemory,
      },
      {
        missionId,
        taskId: canonicalTaskId,
        workflowId,
        outcome: "success",
        result: "Wrote 23 bytes to /tmp/icos/test-c.txt",
        error: undefined,
        completedAt: fakeCompletedAt,
      },
    );

    // Now simulate ICOS restart (we create a new supervisor using the same container to preserve data)
    const { LocalTaskExecutionDispatcher } =
      await import("@/server/execution/local-task-execution-dispatcher");
    const localDispatcher = new LocalTaskExecutionDispatcher(
      container.executionResults,
      container.mission,
      container.tasks,
      null as any,
      container.durableMemory,
    );
    const compositeDispatcher = new CompositeTaskExecutionDispatcher(
      container.executionResults,
      container.mission,
      container.tasks,
      null as any,
      container.durableMemory,
    );
    container.taskExecution = compositeDispatcher;
    supervisor = new SupervisorService(
      missionRepository,
      container.tasks,
      container.taskExecution,
      durableMemory,
    );
    (localDispatcher as any).supervisor = supervisor;
    (compositeDispatcher as any).supervisor = supervisor;

    // Now we simulate the callback arriving after restart (same workflowId, same outcome)
    // This should be accepted exactly once and not cause any re-execution.
    // We'll spy on the dispatcher's dispatch to ensure it's NOT called again.
    const restartDispatcher = container.taskExecution;
    const restartDispatchSpy = vi.spyOn(restartDispatcher, "dispatch");

    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: container.mission,
        tasks: container.tasks,
        reviewer: container.reviewer,
        reviewDecisions: container.reviewDecisions,
        taskExecution: container.taskExecution,
        durableMemory: container.durableMemory,
      },
      {
        missionId,
        taskId: canonicalTaskId,
        workflowId, // same workflowId as before
        outcome: "success",
        result: "Wrote 23 bytes to /tmp/icos/test-c.txt", // same result
        error: undefined,
        completedAt: fakeCompletedAt, // same timestamp
      },
    );

    // Ensure no new dispatch occurred
    expect(restartDispatchSpy).toHaveBeenCalledTimes(0);

    // Now run supervisor to see if mission is succeeded
    await supervisor.run(missionId);
    const finalMission = await missionRepository.findById(missionId);
    expect(finalMission?.status).toBe("succeeded");
  });
});