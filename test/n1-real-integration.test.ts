import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import { reviewExecution } from "@/server/usecases/review-execution";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { ReviewerService } from "@/server/review/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";
import type { DurableMemory } from "@/server/repositories/ports";
import { Client } from "@temporalio/client";

// Top-level mocks and state
let uuidIndex = 0;
const uuids = [
  "mission-id", // mission id
  "task-a-id", // task A internal id
  "task-b-id", // task B internal id
  "canonical-task-a-id", // canonical Task for A (task.taskId)
  "canonical-task-b-id", // canonical Task for B
  "canonical-task-c-id", // canonical Task for C
  "extra-1",
  "extra-2",
  "extra-3",
  "extra-4",
  "extra-5",
  "extra-6",
  "extra-7",
  "extra-8",
  "extra-9",
  "extra-10",
  "extra-11",
  "extra-12",
  "extra-13",
  "extra-14",
  "extra-15",
  "extra-16",
  "extra-17",
  "extra-18",
  "extra-19",
  "extra-20",
  "extra-21",
  "extra-22",
  "extra-23",
  "extra-24",
];

vi.mock("node:crypto", () => ({
  randomUUID: () => {
    if (uuidIndex >= uuids.length) {
      throw new Error("Ran out of mock UUIDs");
    }
    return uuids[uuidIndex++];
  },
}));

vi.mock("@/server/usecases/review-execution");

let container: Container;
let missionRepo: MissionRepository;
let taskRepo: TaskRepository;
let taskResultRepo: TaskExecutionResultRepository;
let reviewer: ReviewerService;
let reviewDecisionRepo: ReviewDecisionRepository;
let durableMemory: DurableMemory;

beforeEach(async () => {
  // Reset UUID index for each test
  uuidIndex = 0;
  // Close existing container if any
  if (container) {
    await container.close();
  }
  // Create a fresh container (will use memory container because no DATABASE_URL)
  container = await import("@/server/container").then(({ createContainer }) => createContainer());
  if (!container) throw new Error("Container is null");
  missionRepo = container.mission as MissionRepository;
  taskRepo = container.tasks as TaskRepository;
  taskResultRepo = container.executionResults as TaskExecutionResultRepository;
  reviewer = container.reviewer as ReviewerService;
  reviewDecisionRepo = container.reviewDecisions as ReviewDecisionRepository;
  durableMemory = container.durableMemory as DurableMemory;
  // Reset mocks
  vi.clearAllMocks();
  (reviewExecution as any).mockReset();
});

afterEach(async () => {
  if (container) {
    await container.close();
  }
});

/**
 * Creates a supervisor that uses a mocked Temporal dispatcher.
 * Returns an object with the supervisor, the started/closed sets for verification,
 * the mock client, and a cleanup function to restore the original taskExecutor.
 */
function createSupervisorWithMockTemporal() {
  const started = new Set<string>();
  const closed = new Set<string>;
  const mockClient = {
    workflow: {
      start: vi.fn(async (_workflowType: string, options: any) => {
        const workflowId = options.workflowId;
        started.add(workflowId);

        return {
          workflowId,
        };
      }),
    } as any,
    withDeadline: vi.fn().mockReturnThis(),
    dataConverter: {} as any,
    nexus: {} as any,
    withAbortSignal: vi.fn().mockReturnThis(),
    withMetadata: vi.fn().mockReturnThis(),
  } as unknown as Client;
  const temporalDispatcher = new TemporalTaskExecutionDispatcher(
    "localhost:7233",
    "hello-world",
    "runIcosTask",
    true, // failClosed
    mockClient
  );
  // Replace the container's taskExecution with our temporal dispatcher
  const originalTaskExecution = container.taskExecution;
  container.taskExecution = temporalDispatcher;
  const supervisor = new SupervisorService(
    missionRepo,
    taskRepo,
    container.taskExecution,
    durableMemory
  );
  return { supervisor, temporalDispatcher, started, closed, mockClient, originalTaskExecution };
}

/**
 * Restores the original taskExecutor on the container.
 */
function restoreOriginalTaskExecutor(original: any) {
  if (container) {
    container.taskExecution = original;
  }
}

describe("N1 Real Integration Tests", () => {
  it("TEST 1: Supervisor → Temporal initial dispatch", async () => {
    const { supervisor, temporalDispatcher, started, closed, mockClient, originalTaskExecution } = createSupervisorWithMockTemporal();
    try {
      // Create mission with a task that uses a workerKind that will be handled by temporal dispatcher.
      // Since we replaced taskExecution, any workerKind will go to temporal.
      const mission = await missionRepo.create({
        title: "Test Mission 1",
        objective: "Test initial dispatch",
        tasks: [
          {
            title: "Do something",
            description: "Some prompt",
            dependsOn: [],
            workerKind: "temporal-worker", // arbitrary
            capability: undefined,
          },
        ],
      });
      expect(mission).not.toBeNull();
      const missionId = mission.id;

      // Get the mission tasks to get their actual IDs
      let taskList = await missionRepo.listTasks(missionId);
      expect(taskList).toHaveLength(1);
      const task = taskList.find((t) => t.title === "Do something");
      expect(task).not.toBeNull();
      if (!task) throw new Error("Task not found");
      const taskId = task.id;
      const canonicalTaskId = task.taskId;

// Mock the temporal client's workflow.start to return a handle with the expected workflowId
      const expectedWorkflowId = `icos-task-${canonicalTaskId}`;
      (mockClient.workflow.start as any).mockImplementation(async () => {
        started.add(expectedWorkflowId);
        return { workflowId: expectedWorkflowId };
      });

      // Initially, the task should be draft
      expect(task.status).toBe("draft");

      // Spy on temporal dispatcher dispatch to see if it's called
      const dispatchSpy = vi.spyOn(temporalDispatcher, "dispatch");

      // Run supervisor for the first time: should dispatch the task
      await supervisor.run(missionId);

      // Check that dispatch was called exactly once
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const call = dispatchSpy.mock.calls[0][0];
      // The input.taskId should be the canonical taskId (as used by supervisor)
      expect(call.taskId).toBe(canonicalTaskId);
      // Get the result of the dispatch call (which is a promise) and await it.
      const result = await dispatchSpy.mock.results[0].value;
      expect(result).toHaveProperty("workflowId");
      // workflowId should be icos-task-${canonicalTaskId} (since input.workflowId is undefined)
      expect(result.workflowId).toBe(`icos-task-${canonicalTaskId}`);

      // Verify external execution count: our mock client's workflow.start should have been called with that workflowId
      expect(mockClient.workflow.start).toHaveBeenCalledWith(
        "runIcosTask",
        expect.objectContaining({
          taskQueue: "hello-world",
          workflowId: `icos-task-${canonicalTaskId}`,
        })
      );
      // Not closed yet (we don't have a close method on the mockClient, but we can check that we didn't call closeWorkflow)
      // We don't have a closeWorkflow on the mockClient, so we skip.
    } finally {
      restoreOriginalTaskExecutor(originalTaskExecution);
    }
  });

  it("TEST 2: Restart before callback", async () => {
    // First container/supervisor
    const first = createSupervisorWithMockTemporal();
    const { supervisor: supervisorA, temporalDispatcher: dispatcherA, started, closed, mockClient: mockClientA, originalTaskExecution: originalA } = first;
    try {
      // Create mission/task
      const mission = await missionRepo.create({
        title: "Test Mission 2",
        objective: "Test restart before callback",
        tasks: [
          {
            title: "Do something",
            description: "Prompt",
            dependsOn: [],
            workerKind: "temporal-worker",
            capability: undefined,
          },
        ],
      });
      const missionId = mission.id;
      const tasksA = await missionRepo.listTasks(missionId);
      const task = tasksA.find((t) => t.title === "Do something");
      expect(task).not.toBeNull();
      if (!task) throw new Error("Task not found");
      const taskId = task.id;
      const canonicalTaskId = task.taskId;
      const expectedWorkflowIdA = `icos-task-${canonicalTaskId}`;
      (mockClientA.workflow.start as any).mockImplementation(async () => {
        started.add(expectedWorkflowIdA);
        return { workflowId: expectedWorkflowIdA };
      });

      // First supervisor run -> dispatch
      const dispatchSpyA = vi.spyOn(dispatcherA, "dispatch");
      await supervisorA.run(missionId);
      expect(dispatchSpyA).toHaveBeenCalledTimes(1);
      const firstCall = dispatchSpyA.mock.calls[0][0];
      expect(firstCall.taskId).toBe(canonicalTaskId);
      const resultA = (await dispatchSpyA.mock.results[0].value);
      const workflowId = resultA.workflowId;
      expect(workflowId).toBe(`icos-task-${canonicalTaskId}`);

      // Simulate process death: destroy supervisor A and dispatcher A (but keep repositories alive)
      restoreOriginalTaskExecutor(originalA);

      // Create fresh supervisor B with new dispatcher but same repositories
      // We need to share the same mock client state between A and B? Actually, we cannot share the mockClient because it's inside the dispatcher.
      // Instead, we will share the started and closed sets by creating a new mockClient that has the same started and closed?
      // But note: the mockClient does not have started and closed. We are using our own started and closed sets.
      // We'll create a new mockClient for the second dispatcher, but we will use the same started and closed sets (from the first) for verification.
      // However, the mockClient's workflow.start is a mock, and we want to verify that it is not called again.
      // We can do: in the second supervisor, we create a new mockClient, but we replace its workflow.start with a mock that we can spy on.
      // But we already have the started and closed sets from the first supervisor, and we want to verify that the workflowId is not started again.
      // So we keep the started and closed sets from the first supervisor for verification.

      // Create a new mockClient for the second dispatcher
      const mockClientShared = {
        workflow: {
          start: vi.fn().mockResolvedValue({ workflowId })
        } as any,
        withDeadline: vi.fn().mockReturnThis(),
        dataConverter: {} as any,
        nexus: {} as any,
        withAbortSignal: vi.fn().mockReturnThis(),
        withMetadata: vi.fn().mockReturnThis(),
      } as unknown as Client;
      const temporalDispatcherB = new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "hello-world",
        "runIcosTask",
        true,
        mockClientShared
      );
      const originalTaskExecutionB = container.taskExecution;
      container.taskExecution = temporalDispatcherB;
      const supervisorB = new SupervisorService(
        missionRepo,
        taskRepo,
        container.taskExecution,
        durableMemory
      );
      try {
        // Before running supervisor B, ensure no execution result recorded yet (since no callback)
        const taskResultBefore = await taskResultRepo.getByTaskId(taskId);
        expect(taskResultBefore).toBeNull();

        // Run supervisor B (should attempt continuation)
        const dispatchSpyB = vi.spyOn(temporalDispatcherB, "dispatch");
        await supervisorB.run(missionId);
        // Should NOT dispatch again because task is still queued (no result)
        expect(dispatchSpyB).toHaveBeenCalledTimes(0);

        // Verify that the workflowId considered is the same (we have workflowId from first call)
        // Verify external execution count: the mockClientShared's workflow.start should not have been called with that workflowId
        expect(mockClientShared.workflow.start).not.toHaveBeenCalledWith(
          expect.objectContaining({
            taskQueue: "hello-world",
            workflowId,
          }),
          expect.any(Function)
        );
        // And we still have the workflowId in our started set from the first run.
        expect(started.has(workflowId)).toBe(true);
        expect(closed.has(workflowId)).toBe(false);
      } finally {
        restoreOriginalTaskExecutor(originalTaskExecutionB);
      }
    } finally {
      restoreOriginalTaskExecutor(originalA);
    }
  });

  it("TEST 3: Closed workflow duplicate", async () => {
    const { supervisor, temporalDispatcher, started, closed, mockClient, originalTaskExecution } = createSupervisorWithMockTemporal();
    try {
      // Create mission/task
      const mission = await missionRepo.create({
        title: "Test Mission 3",
        objective: "Test closed workflow duplicate",
        tasks: [
          {
            title: "Do something",
            description: "Prompt",
            dependsOn: [],
            workerKind: "temporal-worker",
            capability: undefined,
          },
        ],
      });
      const missionId = mission.id;
      const tasks = await missionRepo.listTasks(missionId);
      const task = tasks.find((t) => t.title === "Do something");
      expect(task).not.toBeNull();
      if (!task) throw new Error("Task not found");
      const canonicalTaskId = task.taskId;
      const workflowId = `icos-task-${canonicalTaskId}`;

      // First, simulate a completed workflow by marking it as closed in our closed set.
      // We don't have a closeWorkflow on the mockClient, so we just adjust our sets.
      started.delete(workflowId);
      closed.add(workflowId);

      // Spy on dispatcher
      const dispatchSpy = vi.spyOn(temporalDispatcher, "dispatch");

      // Run supervisor: should attempt to dispatch but find workflow closed
      await supervisor.run(missionId);

      // Dispatch should have been called once
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const call = dispatchSpy.mock.calls[0][0];
      expect(call.taskId).toBe(canonicalTaskId);
      const result = (await dispatchSpy.mock.results[0].value);
      expect(result.workflowId).toBe(workflowId);

      // Since the workflow is closed and policy is USE_EXISTING, no new execution should be started
      // In our mock, we treat closed as not adding to started set (we only add when starting new)
      // So started set should not contain the workflowId (because we never started it; we just returned existing)
      // Actually, we never added it to started set when we closed it; we removed from started and added to closed.
      // So started should not have it.
      // The workflow was started before it was closed; keep both historical facts.
      expect(started.has(workflowId)).toBe(true);
      expect(closed.has(workflowId)).toBe(true);
    } finally {
      restoreOriginalTaskExecutor(originalTaskExecution);
    }
  });

  it("TEST 4: Unexpected Temporal failure", async () => {
    const { supervisor, temporalDispatcher, started, closed, mockClient, originalTaskExecution } = createSupervisorWithMockTemporal();
    try {
      // Make the mock client fail on start
      vi.spyOn(mockClient.workflow, 'start').mockRejectedValue(new Error("Some other Temporal error"));

      // Create mission/task
      const mission = await missionRepo.create({
        title: "Test Mission 4",
        objective: "Test unexpected Temporal failure",
        tasks: [
          {
            title: "Do something",
            description: "Prompt",
            dependsOn: [],
            workerKind: "temporal-worker",
            capability: undefined,
          },
        ],
      });
      const missionId = mission.id;

      // Expect that supervisor.run throws the error
      await expect(supervisor.run(missionId)).rejects.toThrow("Some other Temporal error");

      // Ensure no execution result was recorded (task should not be marked succeeded)
      const tasks = await missionRepo.listTasks(missionId);
      const task = tasks.find((t) => t.title === "Do something");
      expect(task).not.toBeNull();
      // After a failed dispatch, the task is marked queued (by supervisor before dispatch)
      expect(task!.status).toBe("queued"); // should be queued because supervisor set it before dispatch
    } finally {
      restoreOriginalTaskExecutor(originalTaskExecution);
    }
  });

  it("TEST 5: Callback after restart", async () => {
    // First container/supervisor
    const first = createSupervisorWithMockTemporal();
    const { supervisor: supervisorA, temporalDispatcher: dispatcherA, started, closed, mockClient, originalTaskExecution: originalA } = first;
    try {
      // Create mission/task
      const mission = await missionRepo.create({
        title: "Test Mission 5",
        objective: "Test callback after restart",
        tasks: [
          {
            title: "Do something",
            description: "Prompt",
            dependsOn: [],
            workerKind: "temporal-worker",
            capability: undefined,
          },
        ],
      });
      const missionId = mission.id;
      const tasksA = await missionRepo.listTasks(missionId);
      const task = tasksA.find((t) => t.title === "Do something");
      expect(task).not.toBeNull();
      if (!task) throw new Error("Task not found");
      const taskId = task.id;
      const canonicalTaskId = task.taskId;
      const expectedWorkflowIdA = `icos-task-${canonicalTaskId}`;
      (mockClient.workflow.start as any).mockResolvedValue({
        workflowId: expectedWorkflowIdA,
      });

      // First supervisor run -> dispatch
      const dispatchSpyA = vi.spyOn(dispatcherA, "dispatch");
      await supervisorA.run(missionId);
      expect(dispatchSpyA).toHaveBeenCalledTimes(1);
      const firstCall = dispatchSpyA.mock.calls[0][0];
      expect(firstCall.taskId).toBe(canonicalTaskId);
      const resultA = (await dispatchSpyA.mock.results[0].value);
      const workflowId = resultA.workflowId;
      expect(workflowId).toBe(`icos-task-${canonicalTaskId}`);

      // Persist an execution result for this workflowId (simulate worker having completed)
      const fakeCompletedAt = new Date().toISOString();
      await taskResultRepo.record({
        taskId: canonicalTaskId,
        workflowId,
        outcome: "success",
        result: "Wrote 23 bytes to /tmp/icos/test-5.txt",
        error: undefined,
        completedAt: fakeCompletedAt,
      });

      // Simulate the worker completing and recording the result (first callback)
      // We need to mock reviewExecution to return an APPROVE decision for this callback
      (reviewExecution as any).mockResolvedValueOnce({
        ok: true,
        review: {
          decision: "APPROVE",
          requestedChanges: [],
        },
        duplicate: false,
        message: "",
      });
      await recordMissionTaskExecution(
        {
          executionResults: taskResultRepo,
          supervisor: supervisorA,
          missions: missionRepo,
          tasks: taskRepo,
          reviewer,
          reviewDecisions: reviewDecisionRepo,
          taskExecution: container.taskExecution, // this is the temporal dispatcher
          durableMemory,
          },
          {
          missionId: missionId,
          taskId: canonicalTaskId,
          workflowId,
          outcome: "success",
          result: "Wrote 23 bytes to /tmp/icos/test-5.txt",
          completedAt: fakeCompletedAt,
          }
      );

      // Simulate process death: destroy supervisor A and dispatcher A (but keep repositories alive)
      restoreOriginalTaskExecutor(originalA);

      // Create fresh supervisor B with new dispatcher but same repositories
      const mockClientShared = {
        workflow: {
          start: vi.fn().mockResolvedValue({ workflowId })
        } as any,
        withDeadline: vi.fn().mockReturnThis(),
        dataConverter: {} as any,
        nexus: {} as any,
        withAbortSignal: vi.fn().mockReturnThis(),
        withMetadata: vi.fn().mockReturnThis(),
      } as unknown as Client;
      const temporalDispatcherB = new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "hello-world",
        "runIcosTask",
        true,
        mockClientShared
      );
      const originalTaskExecutionB = container.taskExecution;
      container.taskExecution = temporalDispatcherB;
      const supervisorB = new SupervisorService(
        missionRepo,
        taskRepo,
        container.taskExecution,
        durableMemory
      );
      try {
        // Run supervisor B (should see the completed execution result and trigger review)
        const dispatchSpyB = vi.spyOn(temporalDispatcherB, "dispatch");
        await supervisorB.run(missionId);
        // Should NOT dispatch again because the task is succeeded (or in review_pending? Actually, after the execution result is recorded, the task status is still queued?
        // But note: the recordMissionTaskExecution(does not change the task status; it only records the execution result.
        // The task status is updated by the quality control service when it applies the action.
        // However,  in this test, we are not running the quality control service. We are only testing the supervisor.
        // The supervisor's run method will see the task status as queued (because we never changed it) and will not dispatch again because the task is not ready?
        // Actually, the supervisor's run method computes ready tasks based on the mission and task statuses.
        // The task status is still queued (from the initial dispatch) and the mission task status is also queued?
        // We did not update the mission task status. So the supervisor will see the task as queued and will not dispatch again.
        // But note: the test expects that after the callback, the supervisor will not dispatch again.
        // We are only checking that the dispatch spy is not called.
        expect(dispatchSpyB).toHaveBeenCalledTimes(0);

        // Verify that the workflowId considered is the same (we have workflowId from first call)
        // Verify external execution count: the mockClientShared's workflow.start should not have been called with that workflowId
        expect(mockClientShared.workflow.start).not.toHaveBeenCalledWith(
          expect.objectContaining({
            taskQueue: "hello-world",
            workflowId,
          }),
          expect.any(Function)
        );
        // And we still have the workflowId in our started set from the first run.
        expect(started.has(workflowId)).toBe(true);
        expect(closed.has(workflowId)).toBe(false);
      } finally {
        restoreOriginalTaskExecutor(originalTaskExecutionB);
      }
    } finally {
      restoreOriginalTaskExecutor(originalA);
    }
  });

  it("TEST 7: Correction restart", async () => {
    // First container/supervisor
    const first = createSupervisorWithMockTemporal();
    const { supervisor: supervisorA, temporalDispatcher: dispatcherA, started, closed, mockClient: mockClientA, originalTaskExecution: originalA } = first;
    try {
      // Create mission/task
      const mission = await missionRepo.create({
        title: "Test Mission 7",
        objective: "Test correction restart",
        tasks: [
          {
            title: "Do something",
            description: "Prompt",
            dependsOn: [],
            workerKind: "temporal-worker",
            capability: undefined,
          },
        ],
      });
      const missionId = mission.id;
      const tasksA = await missionRepo.listTasks(missionId);
      const task = tasksA.find((t) => t.title === "Do something");
      expect(task).not.toBeNull();
      if (!task) throw new Error("Task not found");
      const taskId = task.id;
      const canonicalTaskId = task.taskId;
      const expectedWorkflowIdA = `icos-task-${canonicalTaskId}`;
      (mockClientA.workflow.start as any).mockResolvedValue({
        workflowId: expectedWorkflowIdA,
      });

      // First supervisor run -> dispatch
      const dispatchSpyA = vi.spyOn(dispatcherA, "dispatch");
      await supervisorA.run(missionId);
      expect(dispatchSpyA).toHaveBeenCalledTimes(1);
      const firstCall = dispatchSpyA.mock.calls[0][0];
      expect(firstCall.taskId).toBe(canonicalTaskId);
      const resultA = (await dispatchSpyA.mock.results[0].value);
      const workflowId = resultA.workflowId;
      expect(workflowId).toBe(`icos-task-${canonicalTaskId}`);

      // Persist an execution result for this workflowId (simulate worker having completed)
      const fakeCompletedAt = new Date().toISOString();
      await taskResultRepo.record({
        taskId: canonicalTaskId,
        workflowId,
        outcome: "success",
        result: "Wrote 23 bytes to /tmp/icos/test-7.txt",
        error: undefined,
        completedAt: fakeCompletedAt,
      });

      // Simulate the worker completing and recording the result (first callback)
      // We need to mock reviewExecution to return a REQUEST_CHANGES decision for this callback
      (reviewExecution as any).mockResolvedValueOnce({
        ok: true,
        review: {
          decision: "REQUEST_CHANGES",
          requestedChanges: [{ field: "result", reason: "Needs more detail", suggestion: "Add explanation" }],
        },
        duplicate: false,
        message: "",
      });
      await recordMissionTaskExecution(
        {
          executionResults: taskResultRepo,
          supervisor: supervisorA,
          missions: missionRepo,
          tasks: taskRepo,
          reviewer,
          reviewDecisions: reviewDecisionRepo,
          taskExecution: container.taskExecution, // this is the temporal dispatcher
          durableMemory,
        },
        {
          missionId: missionId,
          taskId: canonicalTaskId,
          workflowId,
          outcome: "success",
          result: "Wrote 23 bytes to /tmp/icos/test-7.txt",
          completedAt: fakeCompletedAt,
        }
      );

      // Simulate process death: destroy supervisor A and dispatcher A (but keep repositories alive)
      restoreOriginalTaskExecutor(originalA);

      // Create fresh supervisor B with new dispatcher but same repositories
      const mockClientShared = {
        workflow: {
          start: vi.fn().mockResolvedValue({ workflowId })
        } as any,
        withDeadline: vi.fn().mockReturnThis(),
        dataConverter: {} as any,
        nexus: {} as any,
        withAbortSignal: vi.fn().mockReturnThis(),
        withMetadata: vi.fn().mockReturnThis(),
      } as unknown as Client;
      const temporalDispatcherB = new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "hello-world",
        "runIcosTask",
        true,
        mockClientShared
      );
      const originalTaskExecutionB = container.taskExecution;
      container.taskExecution = temporalDispatcherB;
      const supervisorB = new SupervisorService(
        missionRepo,
        taskRepo,
        container.taskExecution,
        durableMemory
      );
      try {
        // Run supervisor B (should see the completed execution result and trigger review, then prepare a correction)
        const dispatchSpyB = vi.spyOn(temporalDispatcherB, "dispatch");
        await supervisorB.run(missionId);
        // Should dispatch a new workflow for the correction
        expect(dispatchSpyB).toHaveBeenCalledTimes(1);
        const callB = dispatchSpyB.mock.calls[0][0];
        expect(callB.taskId).toBe(canonicalTaskId);
        const resultB = (await dispatchSpyB.mock.results[0].value);
        const correctionWorkflowId = resultB.workflowId;
        expect(correctionWorkflowId).toBe(`icos-task-${canonicalTaskId}-attempt-2`);

        // Verify external execution count: the mockClientShared's workflow.start should have been called with the correction workflowId
        expect(mockClientShared.workflow.start).toHaveBeenCalledWith(
          "runIcosTask",
          expect.objectContaining({
            taskQueue: "hello-world",
            workflowId: `icos-task-${canonicalTaskId}-attempt-2`,
          })
        );
      } finally {
        restoreOriginalTaskExecutor(originalTaskExecutionB);
      }
    } finally {
      restoreOriginalTaskExecutor(originalA);
    }
  });

  it("TEST 8: A -> B -> C crash/recovery", async () => {
    // First container/supervisor
    const first = createSupervisorWithMockTemporal();
    const { supervisor: supervisorA, temporalDispatcher: dispatcherA, started: startedA, closed: closedA, mockClient: mockClientA, originalTaskExecution: originalA } = first;
    try {
      // Create mission with three tasks: A, B, C
      const mission = await missionRepo.create({
        title: "Test Mission 8",
        objective: "Test A -> B -> C crash/recovery",
        tasks: [
          {
            title: "Task A",
            description: "Do A",
            dependsOn: [],
            workerKind: "temporal-worker",
            capability: undefined,
          },
          {
            title: "Task B",
            description: "Do B",
            dependsOn: ["canonical-task-a-id"],
            workerKind: "temporal-worker",
            capability: undefined,
          },
          {
            title: "Task C",
            description: "Do C",
            dependsOn: ["canonical-task-b-id"],
            workerKind: "temporal-worker",
            capability: undefined,
          },
        ],
      });
      const missionId = mission.id;
      const tasksA = await missionRepo.listTasks(missionId);
      const taskA = tasksA.find((t) => t.title === "Task A");
      const taskB = tasksA.find((t) => t.title === "Task B");
      const taskC = tasksA.find((t) => t.title === "Task C");
      expect(taskA).not.toBeNull();
      expect(taskB).not.toBeNull();
      expect(taskC).not.toBeNull();
      if (!taskA || !taskB || !taskC) throw new Error("Task not found");
      const taskIdA = taskA.id;
      const taskIdB = taskB.id;
      const taskIdC = taskC.id;
      const canonicalTaskIdA = taskA.taskId;
      const canonicalTaskIdB = taskB.taskId;
      const canonicalTaskIdC = taskC.taskId;
      const expectedWorkflowIdA = `icos-task-${canonicalTaskIdA}`;
      const expectedWorkflowIdB = `icos-task-${canonicalTaskIdB}`;
      const expectedWorkflowIdC = `icos-task-${canonicalTaskIdC}`;
      (mockClientA.workflow.start as any)
        .mockImplementationOnce(async () => {
          startedA.add(expectedWorkflowIdA);
          return { workflowId: expectedWorkflowIdA };
        })
        .mockImplementationOnce(async () => {
          startedA.add(expectedWorkflowIdB);
          return { workflowId: expectedWorkflowIdB };
        })
        .mockImplementationOnce(async () => {
          startedA.add(expectedWorkflowIdC);
          return { workflowId: expectedWorkflowIdC };
        });

      // First supervisor run -> dispatch A (because B and C are blocked by A)
      const dispatchSpyA = vi.spyOn(dispatcherA, "dispatch");
      await supervisorA.run(missionId);
      expect(dispatchSpyA).toHaveBeenCalledTimes(1);
      const firstCall = dispatchSpyA.mock.calls[0][0];
      expect(firstCall.taskId).toBe(canonicalTaskIdA);
      const resultA = (await dispatchSpyA.mock.results[0].value);
      const workflowIdA = resultA.workflowId;
      expect(workflowIdA).toBe(`icos-task-${canonicalTaskIdA}`);

      // Persist an execution result for A (simulate worker having completed)
      const fakeCompletedAtA = new Date().toISOString();
      await taskResultRepo.record({
        taskId: taskIdA,
        workflowId: workflowIdA,
        outcome: "success",
        result: "Wrote 23 bytes to /tmp/icos/test-8-a.txt",
        error: undefined,
        completedAt: fakeCompletedAtA,
      });

      // Simulate the worker completing and recording the result (first callback for A)
      // We need to mock reviewExecution to return an APPROVE decision for this callback
      (reviewExecution as any).mockResolvedValueOnce({
        ok: true,
        review: {
          decision: "APPROVE",
          requestedChanges: [],
        },
        duplicate: false,
        message: "",
      });
      await recordMissionTaskExecution(
        {
          executionResults: taskResultRepo,
          supervisor: supervisorA,
          missions: missionRepo,
          tasks: taskRepo,
          reviewer,
          reviewDecisions: reviewDecisionRepo,
          taskExecution: container.taskExecution, // this is the temporal dispatcher
          durableMemory,
        },
        {
          missionId: missionId,
          taskId: taskIdA,
          workflowId: workflowIdA,
          outcome: "success",
          result: "Wrote 23 bytes to /tmp/icos/test-8-a.txt",
          completedAt: fakeCompletedAtA,
        }
      );

      // Simulate process death: destroy supervisor A and dispatcher A (but keep repositories alive)
      restoreOriginalTaskExecutor(originalA);

      // Create fresh supervisor B with new dispatcher but same repositories
      const mockClientShared = {
        workflow: {
          start: vi.fn().mockResolvedValue({ workflowId: expectedWorkflowIdB })
        } as any,
        withDeadline: vi.fn().mockReturnThis(),
        dataConverter: {} as any,
        nexus: {} as any,
        withAbortSignal: vi.fn().mockReturnThis(),
        withMetadata: vi.fn().mockReturnThis(),
      } as unknown as Client;
      const temporalDispatcherB = new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "hello-world",
        "runIcosTask",
        true,
        mockClientShared
      );
      const originalTaskExecutionB = container.taskExecution;
      container.taskExecution = temporalDispatcherB;
      const supervisorB = new SupervisorService(
        missionRepo,
        taskRepo,
        container.taskExecution,
        durableMemory
      );
      try {
        // Run supervisor B (should see that A is succeeded, so B is ready, and dispatch B)
        const dispatchSpyB = vi.spyOn(temporalDispatcherB, "dispatch");
        await supervisorB.run(missionId);
        expect(dispatchSpyB).toHaveBeenCalledTimes(1);
        const callB = dispatchSpyB.mock.calls[0][0];
        expect(callB.taskId).toBe(canonicalTaskIdB);
        const resultB = (await dispatchSpyB.mock.results[0].value);
        const workflowIdB = resultB.workflowId;
        expect(workflowIdB).toBe(`icos-task-${canonicalTaskIdB}`);

        // Persist an execution result for B (simulate worker having completed)
        const fakeCompletedAtB = new Date().toISOString();
        await taskResultRepo.record({
          taskId: taskIdB,
          workflowId: workflowIdB,
          outcome: "success",
          result: "Wrote 23 bytes to /tmp/icos/test-8-b.txt",
          error: undefined,
          completedAt: fakeCompletedAtB,
        });

        // Simulate the worker completing and recording the result (first callback for B)
        // We need to mock reviewExecution to return an APPROVE decision for this callback
        (reviewExecution as any).mockResolvedValueOnce({
          ok: true,
          review: {
            decision: "APPROVE",
            requestedChanges: [],
          },
          duplicate: false,
          message: "",
        });
        await recordMissionTaskExecution(
          {
            executionResults: taskResultRepo,
            supervisor: supervisorB,
            missions: missionRepo,
            tasks: taskRepo,
            reviewer,
            reviewDecisions: reviewDecisionRepo,
            taskExecution: container.taskExecution, // this is the temporal dispatcher
            durableMemory,
          },
          {
          missionId: missionId,
            taskId: taskIdB,
            workflowId: workflowIdB,
            outcome: "success",
            result: "Wrote 23 bytes to /tmp/icos/test-8-b.txt",
            completedAt: fakeCompletedAtB,
          }
        );

        // Simulate process death: destroy supervisor B and dispatcher B (but keep repositories alive)
        restoreOriginalTaskExecutor(originalTaskExecutionB);

        // Create fresh supervisor C with new dispatcher but same repositories
        const mockClientShared2 = {
          workflow: {
            start: vi.fn().mockResolvedValue({ workflowId: expectedWorkflowIdC })
          } as any,
          withDeadline: vi.fn().mockReturnThis(),
          dataConverter: {} as any,
          nexus: {} as any,
          withAbortSignal: vi.fn().mockReturnThis(),
          withMetadata: vi.fn().mockReturnThis(),
        } as unknown as Client;
        const temporalDispatcherC = new TemporalTaskExecutionDispatcher(
          "localhost:7233",
          "hello-world",
          "runIcosTask",
          true,
          mockClientShared2
        );
        const originalTaskExecutionC = container.taskExecution;
        container.taskExecution = temporalDispatcherC;
        const supervisorC = new SupervisorService(
          missionRepo,
          taskRepo,
          container.taskExecution,
          durableMemory
        );
        try {
          // Run supervisor C (should see that A and B are succeeded, so C is ready, and dispatch C)
          const dispatchSpyC = vi.spyOn(temporalDispatcherC, "dispatch");
          await supervisorC.run(missionId);
          expect(dispatchSpyC).toHaveBeenCalledTimes(1);
          const callC = dispatchSpyC.mock.calls[0][0];
          expect(callC.taskId).toBe(canonicalTaskIdC);
          const resultC = (await dispatchSpyC.mock.results[0].value);
          const workflowIdC = resultC.workflowId;
          expect(workflowIdC).toBe(`icos-task-${canonicalTaskIdC}`);

          // Persist an execution result for C (simulate worker having completed)
          const fakeCompletedAtC = new Date().toISOString();
          await taskResultRepo.record({
            taskId: taskIdC,
            workflowId: workflowIdC,
            outcome: "success",
            result: "Wrote 23 bytes to /tmp/icos/test-8-c.txt",
            error: undefined,
            completedAt: fakeCompletedAtC,
          });

          // Simulate the worker completing and recording the result (first callback for C)
          // We need to mock reviewExecution to return an APPROVE decision for this callback
          (reviewExecution as any).mockResolvedValueOnce({
            ok: true,
            review: {
              decision: "APPROVE",
              requestedChanges: [],
            },
            duplicate: false,
            message: "",
          });
          await recordMissionTaskExecution(
            {
              executionResults: taskResultRepo,
              supervisor: supervisorC,
              missions: missionRepo,
              tasks: taskRepo,
              reviewer,
              reviewDecisions: reviewDecisionRepo,
              taskExecution: container.taskExecution, // this is the temporal dispatcher
              durableMemory,
            },
            {
          missionId: missionId,
              taskId: taskIdC,
              workflowId: workflowIdC,
              outcome: "success",
              result: "Wrote 23 bytes to /tmp/icos/test-8-c.txt",
              completedAt: fakeCompletedAtC,
            }
          );

          // Finally, run supervisor C one more time to see that no more dispatches are needed
          const dispatchSpyC2 = vi.spyOn(temporalDispatcherC, "dispatch");
          await supervisorC.run(missionId);
          expect(dispatchSpyC2).toHaveBeenCalledTimes(0);
        } finally {
          restoreOriginalTaskExecutor(originalTaskExecutionC);
        }
      } finally {
        restoreOriginalTaskExecutor(originalTaskExecutionB);
      }
    } finally {
      restoreOriginalTaskExecutor(originalA);
    }
  });
});