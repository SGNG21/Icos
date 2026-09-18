import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { ReviewerService } from "@/server/review/ports";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { FakeReviewer } from "@/server/review/fake-reviewer";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
// We need to cast to InMemoryMissionRepository to update dependsOn
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import type { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";

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
  "extra-7",
  "extra-8",
  "extra-9",
  "extra-10",
  "extra-11",
  "extra-12",
  "extra-13",
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

describe("E2E failure scenario", () => {
  let container: Container;
  let supervisor: SupervisorService;
  let missionRepository: MissionRepository;
  let taskExecutionResultRepository: TaskExecutionResultRepository;
  let durableMemory: PostgresDurableMemory;
  let reviewer: ReviewerService;

  beforeEach(async () => {
    // Close existing container if any
    if (container) {
      await container.close();
    }
    // Reset the UUID index for each test
    uuidIndex = 0;
    // Create a fresh container
    container = await import("@/server/container").then(({ createContainer }) => createContainer());
    if (!container) throw new Error("Container is null");

    missionRepository = container.mission as MissionRepository;
    taskExecutionResultRepository = container.executionResults as TaskExecutionResultRepository;
    reviewer = new ReviewerServiceImpl(
      new FakeReviewer(),
      new DeterministicReviewer(),
      container.reviewDecisions,
    );

    // Get the dispatcher and mock its dispatch method to return a deterministic workflowId
    const dispatcher = container.taskExecution;
    vi.spyOn(dispatcher, "dispatch").mockImplementation((input) => {
      return Promise.resolve({ workflowId: `icos-task-${input.taskId}` });
    });

    // Mock the durableMemory (PostgresDurableMemory) that the SupervisorService now expects
    durableMemory = {
      db: {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      } as any,
      getCheckpoints: vi.fn().mockResolvedValue([]),
      saveCheckpoint: vi.fn().mockResolvedValue(undefined),
      getLatestCheckpoint: vi.fn().mockResolvedValue(null),
      getCheckpointById: vi.fn().mockResolvedValue(null),
      saveDecision: vi.fn().mockResolvedValue(undefined),
      getDecisions: vi.fn().mockResolvedValue([]),
      saveExecutionResult: vi.fn().mockResolvedValue(undefined),
      getExecutionResults: vi.fn().mockResolvedValue([]),
      savePattern: vi.fn().mockResolvedValue(undefined),
      getPatterns: vi.fn().mockResolvedValue([]),
      saveContextItem: vi.fn().mockResolvedValue(undefined),
      queryContextItems: vi.fn().mockResolvedValue([]),
      saveHandoffPackage: vi.fn().mockResolvedValue(undefined),
      getHandoffPackage: vi.fn().mockResolvedValue(null),
      cleanup: vi.fn().mockResolvedValue(0),
    } as any;

    supervisor = new SupervisorService(
      missionRepository,
      container.tasks,
      dispatcher,
      durableMemory,
    );
  });

  afterEach(async () => {
    if (container) {
      await container.close();
    }
  });

  it("should handle failure in B and prevent C from being dispatched", async () => {
    // Step 1: Create mission with tasks A, B, C (initially with empty dependsOn)
    const mission = await missionRepository.create({
      title: "E2E Failure Test Mission",
      objective: "Test supervisor handles failure correctly",
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

    const missionId = mission.id;

    // Get the mission tasks (as MissionTask objects) to get both mission task ID and internal task ID
    let missionTasks = await missionRepository.listTasks(missionId);
    expect(missionTasks).toHaveLength(3);

    const missionTaskA = missionTasks.find(t => t.title === "Task A")!;
    const missionTaskB = missionTasks.find(t => t.title === "Task B")!;
    const missionTaskC = missionTasks.find(t => t.title === "Task C")!;

    expect(missionTaskA).not.toBeNull();
    expect(missionTaskB).not.toBeNull();
    expect(missionTaskC).not.toBeNull();

    const missionTaskIdA = missionTaskA.id;
    const missionTaskIdB = missionTaskB.id;
    const missionTaskIdC = missionTaskC.id;

    const internalTaskIdA = missionTaskA.taskId;
    const internalTaskIdB = missionTaskB.taskId;
    const internalTaskIdC = missionTaskC.taskId;

    // Update the dependsOn for mission tasks B and C (using mission task IDs)
    const missionRepo = missionRepository as InMemoryMissionRepository;
    await missionRepo.updateMissionTaskDependsOn(missionTaskIdB, [missionTaskIdA]);
    await missionRepo.updateMissionTaskDependsOn(missionTaskIdC, [missionTaskIdB]);

    // Verify the dependencies are set correctly (on the mission tasks)
    missionTasks = await missionRepo.listTasks(missionId);
    expect(missionTasks).toHaveLength(3);
    const updatedMissionTaskB = missionTasks.find(t => t.title === "Task B")!;
    const updatedMissionTaskC = missionTasks.find(t => t.title === "Task C")!;
    expect(updatedMissionTaskB?.dependsOn).toEqual([missionTaskIdA]);
    expect(updatedMissionTaskC?.dependsOn).toEqual([missionTaskIdB]);

    // Initially, all tasks should be draft (status of mission tasks)
    expect(updatedMissionTaskB?.status).toBe("draft");
    expect(updatedMissionTaskC?.status).toBe("draft");

    // Run supervisor for the first time: should dispatch A only
    await supervisor.run(missionId);

    // Check that dispatcher.dispatch was called once for task A
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(1);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        taskId: internalTaskIdA, // internal task ID
        taskTitle: missionTaskA.title,
        prompt: missionTaskA.description || missionTaskA.title,
        workerKind: missionTaskA.workerKind || undefined,
        capability: missionTaskA.capability || undefined,
      }),
    );

    // After running supervisor, task A should be queued
    const updatedTasksAfterRun1 = await missionRepository.listTasks(missionId);
    const queuedTaskA = updatedTasksAfterRun1.find(t => t.id === missionTaskIdA)!;
    const queuedTaskB = updatedTasksAfterRun1.find(t => t.id === missionTaskIdB)!;
    const queuedTaskC = updatedTasksAfterRun1.find(t => t.id === missionTaskIdC)!;

    expect(queuedTaskA?.status).toBe("queued");
    expect(queuedTaskB?.status).toBe("draft"); // B should not be queued yet
    expect(queuedTaskC?.status).toBe("draft"); // C should not be queued yet

    // Simulate successful callback for task A
    await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        durableMemory: durableMemory,
      },
      {
        taskId: internalTaskIdA, // internal task ID
        workflowId: `icos-task-${internalTaskIdA}`,
        outcome: "success",
        result: "Task A completed",
        completedAt: new Date().toISOString(),
      },
    );
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        tasks: container.tasks,
        reviewer,
        reviewDecisions: container.reviewDecisions,
      },
      {
        missionId,
        taskId: internalTaskIdA, // internal task ID
        workflowId: `icos-task-${internalTaskIdA}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );

    // After callback, task A should be succeeded
    const tasksAfterACallback = await missionRepository.listTasks(missionId);
    const succeededTaskA = tasksAfterACallback.find(t => t.id === missionTaskIdA)!;
    expect(succeededTaskA?.status).toBe("succeeded");

    // Run supervisor again: now B should be queued (since A succeeded)
    await supervisor.run(missionId);

    // Check that dispatcher.dispatch was called again for task B
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(2);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        taskId: internalTaskIdB, // internal task ID
        taskTitle: missionTaskB.title,
        prompt: missionTaskB.description || missionTaskB.title,
        workerKind: missionTaskB.workerKind || undefined,
        capability: missionTaskB.capability || undefined,
      }),
    );

    // After running supervisor, task B should be queued
    const tasksAfterBDispatch = await missionRepository.listTasks(missionId);
    const queuedTaskBAfter = tasksAfterBDispatch.find(t => t.id === missionTaskIdB)!;
    const queuedTaskCAfter = tasksAfterBDispatch.find(t => t.id === missionTaskIdC)!;
    expect(queuedTaskBAfter?.status).toBe("queued");
    expect(queuedTaskCAfter?.status).toBe("draft"); // C should not be queued yet

    // Simulate FAILED callback for task B
    await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        durableMemory: durableMemory,
      },
      {
        taskId: internalTaskIdB, // internal task ID
        workflowId: `icos-task-${internalTaskIdB}`,
        outcome: "failure",
        error: { code: "WORKER_FAILED", message: "Task B failed intentionally" },
        completedAt: new Date().toISOString(),
      },
    );
    await recordMissionTaskExecution(
      {
        executionResults: container.executionResults,
        supervisor,
        missions: missionRepository,
        tasks: container.tasks,
        reviewer,
        reviewDecisions: container.reviewDecisions,
      },
      {
        missionId,
        taskId: internalTaskIdB, // internal task ID
        workflowId: `icos-task-${internalTaskIdB}`,
        outcome: "failure",
        completedAt: new Date().toISOString(),
      },
    );

    const failureReview = await container.reviewDecisions.getByWorkflowId(
      `icos-task-${internalTaskIdB}`,
    );
    expect(failureReview).toMatchObject({
      decision: "BLOCK",
      reviewerKind: "deterministic",
      reasons: ["Execution outcome is failure"],
    });

    // WORKER_FAILED is non-retryable: deterministic BLOCK applies the failed state.
    const tasksAfterBCallback = await missionRepository.listTasks(missionId);
    const failedTaskB = tasksAfterBCallback.find(t => t.id === missionTaskIdB)!;
    expect(failedTaskB?.status).toBe("failed");

    // Run supervisor again: C should NOT be queued because B failed
    await supervisor.run(missionId);

    // Check that dispatcher.dispatch was NOT called for task C
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(2); // Still only 2 calls

    // Verify task C is still draft (never queued)
    const tasksAfterSupervisorRun = await missionRepository.listTasks(missionId);
    const taskCStatus = tasksAfterSupervisorRun.find(t => t.id === missionTaskIdC)?.status;
    expect(taskCStatus).toBe("draft"); // C should remain draft, never dispatched

    // Check mission status: based on V1 rule, mission should be failed when any required task fails
    const finalMission = await missionRepository.findById(missionId);
    expect(finalMission?.status).toBe("failed");
  });
});