import { describe, expect, test, vi, beforeEach } from "vitest";
import { InMemoryWorkerRegistry } from "@/server/services/worker-registry/in-memory-worker-registry";
import { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import {
  ReviewerIndependenceChecker,
  IndependentReviewerSelector,
  assertReviewerIndependence,
  requireIndependentReviewer,
  ReviewerIndependenceCheck,
} from "./reviewer-independence";
import { testWorkers } from "@/server/services/worker-registry/fixtures";
import type { ReviewInput } from "@/server/review/ports";
import { isoDateTimeSchema } from "@/core/contracts/common";

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

function createMockReviewInput(producerWorkerId: string): ReviewInput {
  return {
    mission: {
      id: "mission-1",
      title: "Test Mission",
      objective: "Test objective",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    missionTask: {
      id: "task-1",
      missionId: "mission-1",
      taskId: "canonical-task-1",
      title: "Build Website",
      capability: "website.build",
      description: "Build website",
      status: "running",
      dependsOn: [],
    },
    task: {
      id: "canonical-task-1",
      title: "Build Website",
      description: "Build the website",
    },
    executionResult: {
      id: "exec-1",
      taskId: "canonical-task-1",
      workflowId: "wf-1",
      outcome: "success",
      result: "Built successfully",
      completedAt: new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      evidence: [],
      findings: [],
      artifacts: [],
    },
    artifacts: [],
    evidence: [],
    findings: [],
  };
}

describe("ReviewerIndependenceChecker", () => {
  let registry: InMemoryWorkerRegistry;
  let runnableWorkers: WorkerRegistryEntry[];

  beforeEach(() => {
    vi.restoreAllMocks();
    runnableWorkers = testWorkers.map(makeRunnableWorker);
    registry = new InMemoryWorkerRegistry(runnableWorkers);
  });

  test("check returns isIndependent=true when producer and reviewer are different workers", () => {
    const producerId = runnableWorkers[0].id; // hermes
    const reviewerId = runnableWorkers[1].id; // openhands
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: reviewerId,
    });
    
    const result = checker.check();
    
    expect(result.isIndependent).toBe(true);
    expect(result.producerIdentity.workerId).toBe(producerId);
    expect(result.reviewerIdentity!.workerId).toBe(reviewerId);
    expect(result.reason).toBe("Reviewer is independent from producer");
    expect(result.evidence.sameWorkerId).toBe(false);
    expect(result.evidence.reviewerIdentityVerified).toBe(true);
    expect(result.evidence.producerIdentityVerified).toBe(true);
  });

  test("check returns isIndependent=false when reviewer is same as producer (self-review)", () => {
    const producerId = runnableWorkers[0].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: producerId,
    });
    
    const result = checker.check();
    
    expect(result.isIndependent).toBe(false);
    expect(result.reason).toContain("Self-review denied");
    expect(result.evidence.sameWorkerId).toBe(true);
  });

  test("check returns isIndependent=false when reviewer identity is missing", () => {
    const producerId = runnableWorkers[0].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: null,
    });
    
    const result = checker.check();
    
    expect(result.isIndependent).toBe(false);
    expect(result.reason).toContain("Reviewer identity missing");
    expect(result.reviewerIdentity).toBeNull();
    expect(result.evidence.reviewerIdentityVerified).toBe(false);
  });

  test("check returns isIndependent=false when reviewer workerId not in registry", () => {
    const producerId = runnableWorkers[0].id;
    const unknownReviewerId = "unknown-reviewer-999";
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: unknownReviewerId,
    });
    
    const result = checker.check();
    
    expect(result.isIndependent).toBe(false);
    expect(result.reason).toContain("Reviewer identity not verified");
    expect(result.reviewerIdentity!.workerId).toBe(unknownReviewerId);
    expect(result.reviewerIdentity!.workerKind).toBe("unknown");
    expect(result.evidence.reviewerIdentityVerified).toBe(false);
  });

  test("check returns isIndependent=false when producer workerId not in registry", () => {
    const unknownProducerId = "unknown-producer-999";
    const reviewerId = runnableWorkers[1].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: unknownProducerId,
      reviewerWorkerId: reviewerId,
    });
    
    const result = checker.check();
    
    expect(result.isIndependent).toBe(false);
    expect(result.reason).toContain("Producer identity not verified");
    expect(result.producerIdentity.workerId).toBe(unknownProducerId);
    expect(result.producerIdentity.workerKind).toBe("unknown");
    expect(result.evidence.producerIdentityVerified).toBe(false);
  });

  test("evidence contains correct worker kinds and IDs", () => {
    const producerId = runnableWorkers[0].id; // hermes
    const reviewerId = runnableWorkers[2].id; // digitalos
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: reviewerId,
    });
    
    const result = checker.check();
    
    expect(result.evidence.producerWorkerId).toBe(producerId);
    expect(result.evidence.reviewerWorkerId).toBe(reviewerId);
    expect(result.evidence.producerWorkerKind).toBe("hermes");
    expect(result.evidence.reviewerWorkerKind).toBe("digitalos");
    expect(result.evidence.sameWorkerId).toBe(false);
    expect(result.evidence.sameWorkerKind).toBe(false);
  });

  test("allows same worker kind if different worker IDs", () => {
    // Create two workers of same kind
    const worker1: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "hermes-worker-002",
    };
    const worker2: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "hermes-worker-003",
    };
    
    const sameKindRegistry = new InMemoryWorkerRegistry([worker1, worker2]);
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: sameKindRegistry,
      producerWorkerId: worker1.id,
      reviewerWorkerId: worker2.id,
    });
    
    const result = checker.check();
    
    expect(result.isIndependent).toBe(true);
    expect(result.evidence.sameWorkerKind).toBe(true);
    expect(result.evidence.sameWorkerId).toBe(false);
  });
});

describe("IndependentReviewerSelector", () => {
  let registry: InMemoryWorkerRegistry;
  let runnableWorkers: WorkerRegistryEntry[];

  beforeEach(() => {
    vi.restoreAllMocks();
    runnableWorkers = testWorkers.map(makeRunnableWorker);
    registry = new InMemoryWorkerRegistry(runnableWorkers);
  });

  test("select returns SELECTED with eligible independent reviewer", () => {
    const producerId = runnableWorkers[0].id; // hermes
    
    const selector = new IndependentReviewerSelector(registry, producerId, ["website.build"]);
    
    const result = selector.select();
    
    expect(result.success).toBe(true);
    expect(result.decision).toBe("SELECTED");
    expect(result.reviewerWorkerId).toBeDefined();
    expect(result.reviewerWorkerId).not.toBe(producerId);
    expect(result.reason).toContain("Selected independent reviewer");
  });

  test("select returns NO_ELIGIBLE_REVIEWERS when no workers match capability", () => {
    const producerId = runnableWorkers[0].id; // hermes
    
    // Request a capability that no worker has
    const selector = new IndependentReviewerSelector(registry, producerId, ["non-existent-capability"]);
    
    const result = selector.select();
    
    expect(result.success).toBe(false);
    expect(result.decision).toBe("NO_ELIGIBLE_REVIEWERS");
  });

  test("select returns HUMAN_DECISION_REQUIRED when producer not in registry", () => {
    const unknownProducerId = "unknown-producer-999";
    
    const selector = new IndependentReviewerSelector(registry, unknownProducerId, ["website.build"]);
    
    const result = selector.select();
    
    expect(result.success).toBe(false);
    expect(result.decision).toBe("HUMAN_DECISION_REQUIRED");
    expect(result.reason).toContain("not found in registry");
  });

  test("select excludes producer from eligible reviewers", () => {
    const producerId = runnableWorkers[0].id;
    
    // Create registry with only producer and one other worker that doesn't match capability
    const limitedWorkers = [
      makeRunnableWorker(testWorkers[0]), // producer
      makeRunnableWorker(testWorkers[1]), // openhands - no website.build
    ];
    const limitedRegistry = new InMemoryWorkerRegistry(limitedWorkers);
    
    const selector = new IndependentReviewerSelector(limitedRegistry, producerId, ["website.build"]);
    
    const result = selector.select();
    
    // openhands doesn't have website.build capability, so no eligible reviewers
    expect(result.success).toBe(false);
    expect(result.decision).toBe("NO_ELIGIBLE_REVIEWERS");
  });

  test("select is deterministic - same input produces same output", () => {
    const producerId = runnableWorkers[0].id;
    
    const selector1 = new IndependentReviewerSelector(registry, producerId, ["website.build"]);
    const selector2 = new IndependentReviewerSelector(registry, producerId, ["website.build"]);
    
    const result1 = selector1.select();
    const result2 = selector2.select();
    
    expect(result1.reviewerWorkerId).toBe(result2.reviewerWorkerId);
  });

  test("select filters out inactive workers", () => {
    const inactiveWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "inactive-reviewer-001",
      status: "inactive",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...runnableWorkers,
      inactiveWorker,
    ]);
    
    const producerId = runnableWorkers[1].id; // openhands
    
    const selector = new IndependentReviewerSelector(mixedRegistry, producerId, ["code-generation"]);
    
    const result = selector.select();
    
    // Should not select the inactive worker
    expect(result.reviewerWorkerId).not.toBe("inactive-reviewer-001");
  });

  test("select filters out workers with unknown runtime support", () => {
    const unknownRuntimeWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "unknown-runtime-reviewer-001",
      runtimeSupport: "UNKNOWN",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...runnableWorkers,
      unknownRuntimeWorker,
    ]);
    
    const producerId = runnableWorkers[1].id; // openhands
    
    const selector = new IndependentReviewerSelector(mixedRegistry, producerId, ["search"]);
    
    const result = selector.select();
    
    expect(result.reviewerWorkerId).not.toBe("unknown-runtime-reviewer-001");
  });

  test("select filters out unhealthy workers", () => {
    const unhealthyWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "unhealthy-reviewer-001",
      health: "unhealthy",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...runnableWorkers,
      unhealthyWorker,
    ]);
    
    const producerId = runnableWorkers[1].id; // openhands
    
    const selector = new IndependentReviewerSelector(mixedRegistry, producerId, ["search"]);
    
    const result = selector.select();
    
    expect(result.reviewerWorkerId).not.toBe("unhealthy-reviewer-001");
  });

  test("select filters out unavailable workers", () => {
    const unavailableWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "unavailable-reviewer-001",
      availability: "unavailable",
    };
    
    const mixedRegistry = new InMemoryWorkerRegistry([
      ...runnableWorkers,
      unavailableWorker,
    ]);
    
    const producerId = runnableWorkers[1].id; // openhands
    
    const selector = new IndependentReviewerSelector(mixedRegistry, producerId, ["search"]);
    
    const result = selector.select();
    
    expect(result.reviewerWorkerId).not.toBe("unavailable-reviewer-001");
  });

  test("select filters out workers with unknown health (fail closed)", () => {
    const unknownHealthWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "unknown-health-reviewer-001",
      health: "unknown",
    };

    const mixedRegistry = new InMemoryWorkerRegistry([
      ...runnableWorkers,
      unknownHealthWorker,
    ]);

    const producerId = runnableWorkers[1].id; // openhands

    const selector = new IndependentReviewerSelector(mixedRegistry, producerId, ["search"]);

    const result = selector.select();

    expect(result.reviewerWorkerId).not.toBe("unknown-health-reviewer-001");
  });

  test("select filters out workers with unknown availability (fail closed)", () => {
    const unknownAvailabilityWorker: WorkerRegistryEntry = {
      ...makeRunnableWorker(testWorkers[0]),
      id: "unknown-availability-reviewer-001",
      availability: "unknown",
    };

    const mixedRegistry = new InMemoryWorkerRegistry([
      ...runnableWorkers,
      unknownAvailabilityWorker,
    ]);

    const producerId = runnableWorkers[1].id; // openhands

    const selector = new IndependentReviewerSelector(mixedRegistry, producerId, ["search"]);

    const result = selector.select();

    expect(result.reviewerWorkerId).not.toBe("unknown-availability-reviewer-001");
  });

  test("self-review denied - selector excludes producer from eligible reviewers", () => {
    const producerId = runnableWorkers[0].id;

    // Create registry with ONLY the producer worker matching capability
    const limitedWorkers = [
      makeRunnableWorker(testWorkers[0]), // producer with website.build
      makeRunnableWorker(testWorkers[1]), // openhands - no website.build
    ];
    const limitedRegistry = new InMemoryWorkerRegistry(limitedWorkers);

    const selector = new IndependentReviewerSelector(limitedRegistry, producerId, ["website.build"]);

    const result = selector.select();

    // Producer is excluded, openhands doesn't have website.build capability
    expect(result.success).toBe(false);
    expect(result.decision).toBe("NO_ELIGIBLE_REVIEWERS");
  });
});

describe("assertReviewerIndependence", () => {
  let registry: InMemoryWorkerRegistry;
  let runnableWorkers: WorkerRegistryEntry[];

  beforeEach(() => {
    vi.restoreAllMocks();
    runnableWorkers = testWorkers.map(makeRunnableWorker);
    registry = new InMemoryWorkerRegistry(runnableWorkers);
  });

  test("throws when check is not independent", () => {
    const producerId = runnableWorkers[0].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: producerId, // self-review
    });
    
    const check = checker.check();
    
    expect(() => assertReviewerIndependence(check, "Test Review")).toThrow("Test Review blocked: Self-review denied");
  });

  test("does not throw when check is independent", () => {
    const producerId = runnableWorkers[0].id;
    const reviewerId = runnableWorkers[1].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: reviewerId,
    });
    
    const check = checker.check();
    
    expect(() => assertReviewerIndependence(check, "Test Review")).not.toThrow();
  });
});

describe("requireIndependentReviewer", () => {
  let registry: InMemoryWorkerRegistry;
  let runnableWorkers: WorkerRegistryEntry[];

  beforeEach(() => {
    vi.restoreAllMocks();
    runnableWorkers = testWorkers.map(makeRunnableWorker);
    registry = new InMemoryWorkerRegistry(runnableWorkers);
  });

  test("returns reviewer identity when independent", () => {
    const producerId = runnableWorkers[0].id;
    const reviewerId = runnableWorkers[1].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: reviewerId,
    });
    
    const check = checker.check();
    
    const reviewer = requireIndependentReviewer(check, "Test Review");
    
    expect(reviewer.workerId).toBe(reviewerId);
    expect(reviewer.workerKind).toBe("openhands");
  });

  test("throws when check is not independent", () => {
    const producerId = runnableWorkers[0].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: producerId,
    });
    
    const check = checker.check();
    
    expect(() => requireIndependentReviewer(check, "Test Review")).toThrow("Test Review requires independent reviewer");
  });

  test("throws when reviewer identity is null", () => {
    const producerId = runnableWorkers[0].id;
    
    const checker = new ReviewerIndependenceChecker({
      workerRegistry: registry,
      producerWorkerId: producerId,
      reviewerWorkerId: null,
    });
    
    const check = checker.check();
    
    expect(() => requireIndependentReviewer(check, "Test Review")).toThrow("Test Review requires independent reviewer: Reviewer identity missing or unknown");
  });
});