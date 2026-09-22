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

function makeUnhealthyWorker(worker: WorkerRegistryEntry): WorkerRegistryEntry {
  return {
    ...worker,
    health: "unhealthy",
    availability: "available",
    runtimeSupport: "SUPPORTED_RUNTIME",
    status: "active",
  };
}

function makeUnavailableWorker(worker: WorkerRegistryEntry): WorkerRegistryEntry {
  return {
    ...worker,
    health: "healthy",
    availability: "unavailable",
    runtimeSupport: "SUPPORTED_RUNTIME",
    status: "active",
  };
}

function makeUnknownHealthWorker(worker: WorkerRegistryEntry): WorkerRegistryEntry {
  return {
    ...worker,
    health: "unknown",
    availability: "available",
    runtimeSupport: "SUPPORTED_RUNTIME",
    status: "active",
  };
}

function makeUnknownAvailabilityWorker(worker: WorkerRegistryEntry): WorkerRegistryEntry {
  return {
    ...worker,
    health: "healthy",
    availability: "unknown",
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
      workflowId: "canonical-workflow-123",
      maxAttempts: 3,
      requiredCapability: "website.build",
    });
  });

  test("constructor throws when workflowId is missing", () => {
    expect(() => {
      new BoundedRepairController({
        workerRegistry: registry,
        maxAttempts: 3,
        requiredCapability: "website.build",
      } as any);
    }).toThrow("Canonical workflowId is required and must not be empty");
  });

  test("constructor throws when workflowId is empty string", () => {
    expect(() => {
      new BoundedRepairController({
        workerRegistry: registry,
        workflowId: "",
        maxAttempts: 3,
        requiredCapability: "website.build",
      });
    }).toThrow("Canonical workflowId is required and must not be empty");
  });

  test("constructor throws when workflowId is whitespace only", () => {
    expect(() => {
      new BoundedRepairController({
        workerRegistry: registry,
        workflowId: "   ",
        maxAttempts: 3,
        requiredCapability: "website.build",
      });
    }).toThrow("Canonical workflowId is required and must not be empty");
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
      workflowId: "canonical-workflow-123",
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
      workflowId: "canonical-workflow-123",
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
    expect(secondDecision.candidate!.parentRepairAttemptId).toBe(firstCandidate.repairAttemptId);
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
      workflowId: "canonical-workflow-123",
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
        workflowId: "canonical-workflow-123",
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

    test("workflowId is canonical across attempts and distinct repairAttemptId per attempt", () => {
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
                workflowId: "canonical-workflow-123",
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

              const thirdDecision = twoWorkerController.getNextCandidate(
                "mission-1",
                "task-1",
                secondCandidate,
                "Failed again"
              );
              const thirdCandidate = thirdDecision.candidate!;

              // Workflow ID should be SAME across attempts (canonical identity)
              expect(firstCandidate.workflowId).toBe(secondCandidate.workflowId);
              expect(secondCandidate.workflowId).toBe(thirdCandidate.workflowId);
              expect(firstCandidate.workflowId).toBe("canonical-workflow-123");
        expect(secondCandidate.workflowId).toBe("canonical-workflow-123");
        expect(thirdCandidate.workflowId).toBe("canonical-workflow-123");

        // Repair attempt IDs should be DIFFERENT per attempt
        expect(firstCandidate.repairAttemptId).toBeDefined();
        expect(secondCandidate.repairAttemptId).toBeDefined();
        expect(thirdCandidate.repairAttemptId).toBeDefined();
        expect(firstCandidate.repairAttemptId).not.toBe(secondCandidate.repairAttemptId);
        expect(secondCandidate.repairAttemptId).not.toBe(thirdCandidate.repairAttemptId);
        expect(firstCandidate.repairAttemptId).not.toBe(thirdCandidate.repairAttemptId);

              // Should contain attempt number
              expect(firstCandidate.repairAttemptId).toContain("repair-1");
              expect(secondCandidate.repairAttemptId).toContain("repair-2");
              expect(thirdCandidate.repairAttemptId).toContain("repair-3");

              // Second candidate should reference first candidate's repairAttemptId as parent
              expect(secondCandidate.parentRepairAttemptId).toBe(firstCandidate.repairAttemptId);
              expect(thirdCandidate.parentRepairAttemptId).toBe(secondCandidate.repairAttemptId);
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
      workflowId: "canonical-workflow-123",
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
      workflowId: "canonical-workflow-123",
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
      workflowId: "canonical-workflow-123",
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
      workflowId: "canonical-workflow-123",
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
      workflowId: "canonical-workflow-123",
      maxAttempts: 3,
      requiredCapability: "text-generation",
    });
    
    const missionTask = createTestMissionTask({ capability: "text-generation" });
    
    for (let i = 0; i < 5; i++) {
      const decision = mixedController.getFirstCandidate("mission-1", `task-${i}`, missionTask);
      expect(decision.candidate!.worker.id).not.toBe("unhealthy-worker-001");
    }
  });

  test("filters out workers with unknown health (fail closed)", () => {
    const unknownHealthWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "agent")!),
      id: "unknown-health-worker-001",
      health: "unknown",
    };

    const mixedRegistry = new InMemoryWorkerRegistry([
      ...testWorkers.map(makeRunnableWorker),
      unknownHealthWorker,
    ]);

    const mixedController = new BoundedRepairController({
      workerRegistry: mixedRegistry,
      workflowId: "canonical-workflow-123",
      maxAttempts: 3,
      requiredCapability: "text-generation",
    });

    const missionTask = createTestMissionTask({ capability: "text-generation" });

    for (let i = 0; i < 5; i++) {
      const decision = mixedController.getFirstCandidate("mission-1", `task-${i}`, missionTask);
      expect(decision.candidate!.worker.id).not.toBe("unknown-health-worker-001");
    }
  });

  test("filters out workers with unknown availability (fail closed)", () => {
    const unknownAvailabilityWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "agent")!),
      id: "unknown-availability-worker-001",
      availability: "unknown",
    };

    const mixedRegistry = new InMemoryWorkerRegistry([
      ...testWorkers.map(makeRunnableWorker),
      unknownAvailabilityWorker,
    ]);

    const mixedController = new BoundedRepairController({
      workerRegistry: mixedRegistry,
      workflowId: "canonical-workflow-123",
      maxAttempts: 3,
      requiredCapability: "text-generation",
    });

    const missionTask = createTestMissionTask({ capability: "text-generation" });

    for (let i = 0; i < 5; i++) {
      const decision = mixedController.getFirstCandidate("mission-1", `task-${i}`, missionTask);
      expect(decision.candidate!.worker.id).not.toBe("unknown-availability-worker-001");
    }
  });

  test("maxAttempts=3 means exactly three total repair attempts", () => {
    // Create a registry with THREE workers having the same capability
    const worker1: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "worker-attempt-1",
    };
    const worker2: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "worker-attempt-2",
    };
    const worker3: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers.find(w => w.workerKind === "digitalos")!),
      id: "worker-attempt-3",
    };
    const threeWorkerRegistry = new InMemoryWorkerRegistry([worker1, worker2, worker3]);

    const threeWorkerController = new BoundedRepairController({
      workerRegistry: threeWorkerRegistry,
      workflowId: "canonical-workflow-123",
      maxAttempts: 3,
      requiredCapability: "website.build",
    });

    const missionTask = createTestMissionTask({ capability: "website.build" });

    // First attempt
    const firstDecision = threeWorkerController.getFirstCandidate("mission-1", "task-1", missionTask);
    expect(firstDecision.decision).toBe("RETRY");
    expect(firstDecision.attemptsUsed).toBe(1);
    const firstCandidate = firstDecision.candidate!;

    // Second attempt
    const secondDecision = threeWorkerController.getNextCandidate(
      "mission-1", "task-1", firstCandidate, "Failed"
    );
    expect(secondDecision.decision).toBe("RETRY");
    expect(secondDecision.attemptsUsed).toBe(2);
    const secondCandidate = secondDecision.candidate!;

    // Third attempt
    const thirdDecision = threeWorkerController.getNextCandidate(
      "mission-1", "task-1", secondCandidate, "Failed again"
    );
    expect(thirdDecision.decision).toBe("RETRY");
    expect(thirdDecision.attemptsUsed).toBe(3);
    const thirdCandidate = thirdDecision.candidate!;

    // Fourth attempt should be EXHAUSTED (max 3 attempts reached)
    const fourthDecision = threeWorkerController.getNextCandidate(
      "mission-1", "task-1", thirdCandidate, "Failed third time"
    );
    expect(fourthDecision.decision).toBe("EXHAUSTED");
    expect(fourthDecision.attemptsUsed).toBe(3);
    expect(fourthDecision.maxAttempts).toBe(3);
    expect(fourthDecision.reason).toContain("Max repair attempts (3) reached");
  });
});