import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Container } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskExecutionResultRepository } from "@/server/repositories/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { ReviewerService } from "@/server/review/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
// We need to cast to InMemoryMissionRepository to update dependsOn
import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
import { InMemoryDurableMemory } from "@/core/context/durable-memory";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import { FakeReviewer } from "@/server/review/fake-reviewer";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { CompositeTaskExecutionDispatcher } from "@/server/execution/composite-task-execution-dispatcher";
import { InMemoryTaskExecutionResultRepository } from "@/server/services/in-memory/task-execution-result-repository";
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
  "extra-14",
  "extra-15",
  "extra-16",
  "extra-17",
  "extra-18",
  "extra-19",
  "extra-20",
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

describe("E2E success scenario", () => {
  let container: Container | null = null;
  let supervisor: SupervisorService | null = null;
  let missionRepository: MissionRepository | null = null;
  let taskExecutionResultRepository: TaskExecutionResultRepository;
  let durableMemory: InMemoryDurableMemory;

  beforeEach(async () => {
    // Close existing container if any
    if (container) {
      await container.close();
    }
    // Reset the UUID index for each test
    uuidIndex = 0;
    // Force in-memory persistence for test isolation
    process.env.PERSISTENCE = 'memory';
    // Create a fresh container
    container = await import("@/server/container").then(({ createContainer }) => createContainer());
    if (!container) throw new Error("Container is null");

    missionRepository = container.mission as MissionRepository;
    if (!missionRepository) throw new Error("missionRepository is null");
    taskExecutionResultRepository = container.executionResults as TaskExecutionResultRepository;
    if (!taskExecutionResultRepository) throw new Error("taskExecutionResultRepository is null");

    // Get the dispatcher and mock its dispatch method to return a deterministic workflowId
    const dispatcher = container.taskExecution;
    vi.spyOn(dispatcher, "dispatch").mockImplementation((input) => {
      return Promise.resolve({ workflowId: `icos-task-${input.taskId}` });
    });

    durableMemory = new InMemoryDurableMemory();
    // Mock all methods of durableMemory that we use in the test
    durableMemory.getCheckpoints = vi.fn().mockResolvedValue([]);
    durableMemory.saveCheckpoint = vi.fn().mockResolvedValue(undefined);
    durableMemory.getLatestCheckpoint = vi.fn().mockResolvedValue(null);
    durableMemory.getCheckpointById = vi.fn().mockResolvedValue(null);
    durableMemory.saveDecision = vi.fn().mockResolvedValue(undefined);
    durableMemory.getDecisions = vi.fn().mockResolvedValue([]);
    durableMemory.saveExecutionResult = vi.fn().mockResolvedValue(undefined);
    durableMemory.getExecutionResults = vi.fn().mockResolvedValue([]);
    durableMemory.savePattern = vi.fn().mockResolvedValue(undefined);
    durableMemory.getPatterns = vi.fn().mockResolvedValue([]);
    durableMemory.saveContextItem = vi.fn().mockResolvedValue(undefined);
    durableMemory.queryContextItems = vi.fn().mockResolvedValue([]);
    durableMemory.saveHandoffPackage = vi.fn().mockResolvedValue(undefined);
    durableMemory.getHandoffPackage = vi.fn().mockResolvedValue(null);
    durableMemory.cleanup = vi.fn().mockResolvedValue(0);

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
    // Clean up environment variable
    delete process.env.PERSISTENCE;
  });

  it("should process a mission A->B->C and end with mission succeeded", async () => {
    if (!container || !supervisor || !missionRepository)
      throw new Error("Container or supervisor or missionRepository not initialized");

    // Step 1: Create mission with tasks A, B, C (initially with empty dependsOn)
    const mission = await missionRepository.create({
      title: "E2E Test Mission",
      objective: "Test the supervisor loop",
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

    if (!taskA || !taskB || !taskC) {
      throw new Error("Tasks not found");
    }

    const taskAId = taskA.id;
    const taskBId = taskB.id;
    const taskCId = taskC.id;

    // Update the dependsOn for taskB and taskC in the mission tasks
    // We cast to InMemoryMissionRepository because the interface doesn't have this method,
    // but in the test environment we are using the in-memory repository.
    const missionRepo = missionRepository as InMemoryMissionRepository;
    await missionRepo.updateMissionTaskDependsOn(taskBId, [taskAId]);
    await missionRepo.updateMissionTaskDependsOn(taskCId, [taskBId]);

    // Verify the dependencies are set correctly
    tasks = await missionRepository.listTasks(missionId);
    const updatedTaskA = tasks.find((t) => t.id === taskAId);
    const updatedTaskB = tasks.find((t) => t.id === taskBId);
    const updatedTaskC = tasks.find((t) => t.id === taskCId);

    expect(updatedTaskA?.dependsOn).toEqual([]);
    expect(updatedTaskB?.dependsOn).toEqual([taskAId]);
    expect(updatedTaskC?.dependsOn).toEqual([taskBId]);

    // Initially, all tasks should be draft
    expect(updatedTaskA?.status).toBe("draft");
    expect(updatedTaskB?.status).toBe("draft");
    expect(updatedTaskC?.status).toBe("draft");

    // Run supervisor for the first time: should dispatch A only
    await supervisor.run(missionId);

    if (!taskA) throw new Error("Task A not found");
    // Check that dispatcher.dispatch was called once for task A
    // Supervisor dispatches using the canonical Task.id (task.taskId), not the MissionTask.id
    expect(container.taskExecution.dispatch).toHaveBeenCalledTimes(1);
    expect(container.taskExecution.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId,
        taskId: taskA.taskId, // Use canonical taskId, not MissionTask.id
        taskTitle: taskA.title,
        prompt: taskA.description || taskA.title,
        workerKind: taskA.workerKind || undefined,
        capability: undefined,
        digitalosFacadePath: undefined,
      }),
    );

    // After running supervisor, task A should be queued (via updateMissionTaskStatus in supervisor)
    const updatedTasksAfterRun1 = await missionRepository.listTasks(missionId);
    const queuedTaskA = updatedTasksAfterRun1.find((t) => t.id === taskAId);
    const queuedTaskB = updatedTasksAfterRun1.find((t) => t.id === taskBId);
    const queuedTaskC = updatedTasksAfterRun1.find((t) => t.id === taskCId);

    expect(queuedTaskA?.status).toBe("queued");
    expect(queuedTaskB?.status).toBe("draft"); // B should not be queued yet
    expect(queuedTaskC?.status).toBe("draft"); // C should not be queued yet

    // Simulate successful callback for task A
    const resultA = await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        durableMemory: durableMemory,
      },
      {
        taskId: taskA.taskId,
        workflowId: `icos-task-${taskA.taskId}`,
        outcome: "success",
        result: "Task A completed",
        completedAt: new Date().toISOString(),
      },
    );
    // Apply review gate for task A
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
        missionId,
        taskId: taskA.taskId,
        workflowId: `icos-task-${taskA.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );
    // After task A completion, supervisor should have run (via continueMission) and queued task B
    const tasksAfterA = await missionRepository.listTasks(missionId);
    const completedTaskA = tasksAfterA.find((t) => t.id === taskAId);
    const queuedTaskBAfterA = tasksAfterA.find((t) => t.id === taskBId);
    const queuedTaskCAfterA = tasksAfterA.find((t) => t.id === taskCId);
    expect(completedTaskA?.status).toBe("succeeded");
    expect(queuedTaskBAfterA?.status).toBe("queued");
    expect(queuedTaskCAfterA?.status).toBe("draft"); // C should not be queued yet

    // Simulate successful callback for task B
    const resultB = await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        durableMemory: durableMemory,
      },
      {
        taskId: taskB.taskId,
        workflowId: `icos-task-${taskB.taskId}`,
        outcome: "success",
        result: "Task B completed",
        completedAt: new Date().toISOString(),
      },
    );
    // Apply review gate for task B
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
        missionId,
        taskId: taskB.taskId,
        workflowId: `icos-task-${taskB.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );
    // After task B completion, supervisor should have run (via continueMission) and queued task C
    const tasksAfterB = await missionRepository.listTasks(missionId);
    const completedTaskB = tasksAfterB.find((t) => t.id === taskBId);
    const queuedTaskCAfterB = tasksAfterB.find((t) => t.id === taskCId);
    expect(completedTaskB?.status).toBe("succeeded");
    expect(queuedTaskCAfterB?.status).toBe("queued"); // C should now be queued

    // Simulate successful callback for task C
    const resultC = await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        durableMemory: durableMemory,
      },
      {
        taskId: taskC.taskId,
        workflowId: `icos-task-${taskC.taskId}`,
        outcome: "success",
        result: "Task C completed",
        completedAt: new Date().toISOString(),
      },
    );
    // Apply review gate for task C
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
        missionId,
        taskId: taskC.taskId,
        workflowId: `icos-task-${taskC.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );
    // After task C completion, supervisor should have run (via continueMission) and marked mission as succeeded
    const finalMission = await missionRepository.findById(missionId);
    expect(finalMission?.status).toBe("succeeded");
  });
});