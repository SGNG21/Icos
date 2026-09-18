import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { ReviewerService } from "@/server/review/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";
import type { DurableMemory } from "@/server/repositories/ports";
import { WorkflowExecutionAlreadyStartedError, Client } from "@temporalio/client";

let container: Container;
let missionRepo: MissionRepository;
let taskRepo: TaskRepository;
let taskResultRepo: TaskExecutionResultRepository;
let reviewer: ReviewerService;
let reviewDecisionRepo: ReviewDecisionRepository;
let durableMemory: DurableMemory;

beforeEach(async () => {
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
});

afterEach(async () => {
  await container.close();
});

/**
 * Creates a mock Temporal client with exposed started/closed sets for test verification.
 * The returned object can be cast to Client for use with the dispatcher.
 */
function createMockTemporalClient() {
  const started = new Set<string>();
  const closed = new Set<string>();
  const clientObj = {
    started,
    closed,
    address: "localhost:7233",
    // Dummy properties to satisfy Client type
    options: {} as any,
    activity: {} as any,
    schedule: {} as any,
    nexus: {} as any,
    workflowService: {} as any,
    connection: {} as any,
    loadedDataConverter: {} as any,
    withDeadline: vi.fn().mockReturnThis(),
    workflow: {
      start: async (workflowType: string, opts: {
        taskQueue: string;
        workflowId: string;
        workflowIdReusePolicy: any;
        workflowIdConflictPolicy: any;
        args: any[];
      }) => {
        // Simulate REJECT_DUPLICATE and USE_EXISTING
        if (started.has(opts.workflowId) && !closed.has(opts.workflowId)) {
          throw new WorkflowExecutionAlreadyStartedError('Workflow already started', opts.workflowId, 'run0');
        }
        if (closed.has(opts.workflowId)) {
          return { workflowId: opts.workflowId };
        }
        started.add(opts.workflowId);
        return { workflowId: opts.workflowId };
      }
    } as any,
    // Helper to close a workflow (simulate completion)
    closeWorkflow(workflowId: string) {
      started.delete(workflowId);
      closed.add(workflowId);
    },
    // Helper to simulate an unexpected error
    async failStart() {
      throw new Error("Some other Temporal error");
    }
  };
  return clientObj;
}

/**
 * Creates a supervisor that uses a mocked Temporal dispatcher.
 * Returns an object with the supervisor, the mock client, and a cleanup function to restore the original taskExecutor.
 */
function createSupervisorWithMockTemporal() {
  const mockClient = createMockTemporalClient();
  const temporalDispatcher = new TemporalTaskExecutionDispatcher(
    "localhost:7233",
    "hello-world",
    "runIcosTask",
    true, // failClosed
    mockClient as unknown as Client
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
  return { supervisor, temporalDispatcher, mockClient, originalTaskExecution };
}

/**
 * Restores the original taskExecutor on the container.
 */
function restoreOriginalTaskExecutor(original: any) {
  container.taskExecution = original;
}

describe("N1 Integration Tests", () => {
  it("TEST 1: Supervisor → Temporal initial dispatch", async () => {
    const { supervisor, temporalDispatcher, mockClient, originalTaskExecution } = createSupervisorWithMockTemporal();
    try {
      // Create mission with a task
      const mission = await missionRepo.create({
        title: "Test Mission 1",
        objective: "Test initial dispatch",
        tasks: [
          {
            title: "Do something",
            description: "Some prompt",
            dependsOn: [],
            workerKind: "temporal-worker", // arbitrary; we replaced taskExecution so all go to temporal
            capability: undefined,
          },
        ],
      });
      expect(mission).not.toBeNull();
      const missionId = mission.id;

      // Get the task to know its taskId and canonical taskId (task.taskId)
      const tasks = await missionRepo.listTasks(missionId);
      expect(tasks).toHaveLength(1);
      const task = tasks[0];
      const taskId = task.id;
      const canonicalTaskId = task.taskId; // deterministic identifier

      // Initially task should be draft
      expect(task.status).toBe("draft");

      // Spy on temporal dispatcher dispatch to verify call
      const dispatchSpy = vi.spyOn(temporalDispatcher, "dispatch");

      // Run supervisor
      await supervisor.run(missionId);

      // Verify dispatcher called exactly once
      expect(dispatchSpy).toHaveBeenCalledTimes(1);
      const call = dispatchSpy.mock.calls[0][0];
      expect(call.taskId).toBe(taskId);
      // workflowId should be icos-task-${taskId} (since input.workflowId is undefined)
      expect(call.workflowId).toMatch(/^icos-task-/);

      // Verify external execution count: our mock client's started set should have that workflowId
      expect(mockClient.started.has(call.workflowId!)).toBe(true);
      // Not closed yet
      expect(mockClient.closed.has(call.workflowId!)).toBe(false);
    } finally {
      restoreOriginalTaskExecutor(originalTaskExecution);
    }
  });

  it("TEST 2: Restart before callback", async () => {
    // First container/supervisor
    const first = createSupervisorWithMockTemporal();
    const { supervisor: supervisorA, temporalDispatcher: dispatcherA, mockClient, originalTaskExecution: originalA } = first;
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
      const task = tasksA[0];
      const taskId = task.id;
      const canonicalTaskId = task.taskId;

      // First supervisor run -> dispatch
      const dispatchSpyA = vi.spyOn(dispatcherA, "dispatch");
      await supervisorA.run(missionId);
      expect(dispatchSpyA).toHaveBeenCalledTimes(1);
      const firstCall = dispatchSpyA.mock.calls[0][0];
      const workflowId = firstCall.workflowId;
      expect(workflowId).toMatch(/^icos-task-/);

      // Simulate process death: destroy supervisor A and dispatcher A (but keep repositories alive)
      restoreOriginalTaskExecutor(originalA);

      // Create fresh supervisor B with new dispatcher but same repositories
      const second = createSupervisorWithMockTemporal();
      const { supervisor: supervisorBFromFactory, temporalDispatcher: dispatcherBFromFactory, originalTaskExecution: originalBFromFactory } = second;
      // We need to share the same mock client state between A and B.
      // Instead of creating a new mock client, we will reuse the mock client from the first supervisor.
      const mockClientShared = mockClient; // from first
      const temporalDispatcherB = new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "hello-world",
        "runIcosTask",
        true,
        mockClientShared as unknown as Client
      );
      const originalTaskExecutionB = container.taskExecution; // this is the dispatcher from the second call
      container.taskExecution = temporalDispatcherB;
      // Now create a new supervisor with the new dispatcher
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

        // Verify that the workflowId considered is the same (we can check by looking at the task status? Not needed)
        // Verify external execution count still 1
        expect(mockClientShared.started.has(workflowId!)).toBe(true);
        expect(mockClientShared.closed.has(workflowId!)).toBe(false);
      } finally {
        restoreOriginalTaskExecutor(originalTaskExecutionB);
      }
    } finally {
      restoreOriginalTaskExecutor(originalA);
    }
  });
});