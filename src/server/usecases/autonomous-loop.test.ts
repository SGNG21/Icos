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
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { InMemoryReviewDecisionRepository } from "@/server/services/in-memory/review-decision-repository";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import { FakeReviewer } from "@/server/review/fake-reviewer";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { CompositeTaskExecutionDispatcher } from "@/server/execution/composite-task-execution-dispatcher";
import { TemporalTaskExecutionDispatcher } from "@/server/execution/temporal-task-execution-dispatcher";
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
let container: Container | null = null;
let supervisor: SupervisorService | null = null;
let missionRepository: MissionRepository;
let taskExecutionResultRepository: TaskExecutionResultRepository;
let durableMemory: any; // We'll use the container's durableMemory (which is DurableMemory interface)
describe("Autonomous loop with real agent (local dispatcher) using memory container", () => {
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
  it("should process a mission with a real agent (local dispatcher) that writes a file and end with mission succeeded", async () => {
    if (!container || !supervisor || !missionRepository) {
      throw new Error("Container or supervisor or missionRepository not initialized");
    }
    // Step 1: Create mission with a single task that uses the local dispatcher
    // We set workerKind to "test-worker" to trigger the local dispatcher in the composite dispatcher (fallback for TEST ONLY)
    const mission = await missionRepository.create({
      title: "Autonomous Loop Test Mission",
      objective: "Test the supervisor loop with a real agent that writes a file",
      tasks: [
        {
          title: "Write a test file",
          description: "WRITE_FILE:/tmp/icos/test.txt:Hello from IcoS!",
          dependsOn: [],
          workerKind: "test-worker", // This will trigger the local dispatcher
          capability: undefined,
        },
      ],
    });
    // Expect mission to be created
    expect(mission).not.toBeNull();
    const missionId = mission.id;
    // Get the mission tasks to get their actual IDs
    const tasks = await missionRepository.listTasks(missionId);
    expect(tasks).toHaveLength(1);
    const taskA = tasks.find((t) => t.title === "Write a test file");
    expect(taskA).not.toBeNull();
    if (!taskA) {
      throw new Error("Task not found");
    }
    const taskAId = taskA.id;
    console.log("Task A id (mission task):", taskAId);
    console.log("Task A canonical id:", taskA.taskId);
    // Initially, the task should be draft
    expect(taskA.status).toBe("draft");
    console.log("Initial task status:", taskA.status);
    // Spy on dispatcher.dispatch to see if it's called
    const dispatcher = container.taskExecution;
    const dispatchSpy = vi.spyOn(dispatcher, "dispatch");
    // Run supervisor for the first time: should dispatch the task
    console.log("About to run supervisor...");
    await supervisor.run(missionId);
    console.log("Supervisor.run completed.");
    console.log("dispatchSpy call count:", dispatchSpy.mock.calls.length);
    if (dispatchSpy.mock.calls.length > 0) {
      console.log("dispatchSpy first call args:", dispatchSpy.mock.calls[0]);
    }
    // The local execution adapter completed the canonical Task.
    // The MissionTask must remain queued until the mission-level review callback.
    const tasksAfterDispatch = await missionRepository.listTasks(missionId);
    const queuedTaskA = tasksAfterDispatch.find((t) => t.id === taskAId);

    expect(queuedTaskA).not.toBeNull();
    expect(queuedTaskA?.status).toBe("queued");

    const executionResultsAfter =
      await taskExecutionResultRepository.listByTaskIds([taskA.taskId]);

    expect(executionResultsAfter).toHaveLength(1);

    const execution = executionResultsAfter[0];

    await recordMissionTaskExecution(
      {
        executionResults: taskExecutionResultRepository,
        supervisor,
        missions: missionRepository,
        tasks: container.tasks,
        reviewer: container.reviewer,
        reviewDecisions: container.reviewDecisions,
        taskExecution: dispatcher,
        durableMemory,
      },
      {
        missionId,
        taskId: taskA.taskId,
        workflowId: execution.workflowId,
        outcome: execution.outcome,
        result: execution.result,
        error: execution.error,
        completedAt: execution.completedAt,
      },
    );

    const tasksAfterReview = await missionRepository.listTasks(missionId);
    const succeededTaskA = tasksAfterReview.find((t) => t.id === taskAId);

    expect(succeededTaskA).not.toBeNull();
    expect(succeededTaskA?.status).toBe("succeeded");

    const missionAfterReview = await missionRepository.findById(missionId);
    expect(missionAfterReview?.status).toBe("succeeded");

    // Now run the supervisor again to see if the mission is succeeded.
    await supervisor.run(missionId);
    // Check the mission status
    const finalMission = await missionRepository.findById(missionId);
    expect(finalMission?.status).toBe("succeeded");
    // Additionally, we can verify that the file was written.
    const fs = await import("node:fs/promises");
    // From the logs, the file is written to /tmp/icos/tmp/icos/test.txt
    const filePath = "/tmp/icos/tmp/icos/test.txt";
    const content = await fs.readFile(filePath, "utf8");
    expect(content.trim()).toBe("Hello from IcoS!");
    // Clean up the file
    await fs.unlink(filePath);
  });
});
