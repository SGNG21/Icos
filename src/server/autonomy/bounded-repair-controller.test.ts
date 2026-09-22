import { describe, expect, test, vi, beforeEach } from "vitest";
import { InMemoryWorkerRegistry } from "@/server/services/worker-registry/in-memory-worker-registry";
import { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { BoundedRepairController, RepairCandidate } from "./bounded-repair-controller";
import { testWorkers } from "@/server/services/worker-registry/fixtures";
import type { MissionTask } from "@/core/mission/contracts";
import { isoDateTimeSchema } from "@/core/contracts/common";

function createTestMissionTask(overrides: Partial<MissionTask> = {}): MissionTask {
  return {
    id: "task-123",
    missionId: "mission-1",
    title: "Build Website Task",
    taskId: "canonical-task-456",
    capability: "website.build",
    description: "Build website",
    status: "draft",
    dependsOn: [],
    ...overrides,
  };
}

function makeRunnableWorker(worker: WorkerRegistryEntry): WorkerRegistryEntry {
  return {
    ...worker,
    health: "healthy",
    availability: "available",
    runtimeSupport: "SUPPORTED_RUNTIME",
    status: "active",
  };
}

describe("BoundedRepairController", () => {
  let registry: InMemoryWorkerRegistry;
  let controller: BoundedRepairController;

  beforeEach(() => {
    vi.restoreAllMocks();
    
    // Use only the workers that match our capability
    const runnableWorkers = testWorkers.map(makeRunnableWorker);
    registry = new InMemoryWorkerRegistry(runnableWorkers);
    
    controller = new BoundedRepairController({
      workerRegistry: registry,
      maxAttempts: 3,
      requiredCapability: "website.build",
    });
  });

  test("getFirstCandidate returns RETRY with first eligible worker", () => {
    const missionTask = createTestMissionTask({ capability: "website.build" });
    
    const decision = controller.getFirstCandidate("mission-1", "task-1", missionTask);
    
    expect(decision.decision).toBe("RETRY");
    expect(decision.candidate).toBeDefined();
    expect(decision.candidate!.attemptNumber).toBe(1);
    expect(decision.candidate!.worker.capabilities).toContain("website.build");
    expect(decision.attemptsUsed).toBe(1);
    expect(decision.maxAttempts).toBe(3);
  });

  test("getFirstCandidate returns HUMAN_DECISION_REQUIRED when no eligible workers", () => {
    const controllerNoWorkers = new BoundedRepairController({
      workerRegistry: new InMemoryWorkerRegistry([]),
      maxAttempts: 3,
      requiredCapability: "website.build",
    });
    
    const missionTask = createTestMissionTask({ capability: "website.build" });
    const decision = controllerNoWorkers.getFirstCandidate("mission-1", "task-1", missionTask);
    
    expect(decision.decision).toBe("HUMAN_DECISION_REQUIRED");
    expect(decision.candidate).toBeUndefined();
    expect(decision.attemptsUsed).toBe(0);
  });

  test("getNextCandidate returns RETRY with different worker on attempt 2", () => {
    // Create a registry with TWO workers having the same capability for this test
    const worker1: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "digitalos-worker-002",
    };
    const worker2: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "digitalos-worker-003",
    };
    const twoWorkerRegistry = new InMemoryWorkerRegistry([worker1, worker2]);
    
    const twoWorkerController = new BoundedRepairController({
      workerRegistry: twoWorkerRegistry,
      maxAttempts: 3,
      requiredCapability: "website.build",
    });
    
    const missionTask = createTestMissionTask({ capability: "website.build" });
    
    const firstDecision = twoWorkerController.getFirstCandidate("mission-1", "task-1", missionTask);
    expect(firstDecision.decision).toBe("RETRY");
    const firstCandidate = firstDecision.candidate!;
    
    const secondDecision = twoWorkerController.getNextCandidate(
      "mission-1",
      "task-1",
      firstCandidate,
      "Execution failed"
    );
    
    expect(secondDecision.decision).toBe("RETRY");
    expect(secondDecision.candidate).toBeDefined();
    expect(secondDecision.candidate!.attemptNumber).toBe(2);
    expect(secondDecision.candidate!.worker.id).not.toBe(firstCandidate.worker.id);
    expect(secondDecision.candidate!.parentCandidateId).toBe(firstCandidate.worker.id);
    expect(secondDecision.attemptsUsed).toBe(2);
  });

  test("getNextCandidate returns EXHAUSTED when maxAttempts reached", () => {
    // Create a registry with TWO workers having the same capability for this test
    const worker1: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "digitalos-worker-002",
    };
    const worker2: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "digitalos-worker-003",
    };
    const twoWorkerRegistry = new InMemoryWorkerRegistry([worker1, worker2]);
    
    const twoWorkerController = new BoundedRepairController({
      workerRegistry: twoWorkerRegistry,
      maxAttempts: 3,
      requiredCapability: "website.build",
    });
    
    const missionTask = createTestMissionTask({ capability: "website.build" });
    
    const firstDecision = twoWorkerController.getFirstCandidate("mission-1", "task-1", missionTask);
    const firstCandidate = firstDecision.candidate!;
    
    const secondDecision = twoWorkerController.getNextCandidate(
      "mission-1",
      "task-1",
      firstCandidate,
      "Execution failed"
    );
    const secondCandidate = secondDecision.candidate!;
    
    const thirdDecision = twoWorkerController.getNextCandidate(
      "mission-1",
      "task-1",
      secondCandidate,
      "Execution failed again"
    );
    const thirdCandidate = thirdDecision.candidate!;
    
    const fourthDecision = twoWorkerController.getNextCandidate(
      "mission-1",
      "task-1",
      thirdCandidate,
      "Execution failed third time"
    );
    
    expect(fourthDecision.decision).toBe("EXHAUSTED");
    expect(fourthDecision.candidate).toBeUndefined();
    expect(fourthDecision.attemptsUsed).toBe(3);
    expect(fourthDecision.maxAttempts).toBe(3);
    expect(fourthDecision.reason).toContain("Max repair attempts (3) reached");
  });

  test("getNextCandidate returns HUMAN_DECISION_REQUIRED when no valid alternate worker", () => {
    // Create controller with only ONE worker matching the capability
    const singleWorker = [makeRunnableWorker(testWorkers.find(w => w.capabilities.includes("website.build"))!)];
    const singleWorkerRegistry = new InMemoryWorkerRegistry(singleWorker);
    
    const singleWorkerController = new BoundedRepairController({
      workerRegistry: singleWorkerRegistry,
      maxAttempts: 3,
      requiredCapability: "website.build",
    });
    
    const missionTask = createTestMissionTask({ capability: "website.build" });
    
    const firstDecision = singleWorkerController.getFirstCandidate("mission-1", "task-1", missionTask);
    const firstCandidate = firstDecision.candidate!;
    
    const secondDecision = singleWorkerController.getNextCandidate(
      "mission-1",
      "task-1",
      firstCandidate,
      "Execution failed"
    );
    
    expect(secondDecision.decision).toBe("HUMAN_DECISION_REQUIRED");
    expect(secondDecision.candidate).toBeUndefined();
    expect(secondDecision.reason).toContain("All eligible workers exhausted");
  });

  test("workflowId is unique per attempt and preserves parent identity", () => {
      // Create a registry with TWO workers having the same capability for this test
      const worker1: WorkerRegistryEntry = {
        ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
        id: "digitalos-worker-002",
      };
      const worker2: WorkerRegistryEntry = {
        ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
        id: "digitalos-worker-003",
      };
      const twoWorkerRegistry = new InMemoryWorkerRegistry([worker1, worker2]);
    
      const twoWorkerController = new BoundedRepairController({
        workerRegistry: twoWorkerRegistry,
        maxAttempts: 3,
        requiredCapability: "website.build",
      });
    
      const missionTask = createTestMissionTask({ capability: "website.build" });
    
      const firstDecision = twoWorkerController.getFirstCandidate("mission-1", "task-1", missionTask);
      const firstCandidate = firstDecision.candidate!;
    
      const secondDecision = twoWorkerController.getNextCandidate(
        "mission-1",
        "task-1",
        firstCandidate,
        "Failed"
      );
      const secondCandidate = secondDecision.candidate!;
    
      // Workflow IDs should be different
      expect(firstCandidate.workflowId).not.toBe(secondCandidate.workflowId);
    
      // Both should contain missionId and taskId
      expect(firstCandidate.workflowId).toContain("mission-1");
      expect(firstCandidate.workflowId).toContain("task-1");
      expect(secondCandidate.workflowId).toContain("mission-1");
      expect(secondCandidate.workflowId).toContain("task-1");
    
      // Should contain attempt number
      expect(firstCandidate.workflowId).toContain("repair-1");
      expect(secondCandidate.workflowId).toContain("repair-2");
    
      // Second candidate should reference first candidate as parent
      expect(secondCandidate.parentCandidateId).toBe(firstCandidate.worker.id);
    });

  test("buildDispatchInput preserves workflowId and workerKind", () => {
    const missionTask = createTestMissionTask({ capability: "website.build" });
    
    const firstDecision = controller.getFirstCandidate("mission-1", "task-1", missionTask);
    const candidate = firstDecision.candidate!;
    
    const baseInput = {
      taskId: "canonical-task-456",
      prompt: "Build the website",
      missionId: "mission-1",
      taskTitle: "Website Build",
    };
    
    const dispatchInput = controller.buildDispatchInput(candidate, baseInput);
    
    expect(dispatchInput.workflowId).toBe(candidate.workflowId);
    expect(dispatchInput.workerKind).toBe(candidate.worker.workerKind);
    expect(dispatchInput.capability).toBe("website.build");
    expect(dispatchInput.taskId).toBe("canonical-task-456");
  });

  test("no fabricated worker/provider/model - uses actual registry entries", () => {
    const missionTask = createTestMissionTask({ capability: "website.build" });
    
    const decision = controller.getFirstCandidate("mission-1", "task-1", missionTask);
    const candidate = decision.candidate!;
    
    // Verify the worker exists in our registry
    const registryWorker = registry.getWorker(candidate.worker.id);
    expect(registryWorker).toBeDefined();
    expect(registryWorker!.id).toBe(candidate.worker.id);
    expect(registryWorker!.workerKind).toBe(candidate.worker.workerKind);
    expect(registryWorker!.capabilities).toEqual(candidate.worker.capabilities);
    expect(registryWorker!.runtime).toBe(candidate.worker.runtime);
  });

  test("respects requiredWorkerKind filter", () => {
    const digitalosOnlyController = new BoundedRepairController({
      workerRegistry: registry,
      maxAttempts: 3,
      requiredCapability: "website.build",
      requiredWorkerKind: "digitalos",
    });
    
    const missionTask = createTestMissionTask({ capability: "website.build" });
    const decision = digitalosOnlyController.getFirstCandidate("mission-1", "task-1", missionTask);
    
    expect(decision.decision).toBe("RETRY");
    expect(decision.candidate!.worker.workerKind).toBe("digitalos");
  });

  test("returns HUMAN_DECISION_REQUIRED when requiredWorkerKind has no eligible workers", () => {
    const hermesOnlyController = new BoundedRepairController({
      workerRegistry: registry,
      maxAttempts: 3,
      requiredCapability: "website.build",
      requiredWorkerKind: "hermes", // hermes worker doesn't have website.build capability
    });
    
    const missionTask = createTestMissionTask({ capability: "website.build" });
    const decision = hermesOnlyController.getFirstCandidate("mission-1", "task-1", missionTask);
    
    expect(decision.decision).toBe("HUMAN_DECISION_REQUIRED");
  });

  test("filters out inactive workers", () => {
    const inactiveWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "agent")!),
      id: "inactive-worker-001",
      status: "inactive",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...testWorkers.map(makeRunnableWorker),
      inactiveWorker,
    ]);
    
    const mixedController = new BoundedRepairController({
      workerRegistry: mixedRegistry,
      maxAttempts: 3,
      requiredCapability: "text-generation",
    });
    
    const missionTask = createTestMissionTask({ capability: "text-generation" });
    
    // Run multiple times to verify inactive is never selected
    for (let i = 0; i < 5; i++) {
      const decision = mixedController.getFirstCandidate("mission-1", `task-${i}`, missionTask);
      expect(decision.candidate!.worker.id).not.toBe("inactive-worker-001");
    }
  });

  test("filters out workers with unknown runtime support", () => {
    const unknownRuntimeWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "agent")!),
      id: "unknown-runtime-worker-001",
      runtimeSupport: "UNKNOWN",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...testWorkers.map(makeRunnableWorker),
      unknownRuntimeWorker,
    ]);
    
    const mixedController = new BoundedRepairController({
      workerRegistry: mixedRegistry,
      maxAttempts: 3,
      requiredCapability: "text-generation",
    });
    
    const missionTask = createTestMissionTask({ capability: "text-generation" });
    
    for (let i = 0; i < 5; i++) {
      const decision = mixedController.getFirstCandidate("mission-1", `task-${i}`, missionTask);
      expect(decision.candidate!.worker.id).not.toBe("unknown-runtime-worker-001");
    }
  });

  test("filters out unhealthy workers", () => {
    const unhealthyWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "agent")!),
      id: "unhealthy-worker-001",
      health: "unhealthy",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...testWorkers.map(makeRunnableWorker),
      unhealthyWorker,
    ]);
    
    const mixedController = new BoundedRepairController({
      workerRegistry: mixedRegistry,
      maxAttempts: 3,
      requiredCapability: "text-generation",
    });
    
    const missionTask = createTestMissionTask({ capability: "text-generation" });
    
    for (let i = 0; i < 5; i++) {
      const decision = mixedController.getFirstCandidate("mission-1", `task-${i}`, missionTask);
      expect(decision.candidate!.worker.id).not.toBe("unhealthy-worker-001");
    }
  });
});