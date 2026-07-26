import { describe, expect, it, vi } from "vitest";

import type { TaskDag, TaskNode } from "@/core/supervisor";
import type { WorkerResult, CreateWorkerInput } from "@/core/worker";
import type { ReviewSpec, ReviewResult, CorrectionSpec, CorrectionResult } from "@/core/review";
import type { IntegrationSpec, IntegrationResult, GateResult } from "@/core/integration";
import type { PreviewResult } from "@/core/preview";
import type { WorktreeSpec, WorktreeResult } from "@/core/worktree";
import type { SupervisorRepository } from "./ports";
import { InMemorySupervisorRepository } from "./in-memory/supervisor-repository";
import { SupervisorService } from "./supervisor-service";
import type { WorkerManagerPort } from "@/server/worker/ports";
import type { WorktreeManagerPort } from "@/server/worktree/ports";
import type { ReviewerManagerPort, CorrectionLoopManagerPort } from "@/server/review/ports";
import type { GlobalGatesPort, IntegrationOrchestratorPort } from "@/server/integration/ports";
import type { PreviewDeliveryPort } from "@/server/preview/ports";

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
        summary: `Worker ${input.taskId} completed`,
        durationMs: 10,
      });
    }
    return id;
  }
  async getStatus(workerId: string): Promise<any> {
    return { status: "SUCCEEDED", worker: null };
  }
  async collectResult(workerId: string): Promise<WorkerResult | null> {
    return this.results.get(workerId) ?? null;
  }
  async cancel(_workerId: string): Promise<void> {}
  async waitForCompletion(workerId: string, _timeoutMs?: number): Promise<WorkerResult> {
    return this.results.get(workerId) ?? { outcome: "FAILED", summary: "Not found", durationMs: 0 };
  }
  async markLost(_workerId: string): Promise<void> {}
}

class FakeWorktreeManager implements WorktreeManagerPort {
  async createWorktree(_taskId: string): Promise<WorktreeSpec> {
    return { path: `/tmp/wt-${_taskId}`, branch: `wt-${_taskId}`, baseSha: "a".repeat(40), taskId: _taskId };
  }
  async assignToTask(_path: string, _taskId: string): Promise<void> {}
  async captureResult(_path: string): Promise<WorktreeResult> {
    return { baseSha: "a".repeat(40), headSha: "b".repeat(40), changedFiles: ["src/test.ts"], isDirty: false, uncommittedFiles: [], commitMessages: ["feat: task"], commitShas: ["b".repeat(40)] };
  }
  async detectChanges(_path: string): Promise<string[]> { return []; }
  async cleanupWorktree(_path: string): Promise<void> {}
  async listActive(): Promise<any[]> { return []; }
}

class FakeReviewer implements ReviewerManagerPort {
  async conductReview(_spec: ReviewSpec): Promise<ReviewResult> {
    return { verdict: "PASS", checks: [{ category: "acceptance_criteria", description: "OK", passed: true }], summary: "PASS", completedAt: new Date().toISOString() };
  }
  async ensureIndependentReview(_taskId: string, _reviewerWorkerId: string): Promise<boolean> { return true; }
}

class FakeCorrector implements CorrectionLoopManagerPort {
  async executeCorrection(_spec: CorrectionSpec): Promise<CorrectionResult> { return { outcome: "CORRECTED", summary: "OK", durationMs: 5 }; }
  isMaxAttemptsReached(_spec: CorrectionSpec): boolean { return false; }
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
    return { status: "SUCCEEDED", gateResults: [], commitsIntegrated: 2, summary: "Intégration réussie", durationMs: 10, finalSha: "c".repeat(40) };
  }
}

class FakePreview implements PreviewDeliveryPort {
  async deliver(_sha: string, _branch: string): Promise<PreviewResult> {
    return { status: "LOCAL_RESULT_READY", summary: "Preview prête", completedAt: new Date().toISOString(), durationMs: 5 };
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
  });
});

function makeNode(id: string, deps: string[]): TaskNode {
  return {
    id,
    label: `Task ${id}`,
    description: `Description ${id}`,
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
