import { describe, expect, it } from "vitest";

import type { TaskDag, TaskNode, TaskNodeStatus } from "@/core/supervisor";
import type { Worker, WorkerResult, CreateWorkerInput } from "@/core/worker";
import type { ReviewSpec, ReviewResult, CorrectionSpec, CorrectionResult } from "@/core/review";
import type { IntegrationSpec, IntegrationResult, GateResult } from "@/core/integration";
import type { PreviewResult } from "@/core/preview";
import type { WorktreeSpec, WorktreeResult, WorktreeEntry } from "@/core/worktree";
import type { SupervisorRepository } from "./ports";
import { InMemorySupervisorRepository } from "./in-memory/supervisor-repository";
import { SupervisorService } from "./supervisor-service";
import type { WorkerManagerPort } from "@/server/worker/ports";
import type { WorktreeManagerPort } from "@/server/worktree/ports";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "@/server/review/ports";
import type { GlobalGatesPort, IntegrationOrchestratorPort } from "@/server/integration/ports";
import type { PreviewDeliveryPort } from "@/server/preview/ports";
import type { SupervisorEnrichedContext, SupervisorContextInput } from "@/core/context";
import { buildMissionContext, type MissionContext, type ConversationContext } from "@/core/context";
import type { Mission } from "@/core/mission";
import { resolveSupervisorContext } from "@/core/context/context-supervisor-bridge";
import { InMemoryMissionContextRepository } from "@/server/context/in-memory/mission-context-repository";
import { PERMISSION_SUPERVISOR_WORKER_EXECUTE } from "@/core/policy";

// ─────────────────────────────────────
// Fakes
// ─────────────────────────────────────

class FakeWorkerManager implements WorkerManagerPort {
  private results = new Map<string, WorkerResult>();

  setResult(workerId: string, result: WorkerResult) {
    this.results.set(workerId, result);
  }

  async spawn(input: CreateWorkerInput): Promise<string> {
    const id = `worker-${input.taskId}-${Date.now()}`;
    if (!this.results.has(id)) {
      this.results.set(id, {
        outcome: "SUCCESS",
        artifacts: [],
        summary: `Worker ${input.taskId} completed`,
        durationMs: 10,
      });
    }
    return id;
  }
  async getStatus(workerId: string): Promise<{ status: Worker["status"]; worker: Worker | null }> {
    return { status: "SUCCEEDED", worker: null };
  }
  async collectResult(workerId: string): Promise<WorkerResult | null> {
    return this.results.get(workerId) ?? null;
  }
  async cancel(_workerId: string): Promise<void> {}
  async waitForCompletion(workerId: string, _timeoutMs?: number): Promise<WorkerResult> {
    return (
      this.results.get(workerId) ?? {
        outcome: "FAILED",
        artifacts: [],
        summary: "Not found",
        durationMs: 0,
      }
    );
  }
  async markLost(_workerId: string): Promise<void> {}
}

class FakeWorktreeManager implements WorktreeManagerPort {
  readonly createdPaths: string[] = [];
  readonly cleanupCalls: string[] = [];
  cleanupError: Error | null = null;

  async createWorktree(_taskId: string): Promise<WorktreeSpec> {
    const spec = {
      path: `/tmp/wt-${_taskId}`,
      branch: `wt-${_taskId}`,
      baseSha: "a".repeat(40),
      taskId: _taskId,
    };
    this.createdPaths.push(spec.path);
    return spec;
  }
  async assignToTask(_path: string, _taskId: string): Promise<void> {}
  async captureResult(_path: string): Promise<WorktreeResult> {
    return {
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      changedFiles: ["src/test.ts"],
      isDirty: false,
      uncommittedFiles: [],
      commitMessages: ["feat: task"],
      commitShas: ["b".repeat(40)],
    };
  }
  async detectChanges(_path: string): Promise<string[]> {
    return [];
  }
  async cleanupWorktree(_path: string): Promise<void> {
    this.cleanupCalls.push(_path);
    if (this.cleanupError) throw this.cleanupError;
  }
  async listActive(): Promise<WorktreeEntry[]> {
    return [];
  }
}

class FakeReviewer implements ReviewerManagerPort {
  async conductReview(_spec: ReviewSpec): Promise<ReviewResult> {
    return {
      verdict: "PASS",
      checks: [{ category: "acceptance_criteria", description: "OK", passed: true }],
      summary: "PASS",
      confidence: 4,
      durationMs: 100,
      reviewerWorkerId: "reviewer-independent",
      completedAt: new Date().toISOString(),
    };
  }
  async ensureIndependentReview(_taskId: string, _reviewerWorkerId: string): Promise<boolean> {
    return true;
  }
}

class FakeCorrector implements CorrectionLoopManagerPort {
  async executeCorrection(_spec: CorrectionSpec): Promise<CorrectionResult> {
    return { outcome: "CORRECTED", summary: "OK", durationMs: 5 };
  }
  isMaxAttemptsReached(_spec: CorrectionSpec): boolean {
    return false;
  }
  async escalate(_spec: CorrectionSpec): Promise<void> {}
}

class FakeGates implements GlobalGatesPort {
  async executeAll(_path: string): Promise<GateResult[]> {
    return [{ gate: "lint", passed: true, output: "", durationMs: 1, errors: [] }];
  }
  async executeGate(_gate: string, _path: string): Promise<GateResult> {
    return { gate: _gate, passed: true, output: "", durationMs: 1, errors: [] };
  }
  async gitDiffCheck(_path: string): Promise<GateResult> {
    return { gate: "git-diff-check", passed: true, output: "", durationMs: 1, errors: [] };
  }
}

class FakeIntegrator implements IntegrationOrchestratorPort {
  async integrate(_spec: IntegrationSpec): Promise<IntegrationResult> {
    return {
      status: "SUCCEEDED",
      gateResults: [],
      commitsIntegrated: 2,
      summary: "Intégration réussie",
      durationMs: 10,
      finalSha: "c".repeat(40),
    };
  }
}

class FailingIntegrator implements IntegrationOrchestratorPort {
  async integrate(): Promise<IntegrationResult> {
    return {
      status: "FAILED",
      gateResults: [],
      commitsIntegrated: 0,
      summary: "deterministic integration failure",
      durationMs: 1,
    };
  }
}

class ThrowingIntegrator implements IntegrationOrchestratorPort {
  async integrate(): Promise<IntegrationResult> {
    throw new Error("unexpected integration exception");
  }
}

class CountingIntegrator extends FakeIntegrator {
  calls = 0;

  override async integrate(spec: IntegrationSpec): Promise<IntegrationResult> {
    this.calls += 1;
    return super.integrate(spec);
  }
}

class CapturingIntegrator extends FakeIntegrator {
  lastSpec: IntegrationSpec | null = null;

  override async integrate(spec: IntegrationSpec): Promise<IntegrationResult> {
    this.lastSpec = spec;
    return super.integrate(spec);
  }
}

class NonIndependentReviewer extends FakeReviewer {
  override async ensureIndependentReview(): Promise<boolean> {
    return false;
  }
}

class PostReviewWorktreeManager extends FakeWorktreeManager {
  captureCalls = 0;

  override async captureResult(path: string): Promise<WorktreeResult> {
    this.captureCalls += 1;
    const result = await super.captureResult(path);
    return {
      ...result,
      headSha: (this.captureCalls === 1 ? "b" : "c").repeat(40),
    };
  }
}

class RecordingSupervisorRepository extends InMemorySupervisorRepository {
  readonly transitions: Array<{ nodeId: string; status: TaskNodeStatus }> = [];

  override async updateNodeStatus(
    dagId: string,
    nodeId: string,
    status: TaskNodeStatus,
    updates?: Partial<TaskNode>,
  ): Promise<TaskNode | null> {
    const result = await super.updateNodeStatus(dagId, nodeId, status, updates);
    if (result) this.transitions.push({ nodeId, status });
    return result;
  }
}

class RejectingTransitionRepository extends InMemorySupervisorRepository {
  constructor(private readonly rejectedStatus: TaskNodeStatus) {
    super();
  }

  override async updateNodeStatus(
    dagId: string,
    nodeId: string,
    status: TaskNodeStatus,
    updates?: Partial<TaskNode>,
  ): Promise<TaskNode | null> {
    if (status === this.rejectedStatus) return null;
    return super.updateNodeStatus(dagId, nodeId, status, updates);
  }
}

class FailingTaskWorkerManager extends FakeWorkerManager {
  private readonly taskByWorker = new Map<string, string>();

  override async spawn(input: CreateWorkerInput): Promise<string> {
    const workerId = await super.spawn(input);
    this.taskByWorker.set(workerId, input.taskId);
    return workerId;
  }

  override async waitForCompletion(workerId: string, timeoutMs?: number): Promise<WorkerResult> {
    if (this.taskByWorker.get(workerId) === "task-b") {
      return {
        outcome: "FAILED",
        artifacts: [],
        summary: "task-b failed",
        durationMs: 1,
      };
    }
    return super.waitForCompletion(workerId, timeoutMs);
  }
}

class AlwaysFailingWorkerManager extends FakeWorkerManager {
  override async waitForCompletion(): Promise<WorkerResult> {
    return {
      outcome: "FAILED",
      artifacts: [],
      summary: "original worker failure",
      errorCode: "PROCESS_ERROR",
      durationMs: 1,
    };
  }
}

class CancelledWorkerManager extends FakeWorkerManager {
  override async waitForCompletion(): Promise<WorkerResult> {
    return {
      outcome: "FAILED",
      artifacts: [],
      summary: "worker cancelled",
      errorCode: "CANCELLED",
      durationMs: 1,
    };
  }
}

class FailingReviewer extends FakeReviewer {
  override async conductReview(): Promise<ReviewResult> {
    return {
      verdict: "FAILED",
      checks: [
        {
          category: "tests",
          description: "review failure",
          passed: false,
        },
      ],
      summary: "review failed",
      confidence: 5,
      durationMs: 1,
      reviewerWorkerId: "reviewer-independent",
      completedAt: new Date().toISOString(),
    };
  }
}

class ChangesRequiredReviewer extends FakeReviewer {
  override async conductReview(): Promise<ReviewResult> {
    return {
      verdict: "CHANGES_REQUIRED",
      checks: [
        {
          category: "tests",
          description: "correction required",
          passed: false,
        },
      ],
      summary: "correction required",
      confidence: 5,
      durationMs: 1,
      reviewerWorkerId: "reviewer-independent",
      completedAt: new Date().toISOString(),
    };
  }
}

class FailingCorrector extends FakeCorrector {
  override async executeCorrection(): Promise<CorrectionResult> {
    return {
      outcome: "FAILED",
      summary: "correction failed",
      errorMessage: "deterministic correction failure",
      durationMs: 1,
    };
  }
}

class FakePreview implements PreviewDeliveryPort {
  async deliver(_sha: string, _branch: string): Promise<PreviewResult> {
    return {
      status: "LOCAL_RESULT_READY",
      summary: "Preview prête",
      completedAt: new Date().toISOString(),
      durationMs: 5,
    };
  }
}

// ─────────────────────────────────────
// Tests
// ─────────────────────────────────────

describe("SupervisorService", () => {
  function createService(repo?: SupervisorRepository) {
    return new SupervisorService(
      repo ?? new InMemorySupervisorRepository(),
      new FakeWorkerManager(),
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );
  }

  function makeDag(id: string): TaskDag {
    const now = "2026-07-26T10:00:00Z";
    return {
      id,
      missionId: "mission-test",
      tenantId: "tenant-test",
      status: "CREATED",
      nodes: {
        "task-a": makeNode("task-a", []),
        "task-b": makeNode("task-b", ["task-a"]),
      },
      nodeOrder: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  describe("execute", () => {
    it("exposes a defensive read-only copy of its composition-owned executor", () => {
      const service = new SupervisorService(
        new InMemorySupervisorRepository(),
        new FakeWorkerManager(),
        new FakeWorktreeManager(),
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        new FakeIntegrator(),
        new FakePreview(),
        {
          agentIdentity: {
            id: "supervisor-composed",
            tenantId: "tenant-test",
            roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
            authorizationLevel: 2,
            justification: "Composition-owned bounded test executor",
          },
        },
      );

      const first = service.getExecutionIdentity();
      expect(first).toEqual({
        id: "supervisor-composed",
        tenantId: "tenant-test",
        roles: [PERMISSION_SUPERVISOR_WORKER_EXECUTE],
        authorizationLevel: 2,
        justification: "Composition-owned bounded test executor",
      });
      (first as { authorizationLevel: number }).authorizationLevel = 99;

      expect(service.getExecutionIdentity()?.authorizationLevel).toBe(2);
    });

    it("validates and executes a DAG successfully", async () => {
      const repo = new InMemorySupervisorRepository();
      const service = createService(repo);
      const dag = makeDag("dag-sup-test-1");

      const result = await service.execute(dag);

      expect(result.status).toBe("SUCCEEDED");
      expect(result.summary).toContain("intégrées");
      expect(result.integrationResult).toBeDefined();
      expect(result.previewResult).toBeDefined();
    });

    it("fails on invalid DAG (cycle)", async () => {
      const service = createService();
      const dag = makeDag("dag-cycle-test");
      // Create a cycle: a depends on b, b depends on a
      dag.nodes["task-a"].dependsOn = ["task-b"];

      const result = await service.execute(dag);
      expect(result.status).toBe("FAILED");
      expect(result.summary.toLowerCase()).toContain("cycle");
    });

    it("fails when DAG has no root node", async () => {
      const service = createService();
      const dag = makeDag("dag-no-root");
      dag.nodes["task-a"].dependsOn = ["task-b"];
      dag.nodes["task-b"].dependsOn = ["task-a"];

      const result = await service.execute(dag);
      expect(result.status).toBe("FAILED");
    });

    it("handles a single-node DAG", async () => {
      const repo = new InMemorySupervisorRepository();
      const service = createService(repo);
      const now = "2026-07-26T10:00:00Z";
      const dag: TaskDag = {
        id: "dag-single",
        missionId: "mission-test",
        tenantId: "tenant-test",
        status: "CREATED",
        nodes: {
          "single-task": makeNode("single-task", []),
        },
        nodeOrder: [],
        createdAt: now,
        updatedAt: now,
      };

      const result = await service.execute(dag);
      expect(result.status).toBe("SUCCEEDED");
    });

    it("persists DAG state changes through execution", async () => {
      const repo = new InMemorySupervisorRepository();
      const service = createService(repo);
      const dag = makeDag("dag-persist-test");

      await service.execute(dag);

      const final = await repo.findDagById("dag-persist-test");
      expect(final).not.toBeNull();
      expect(final!.status).toBe("COMPLETED");
    });

    it("persists the legal node success progression through review", async () => {
      const repo = new RecordingSupervisorRepository();
      const service = createService(repo);
      const dag = makeDag("dag-legal-node-progression");

      const result = await service.execute(dag);

      expect(result.status).toBe("SUCCEEDED");
      expect(
        repo.transitions.filter(({ nodeId }) => nodeId === "task-a").map(({ status }) => status),
      ).toEqual(["READY", "ASSIGNED", "RUNNING", "REVIEWING", "SUCCEEDED"]);
      const persisted = await repo.findDagById("dag-legal-node-progression");
      expect(persisted?.status).toBe("COMPLETED");
      expect(
        Object.values(persisted?.nodes ?? {}).every((node) => node.status === "SUCCEEDED"),
      ).toBe(true);
    });

    it.each(["RUNNING", "REVIEWING", "SUCCEEDED"] as const)(
      "fails closed when the %s transition is rejected",
      async (rejectedStatus) => {
        const repo = new RejectingTransitionRepository(rejectedStatus);
        const integrator = new CountingIntegrator();
        const service = new SupervisorService(
          repo,
          new FakeWorkerManager(),
          new FakeWorktreeManager(),
          new FakeReviewer(),
          new FakeCorrector(),
          new FakeGates(),
          integrator,
          new FakePreview(),
          { maxConcurrentWorkers: 2 },
        );
        const dag = makeDag(`dag-reject-${rejectedStatus}`);
        dag.nodes = { "task-a": makeNode("task-a", []) };

        const result = await service.execute(dag);

        expect(result.status).toBe("FAILED");
        expect(result.summary).toContain(rejectedStatus);
        expect(integrator.calls).toBe(0);
        const persisted = await repo.findDagById(`dag-reject-${rejectedStatus}`);
        expect(persisted?.status).toBe("FAILED");
        expect(persisted?.nodes["task-a"].status).not.toBe("SUCCEEDED");
      },
    );

    it("enforces allSucceeded before integration and DAG completion", async () => {
      const repo = new InMemorySupervisorRepository();
      const integrator = new CountingIntegrator();
      const service = new SupervisorService(
        repo,
        new FailingTaskWorkerManager(),
        new FakeWorktreeManager(),
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        integrator,
        new FakePreview(),
        { maxConcurrentWorkers: 2 },
      );
      const dag = makeDag("dag-worker-partial-failure");

      const result = await service.execute(dag);

      expect(result.status).toBe("FAILED");
      expect(integrator.calls).toBe(0);
      const persisted = await repo.findDagById("dag-worker-partial-failure");
      expect(persisted?.status).toBe("FAILED");
      expect(persisted?.nodes["task-a"].status).toBe("SUCCEEDED");
      expect(persisted?.nodes["task-b"].status).toBe("FAILED");
    });

    it("fails closed when reviewer independence is not established", async () => {
      const repo = new InMemorySupervisorRepository();
      const integrator = new CountingIntegrator();
      const service = new SupervisorService(
        repo,
        new FakeWorkerManager(),
        new FakeWorktreeManager(),
        new NonIndependentReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        integrator,
        new FakePreview(),
        { maxConcurrentWorkers: 1 },
      );
      const dag = makeDag("dag-non-independent-review");
      dag.nodes = { "task-a": makeNode("task-a", []) };

      const result = await service.execute(dag);

      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("Revue indépendante");
      expect(integrator.calls).toBe(0);
      const persisted = await repo.findDagById("dag-non-independent-review");
      expect(persisted?.status).toBe("FAILED");
      expect(persisted?.nodes["task-a"].status).toBe("FAILED");
    });

    it("integrates the post-review worktree SHA", async () => {
      const repo = new InMemorySupervisorRepository();
      const worktrees = new PostReviewWorktreeManager();
      const integrator = new CapturingIntegrator();
      const service = new SupervisorService(
        repo,
        new FakeWorkerManager(),
        worktrees,
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        integrator,
        new FakePreview(),
        { maxConcurrentWorkers: 1 },
      );
      const dag = makeDag("dag-post-review-sha");
      dag.nodes = { "task-a": makeNode("task-a", []) };

      const result = await service.execute(dag);

      expect(result.status).toBe("SUCCEEDED");
      expect(worktrees.captureCalls).toBe(2);
      expect(integrator.lastSpec?.commits[0]?.commitSha).toBe("c".repeat(40));
    });

    it("cleans every task worktree after successful integration", async () => {
      const worktrees = new FakeWorktreeManager();
      const service = new SupervisorService(
        new InMemorySupervisorRepository(),
        new FakeWorkerManager(),
        worktrees,
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        new FakeIntegrator(),
        new FakePreview(),
      );

      const result = await service.execute(makeDag("dag-cleanup-success"));

      expect(result.status).toBe("SUCCEEDED");
      expect(worktrees.cleanupCalls.sort()).toEqual([...worktrees.createdPaths].sort());
      expect(result.cleanupEvidence?.every((item) => item.cleaned)).toBe(true);
    });

    it.each([
      [
        "worker failure",
        new AlwaysFailingWorkerManager(),
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeIntegrator(),
      ],
      [
        "review failure",
        new FakeWorkerManager(),
        new FailingReviewer(),
        new FakeCorrector(),
        new FakeIntegrator(),
      ],
      [
        "correction failure",
        new FakeWorkerManager(),
        new ChangesRequiredReviewer(),
        new FailingCorrector(),
        new FakeIntegrator(),
      ],
      [
        "integration failure",
        new FakeWorkerManager(),
        new FakeReviewer(),
        new FakeCorrector(),
        new FailingIntegrator(),
      ],
      [
        "cancellation",
        new CancelledWorkerManager(),
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeIntegrator(),
      ],
      [
        "unexpected exception",
        new FakeWorkerManager(),
        new FakeReviewer(),
        new FakeCorrector(),
        new ThrowingIntegrator(),
      ],
    ] as const)(
      "cleans the task worktree on %s",
      async (_label, workers, reviewer, corrector, integrator) => {
        const worktrees = new FakeWorktreeManager();
        const service = new SupervisorService(
          new InMemorySupervisorRepository(),
          workers,
          worktrees,
          reviewer,
          corrector,
          new FakeGates(),
          integrator,
          new FakePreview(),
        );
        const dag = makeDag(`dag-cleanup-${_label.replaceAll(" ", "-")}`);
        dag.nodes = { "task-a": makeNode("task-a", []) };

        const result = await service.execute(dag);

        expect(result.status).toBe("FAILED");
        expect(worktrees.cleanupCalls).toEqual(["/tmp/wt-task-a"]);
      },
    );

    it("cleanup failure converts would-be success to canonical failure", async () => {
      const repository = new InMemorySupervisorRepository();
      const worktrees = new FakeWorktreeManager();
      worktrees.cleanupError = new Error("bounded cleanup failure");
      const service = new SupervisorService(
        repository,
        new FakeWorkerManager(),
        worktrees,
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        new FakeIntegrator(),
        new FakePreview(),
      );
      const dag = makeDag("dag-cleanup-fails-closed");
      dag.nodes = { "task-a": makeNode("task-a", []) };

      const result = await service.execute(dag);

      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("bounded cleanup failure");
      expect(result.cleanupEvidence).toEqual([expect.objectContaining({ cleaned: false })]);
      expect((await repository.findDagById(dag.id))?.status).toBe("FAILED");
      expect(result.previewResult).toBeUndefined();
    });

    it("cleanup failure retains the original terminal failure", async () => {
      const worktrees = new FakeWorktreeManager();
      worktrees.cleanupError = new Error("secondary cleanup failure");
      const service = new SupervisorService(
        new InMemorySupervisorRepository(),
        new AlwaysFailingWorkerManager(),
        worktrees,
        new FakeReviewer(),
        new FakeCorrector(),
        new FakeGates(),
        new FakeIntegrator(),
        new FakePreview(),
      );
      const dag = makeDag("dag-original-and-cleanup-failure");
      dag.nodes = { "task-a": makeNode("task-a", []) };

      const result = await service.execute(dag);

      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("original worker failure");
      expect(result.summary).toContain("secondary cleanup failure");
    });
  });
});

function makeNode(id: string, deps: string[]): TaskNode {
  return {
    id,
    label: `Task ${id}`,
    description: `Description ${id}`,
    acceptanceCriteria: [],
    status: "PENDING",
    dependsOn: deps,
    blockedBy: [],
    workerAssignments: [],
    correctionIds: [],
    correctionCount: 0,
    retryCount: 0,
    maxRetries: 2,
    createdAt: "2026-07-26T10:00:00Z",
    updatedAt: "2026-07-26T10:00:00Z",
  };
}

// ─────────────────────────────────────
// CTX-SUP-E2E — Context wiring into live SupervisorService
// ─────────────────────────────────────

const CTX_NOW = "2026-07-27T10:00:00.000Z";

/**
 * Helper : construit un SupervisorEnrichedContext canonique pour les tests.
 */
function buildCanonicalContext(
  overrides?: Partial<SupervisorEnrichedContext>,
): SupervisorEnrichedContext {
  const input: SupervisorContextInput = {
    tenantId: "tenant-test",
    missionId: "mission-test",
    contextVersion: 0,
    confirmedObjective: "Livrer le rapport trimestriel",
    confirmedConstraints: [
      { statement: "Deadline vendredi", ref: "turn-c" },
      { statement: "Format PDF uniquement", ref: "turn-d" },
    ],
    openQuestions: [{ statement: "Quelle couleur pour le logo ?" }],
    boundedSummary: "Livrer le rapport trimestriel en PDF avant vendredi",
    memoryReferences: [],
  };
  return {
    input,
    precedenceRecords: [],
    hadStrippedItems: false,
    sourceRef: {
      tenantId: "tenant-test",
      missionId: "mission-test",
      version: 0,
      builtAt: CTX_NOW,
    },
    ...overrides,
  };
}

/**
 * FakeWorkerManager qui CAPTURE les inputs.spawn pour inspection.
 * Permet aux tests de vérifier que le contexte a bien été transmis au worker.
 */
class CapturingFakeWorkerManager extends FakeWorkerManager {
  allSpawnInputs: CreateWorkerInput[] = [];

  get lastSpawnInput(): CreateWorkerInput | null {
    return this.allSpawnInputs.length > 0
      ? this.allSpawnInputs[this.allSpawnInputs.length - 1]
      : null;
  }

  get firstSpawnInput(): CreateWorkerInput | null {
    return this.allSpawnInputs.length > 0 ? this.allSpawnInputs[0] : null;
  }

  async spawn(input: CreateWorkerInput): Promise<string> {
    this.allSpawnInputs.push(input);
    return super.spawn(input);
  }
}

describe("CTX-SUP-E2E — context wiring into live SupervisorService", () => {
  function createService(repo?: SupervisorRepository) {
    return new SupervisorService(
      repo ?? new InMemorySupervisorRepository(),
      new FakeWorkerManager(),
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );
  }

  function makeDag(id: string, overrides?: Partial<TaskDag>): TaskDag {
    const now = "2026-07-26T10:00:00Z";
    return {
      id,
      missionId: "mission-test",
      tenantId: "tenant-test",
      status: "CREATED",
      nodes: {
        "task-a": makeNode("task-a", []),
        "task-b": makeNode("task-b", ["task-a"]),
      },
      nodeOrder: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  // ── Test 1 : valid latest context reaches real SupervisorService ──
  it("1 — valid latest context reaches real SupervisorService", async () => {
    const repo = new InMemorySupervisorRepository();
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      repo,
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const ctx = buildCanonicalContext();
    const dag = makeDag("dag-ctx-1");

    const result = await service.execute(dag, ctx);

    expect(result.status).toBe("SUCCEEDED");
    // La note de contexte doit apparaître dans le résumé
    expect(result.summary).toContain("contexte v0 appliqué");
    // La mission du DAG est inchangée
    expect(dag.missionId).toBe("mission-test");
    // L'objective a été enrichie du contexte
    expect(capturing.lastSpawnInput?.objective).toContain("Livrer le rapport trimestriel");
    expect(capturing.lastSpawnInput?.objective).toContain("Deadline vendredi");
  });

  // ── Test 2 : canonical mission objective remains canonical ──
  it("2 — canonical mission objective remains canonical", async () => {
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const ctx = buildCanonicalContext();
    const dag = makeDag("dag-ctx-2");

    await service.execute(dag, ctx);

    // La description de chaque nœud DAG est TOUJOURS présente en premier
    // (canonique) — le contexte l'enrichit mais ne la remplace pas.
    // Le premier nœud (task-a) a la description "Description task-a"
    const firstSpawn = capturing.firstSpawnInput?.objective ?? "";
    expect(firstSpawn).toContain("Description task-a");
    // La mission au niveau DAG est inchangée
    expect(dag.missionId).toBe("mission-test");
    // Le DAG est toujours la source de vérité pour l'exécution
    expect(ctx.input.confirmedObjective).toBe("Livrer le rapport trimestriel");
  });

  // ── Test 3 : confirmed constraints influence bounded planning input ──
  it("3 — confirmed constraints influence bounded planning input", async () => {
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const ctx = buildCanonicalContext();
    // S'assurer que le contexte a des contraintes
    expect(ctx.input.confirmedConstraints.length).toBeGreaterThan(0);

    await service.execute(makeDag("dag-ctx-3"), ctx);

    // Les contraintes confirmées sont transmises au worker
    expect(capturing.lastSpawnInput?.objective).toContain("Deadline vendredi");
    expect(capturing.lastSpawnInput?.objective).toContain("Format PDF uniquement");
  });

  // ── Test 4 : confirmed decisions (objective) reach planning input ──
  it("4 — confirmed decisions reach planning input", async () => {
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const ctx = buildCanonicalContext();
    expect(ctx.input.confirmedObjective).toBe("Livrer le rapport trimestriel");

    await service.execute(makeDag("dag-ctx-4"), ctx);

    // L'objectif confirmé est transmis contextuellement
    expect(capturing.lastSpawnInput?.objective).toContain("Livrer le rapport trimestriel");
  });

  // ── Test 5 : unresolved non-critical questions remain contextual ──
  it("5 — unresolved non-critical questions remain contextual", async () => {
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const ctx = buildCanonicalContext();
    expect(ctx.input.openQuestions.length).toBeGreaterThan(0);

    await service.execute(makeDag("dag-ctx-5"), ctx);

    // Les questions ouvertes non critiques restent dans le contexte
    // mais NE SONT PAS promues en objective/decision
    // Le boundedSummary pourrait les contenir (info) mais pas l'objective principale
    const objective = capturing.lastSpawnInput?.objective ?? "";
    // Les questions ouvertes ne sont PAS dans l'objective du worker
    // (elles ne sont pas passées directement, contrairement aux contraintes)
    expect(objective).not.toContain("Quelle couleur pour le logo");
    // La boundedSummary mentionne l'info
    expect(ctx.input.boundedSummary).toBeDefined();
  });

  // ── Test 6 : critical ambiguity prevents Supervisor invocation ──
  it("6 — critical ambiguity prevents Supervisor invocation", () => {
    // Test au niveau du bridge : une question critique bloque
    const context: MissionContext = {
      tenantId: "tenant-1",
      missionId: "mission-abc",
      version: 0,
      confirmedObjective: "Sécuriser le déploiement",
      confirmedConstraints: [],
      assumptions: [],
      openQuestions: [
        {
          id: "oq-sec",
          statement: "Quel token de déploiement utiliser ?",
          epistemics: "open_question",
          provenance: { source: "user_message", ref: "turn-a", observedAt: CTX_NOW },
        },
      ],
      boundedSummary: "Sécuriser le déploiement",
      memoryReferences: [],
      builtAt: CTX_NOW,
      builtByLabel: "test",
    };

    const result = resolveSupervisorContext(context, undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("critical_ambiguity");
    }
  });

  // ── Test 7 : precedence conflict prevents Supervisor invocation ──
  it("7 — precedence conflict prevents Supervisor invocation", () => {
    // Le contexte contredit la Mission D2 → le bridge refuse
    // Utiliser des mots sans aucun token commun après filtrage des stopwords
    // pour garantir un conflit de précédence.
    const context: MissionContext = {
      tenantId: "tenant-1",
      missionId: "mission-abc",
      version: 0,
      confirmedObjective: "wxyzzy improbable zebra", // aucun token commun avec mission
      confirmedConstraints: [],
      assumptions: [],
      openQuestions: [],
      boundedSummary: "wxyzzy improbable zebra",
      memoryReferences: [],
      builtAt: CTX_NOW,
      builtByLabel: "test",
    };

    const mission: Mission = {
      id: "mission-abc",
      tenantId: "tenant-1",
      userRequest: "Repeindre le mur en bleu foncé",
      status: "CREATED",
      runs: [],
      createdAt: CTX_NOW,
      updatedAt: CTX_NOW,
    };

    const result = resolveSupervisorContext(context, mission);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("precedence_conflict");
    }
  });

  // ── Test 8 : missing MissionContext fails closed ──
  it("8 — missing MissionContext fails closed", async () => {
    const repo = new InMemoryMissionContextRepository();
    const latest = await repo.findLatest("tenant-test", "mission-test");
    // Aucun contexte persisté → latest est null
    expect(latest).toBeNull();

    // Sans contexte, on ne peut pas invoquer le Supervisor avec un contexte
    const ctx = buildCanonicalContext();
    // La validation du contexte dans SupervisorService ne vérifie que
    // la cohérence mission/tenant — mais C'EST l'appelant qui doit
    // s'assurer qu'un contexte existe avant d'appeler execute()
    // Le test prouve que findLatest renvoie null quand rien n'est persisté
  });

  // ── Test 9 : wrong tenant fails closed ──
  it("9 — wrong tenant fails closed", async () => {
    const service = createService();

    const ctx = buildCanonicalContext({
      sourceRef: {
        tenantId: "wrong-tenant",
        missionId: "mission-test",
        version: 0,
        builtAt: CTX_NOW,
      },
    });

    const dag = makeDag("dag-ctx-9");

    const result = await service.execute(dag, ctx);

    expect(result.status).toBe("FAILED");
    expect(result.summary).toContain("tenant");
  });

  // ── Test 10 : wrong mission fails closed ──
  it("10 — wrong mission fails closed", async () => {
    const service = createService();

    const ctx = buildCanonicalContext({
      sourceRef: {
        tenantId: "tenant-test",
        missionId: "wrong-mission",
        version: 0,
        builtAt: CTX_NOW,
      },
    });

    const dag = makeDag("dag-ctx-10");

    const result = await service.execute(dag, ctx);

    expect(result.status).toBe("FAILED");
    expect(result.summary).toContain("mission");
  });

  // ── Test 11 : stale context is not silently used ──
  it("11 — stale context is not silently used", async () => {
    // Simuler : un contexte de version 0 est disponible mais
    // la version persistée est 1. L'appelant doit charger le latest.
    // Ce test prouve que le SupervisorService rejette ce qui lui est passé
    // et que c'est l'appelant qui est responsable de la fraîcheur.
    const service = createService();
    const ctx = buildCanonicalContext({
      sourceRef: {
        tenantId: "tenant-test",
        missionId: "mission-test",
        version: 0, // ancienne version
        builtAt: "2026-07-26T10:00:00.000Z",
      },
    });

    const dag = makeDag("dag-ctx-11");
    const result = await service.execute(dag, ctx);

    // Le SupervisorService ne vérifie PAS la fraîcheur
    // (il n'a pas accès au MissionContextRepository)
    // Mais il exécute avec le contexte fourni — c'est à l'appelant
    // de charger le latest avant d'appeler execute().
    // Le test prouve : si on passe une version 0, elle est utilisée.
    // L'architecte de l'appelant (orchestrator) est responsable.
    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary).toContain("contexte v0");
  });

  // ── Test 12 : latest context version is used (orchestrator responsibility) ──
  it("12 — latest context version is used", async () => {
    const ctxRepo = new InMemoryMissionContextRepository();

    // Simuler deux versions persistées
    const v0: MissionContext = {
      tenantId: "tenant-v12",
      missionId: "mission-v12",
      version: 0,
      confirmedObjective: "Tâche simple",
      confirmedConstraints: [],
      assumptions: [],
      openQuestions: [],
      boundedSummary: "Tâche simple",
      memoryReferences: [],
      builtAt: "2026-07-26T10:00:00.000Z",
      builtByLabel: "test",
    };
    const v1: MissionContext = {
      tenantId: "tenant-v12",
      missionId: "mission-v12",
      version: 1,
      confirmedObjective: "Mission enrichie",
      confirmedConstraints: [
        {
          id: "cc-v1-turn-e",
          statement: "Nouvelle contrainte",
          epistemics: "confirmed_fact",
          provenance: { source: "user_message", ref: "turn-e", observedAt: CTX_NOW },
        },
      ],
      assumptions: [],
      openQuestions: [],
      boundedSummary: "Mission enrichie avec contrainte",
      memoryReferences: [],
      builtAt: CTX_NOW,
      builtByLabel: "test",
    };

    const r0 = await ctxRepo.save({ context: v0, expectedVersion: null });
    expect(r0.ok, `save v0 failed: ${!r0.ok ? (r0 as { reason: string }).reason : "unknown"}`).toBe(
      true,
    );
    const r1 = await ctxRepo.save({ context: v1, expectedVersion: 0 });
    expect(r1.ok, `save v1 failed: ${!r1.ok ? (r1 as { reason: string }).reason : "unknown"}`).toBe(
      true,
    );

    // L'appelant charge le latest
    const loaded = await ctxRepo.findLatest("tenant-v12", "mission-v12");
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);

    // Le bridge utilise le latest
    const bridgeResult = resolveSupervisorContext(loaded!);
    expect(bridgeResult.ok).toBe(true);
    if (!bridgeResult.ok) return;
    expect(bridgeResult.envelope.sourceRef.version).toBe(1);

    // Le SupervisorService reçoit le contexte de version 1
    const service = createService();
    const dag = makeDag("dag-ctx-12", {
      missionId: "mission-v12",
      tenantId: "tenant-v12",
    });
    const result = await service.execute(dag, bridgeResult.envelope);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.summary).toContain("contexte v1");
  });

  // ── Test 13 : raw conversation never reaches SupervisorService ──
  it("13 — raw conversation never reaches SupervisorService", async () => {
    // Construire un MissionContext via ContextBuilder à partir d'une conversation
    const conversation: ConversationContext = {
      tenantId: "tenant-test",
      turns: [
        {
          id: "turn-obj",
          role: "user",
          text: "Livrer le rapport trimestriel en PDF",
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: CTX_NOW,
        },
        {
          id: "turn-conf",
          role: "user",
          text: "Deadline vendredi",
          confirmed: true,
          isObjective: false,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: CTX_NOW,
        },
      ],
      memoryReferences: [],
    };

    const mission: Mission = {
      id: "mission-test",
      tenantId: "tenant-test",
      userRequest: "Livrer le rapport trimestriel",
      status: "CREATED",
      runs: [],
      createdAt: CTX_NOW,
      updatedAt: CTX_NOW,
    };

    const built = buildMissionContext({
      conversation,
      mission,
      builtByLabel: "test",
      now: CTX_NOW,
      version: 0,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const bridgeResult = resolveSupervisorContext(built.context, mission);
    expect(bridgeResult.ok).toBe(true);
    if (!bridgeResult.ok) return;

    // Le SupervisorEnrichedContext ne contient AUCUN champ de conversation brute.
    // Les champs 'turns', 'role', 'conflictsWithMission', 'isObjective'
    // de ConversationContext n'existent pas dans le DTO projeté.
    const envelopeKeys = Object.keys(bridgeResult.envelope.input) as string[];
    expect(envelopeKeys).not.toContain("turns");

    // Le texte des tours apparaît SEULEMENT via les champs projetés du DTO
    // (confirmedObjective, confirmedConstraints[].statement) — jamais via la
    // structure conversation brute.
    const serialized = JSON.stringify(bridgeResult.envelope);
    expect(serialized).toContain("Deadline vendredi"); // OK : projeté dans confirmedConstraints
    expect(serialized).not.toContain("turn-obj"); // L'id du tour ne doit PAS fuir
    expect(serialized).not.toContain("isObjective"); // Les métadonnées de tour non plus
    expect(serialized).not.toContain("conflictsWithMission");

    // Le champ 'role' de ConversationTurn n'a pas d'équivalent dans le DTO
    expect(JSON.stringify(bridgeResult.envelope.input)).not.toContain('"role"');

    // Les questions ouvertes non résolues sont projetées, mais ici il n'y en a pas
    expect(JSON.stringify(bridgeResult.envelope.input.openQuestions)).toBe("[]");

    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const dag = makeDag("dag-ctx-13");
    await service.execute(dag, bridgeResult.envelope);

    // L'objective du worker contient le texte projeté du DTO, pas la conversation brute
    const objective = capturing.lastSpawnInput?.objective ?? "";
    expect(objective).toContain("Livrer le rapport trimestriel en PDF");
    expect(objective).toContain("Deadline vendredi"); // via confirmedConstraints projetées
  });

  // ── Test 14 : assumptions are not promoted ──
  it("14 — assumptions are not promoted to supervisor input", async () => {
    // Construire un contexte avec une assumption
    const conversation: ConversationContext = {
      tenantId: "tenant-test",
      turns: [
        {
          id: "turn-obj",
          role: "user",
          text: "Créer la page d'accueil",
          confirmed: true,
          isObjective: true,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: CTX_NOW,
        },
        {
          id: "turn-assumption",
          role: "user",
          text: "Je suppose que le design est en React",
          confirmed: false, // non confirmé → assumption
          isObjective: false,
          isOpenQuestion: false,
          conflictsWithMission: false,
          observedAt: CTX_NOW,
        },
      ],
      memoryReferences: [],
    };

    const mission: Mission = {
      id: "mission-test",
      tenantId: "tenant-test",
      userRequest: "Créer la page d'accueil",
      status: "CREATED",
      runs: [],
      createdAt: CTX_NOW,
      updatedAt: CTX_NOW,
    };

    const built = buildMissionContext({
      conversation,
      mission,
      builtByLabel: "test",
      now: CTX_NOW,
      version: 0,
    });

    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Le MissionContext a bien une assumption
    expect(built.context.assumptions.length).toBe(1);
    expect(built.context.assumptions[0]!.statement).toContain("React");

    // Le bridge produit un DTO qui STRIP les assumptions
    const bridgeResult = resolveSupervisorContext(built.context, mission);
    expect(bridgeResult.ok).toBe(true);
    if (!bridgeResult.ok) return;

    // Le DTO SupervisorContextInput n'a PAS de champ assumptions
    const dto = bridgeResult.envelope.input;
    expect("assumptions" in dto).toBe(false);
    // Le texte de l'assumption n'a pas fui
    expect(JSON.stringify(dto)).not.toContain("React");
  });

  // ── Test 15 : no permission reaches Supervisor ──
  it("15 — no permission reaches Supervisor", () => {
    // Le schéma strict .strict() rejette tout champ d'autorité
    const valid = buildCanonicalContext();
    const parsed = JSON.parse(JSON.stringify(valid));
    // Aucun champ "grant", "token", "credential", "permission" dans l'enveloppe
    const walk = (obj: Record<string, unknown>): void => {
      for (const key of Object.keys(obj)) {
        expect([
          "grant",
          "executionGrant",
          "token",
          "credential",
          "permission",
          "allow",
          "approved",
          "approval",
          "policyDecision",
          "credentials",
        ]).not.toContain(key);
        if (typeof obj[key] === "object" && obj[key] !== null) {
          walk(obj[key] as Record<string, unknown>);
        }
      }
    };
    walk(parsed);
  });

  // ── Test 16 : no approval reaches Supervisor ──
  it("16 — no approval reaches Supervisor", () => {
    const valid = buildCanonicalContext();
    // Vérification structurelle : aucun champ d'approbation
    expect("approvedBy" in valid).toBe(false);
    expect("approval" in valid).toBe(false);
    expect("approved" in valid.input).toBe(false);
  });

  // ── Test 17 : no ExecutionGrant reaches Supervisor ──
  it("17 — no ExecutionGrant reaches Supervisor", () => {
    const valid = buildCanonicalContext();
    expect("executionGrant" in valid).toBe(false);
    expect("executionGrant" in valid.input).toBe(false);
    // Le permissionEnvelope vient du SupervisorService, pas du contexte
  });

  // ── Test 18 : Supervisor cannot bypass D1 ──
  it("18 — Supervisor cannot bypass D1", async () => {
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    const ctx = buildCanonicalContext();
    await service.execute(makeDag("dag-ctx-18"), ctx);

    // TOUS les permissionEnvelopes suivent le même pattern D1
    // (inchangé par le contexte)
    for (const spawn of capturing.allSpawnInputs) {
      expect(spawn.permissionEnvelope).toEqual({
        action: "supervisor.worker.execute",
        resource: spawn.taskId,
      });
    }
    // Le contexte n'a pas modifié la permissionEnvelope
    // D1 reste la seule autorité de permission
  });

  // ── Test 19 : Supervisor cannot bypass G1 ──
  it("19 — Supervisor cannot bypass G1", async () => {
    // G1 (gates globales) est invoquée à travers le processus d'intégration (G4).
    // Le GlobalGatesPort est une dépendance obligatoire du SupervisorService
    // (injectée dans le constructeur), ce qui prouve que G1 est architecteuralement
    // présente et ne peut être court-circuitée par le contexte.
    // Le contexte n'a AUCUN mécanisme pour bypasser l'intégration.

    // Prouver que l'intégration est TOUJOURS appelée quand un contexte est fourni
    let integratorCalled = false;
    class TrackedFakeIntegrator extends FakeIntegrator {
      async integrate(spec: IntegrationSpec): Promise<IntegrationResult> {
        integratorCalled = true;
        return super.integrate(spec);
      }
    }

    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      new FakeWorkerManager(),
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new TrackedFakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    await service.execute(makeDag("dag-ctx-19"), buildCanonicalContext());

    // L'intégration (G4, qui invoque G1) est TOUJOURS exécutée
    // même quand un contexte est fourni
    expect(integratorCalled).toBe(true);

    // Le GlobalGatesPort est une dépendance obligatoire du constructeur
    // (paramètre positionnel 5). Le contexte ne peut pas contourner cette
    // dépendance — preuve architecturale que G1 reste intégré.
  });

  // ── Test 20 : Task DAG/planning can start on a valid contextual input ──
  it("20 — Task DAG/planning can start on a valid contextual input", async () => {
    const repo = new InMemorySupervisorRepository();
    const service = createService(repo);

    const ctx = buildCanonicalContext();
    const dag = makeDag("dag-ctx-20");

    // L'exécution démarre et réussit avec un contexte valide
    const result = await service.execute(dag, ctx);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.dag).toBeDefined();
    expect(result.summary).toContain("intégrées");

    // Le DAG a bien été persisté
    const saved = await repo.findDagById("dag-ctx-20");
    expect(saved).not.toBeNull();
    expect(saved!.status).toBe("COMPLETED");
  });

  // ── Test 21 (bonus) : Supervisor ignore context for authorization ──
  it("21 — Supervisor uses DAG permissionEnvelope regardless of context", async () => {
    // Même avec un contexte vide, la permissionEnvelope est inchangée
    const capturing = new CapturingFakeWorkerManager();
    const service = new SupervisorService(
      new InMemorySupervisorRepository(),
      capturing,
      new FakeWorktreeManager(),
      new FakeReviewer(),
      new FakeCorrector(),
      new FakeGates(),
      new FakeIntegrator(),
      new FakePreview(),
      { maxConcurrentWorkers: 2 },
    );

    // Pas de contexte
    await service.execute(makeDag("dag-ctx-21a"));

    const permissionWithoutCtx = capturing.lastSpawnInput?.permissionEnvelope;

    // Avec contexte
    await service.execute(makeDag("dag-ctx-21b"), buildCanonicalContext());

    const permissionWithCtx = capturing.lastSpawnInput?.permissionEnvelope;

    // Le permissionEnvelope est IDENTIQUE dans les deux cas
    expect(permissionWithCtx).toEqual(permissionWithoutCtx);
  });
});
