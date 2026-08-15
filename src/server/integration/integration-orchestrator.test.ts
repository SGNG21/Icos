import { describe, expect, it, vi } from "vitest";

import type { IntegrationSpec, GateResult } from "@/core/integration";
import type { GlobalGatesPort } from "./ports";
import { IntegrationOrchestrator } from "./integration-orchestrator";

// ─────────────────────────────────────
// Fake gates
// ─────────────────────────────────────

class FakeGatesAllPass implements GlobalGatesPort {
  async executeAll(_path: string): Promise<GateResult[]> {
    return [
      { gate: "git-diff-check", passed: true, output: "", durationMs: 1, errors: [] },
      { gate: "lint", passed: true, output: "", durationMs: 2, errors: [] },
      { gate: "typecheck", passed: true, output: "", durationMs: 3, errors: [] },
      { gate: "test", passed: true, output: "", durationMs: 4, errors: [] },
      { gate: "build", passed: true, output: "", durationMs: 5, errors: [] },
    ];
  }
  async executeGate(_gate: string, _path: string): Promise<GateResult> {
    return { gate: _gate, passed: true, output: "", durationMs: 1, errors: [] };
  }
  async gitDiffCheck(_path: string): Promise<GateResult> {
    return { gate: "git-diff-check", passed: true, output: "", durationMs: 1, errors: [] };
  }
}

class FakeGatesLintFails implements GlobalGatesPort {
  async executeAll(_path: string): Promise<GateResult[]> {
    return [
      { gate: "git-diff-check", passed: true, output: "", durationMs: 1, errors: [] },
      {
        gate: "lint",
        passed: false,
        output: "Error: semicolon expected",
        durationMs: 2,
        errors: ["semicolon expected"],
      },
      { gate: "typecheck", passed: true, output: "", durationMs: 3, errors: [] },
      { gate: "test", passed: true, output: "", durationMs: 4, errors: [] },
      { gate: "build", passed: true, output: "", durationMs: 5, errors: [] },
    ];
  }
  async executeGate(_gate: string, _path: string): Promise<GateResult> {
    return { gate: _gate, passed: _gate !== "lint", output: "", durationMs: 1, errors: [] };
  }
  async gitDiffCheck(_path: string): Promise<GateResult> {
    return { gate: "git-diff-check", passed: true, output: "", durationMs: 1, errors: [] };
  }
}

// ─────────────────────────────────────
// Typed mock accessor — replace `as any` with proper types for spying
// on private/protected IntegrationOrchestrator internals during tests.
// ─────────────────────────────────────

interface MockableOrchestrator {
  getRepoRoot(): Promise<string>;
  createIntegrationBranch(branchName: string, baseSha: string): Promise<void>;
  applyCommit(commitSha: string, targetBranch: string): Promise<void>;
  git(args: string[]): Promise<string>;
}

function mockOrchestrator(orchestrator: IntegrationOrchestrator): MockableOrchestrator {
  return orchestrator as unknown as MockableOrchestrator;
}

// ─────────────────────────────────────
// Tests
// ─────────────────────────────────────

describe("IntegrationOrchestrator", () => {
  const defaultSpec: IntegrationSpec = {
    id: "integration-001",
    missionId: "mission-001",
    dagId: "dag-001",
    commits: [
      {
        taskId: "task-001",
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        branch: "wt-task-001",
        worktreePath: "/tmp/wt1",
      },
      {
        taskId: "task-002",
        commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        branch: "wt-task-002",
        worktreePath: "/tmp/wt2",
      },
    ],
    integrationBranch: "integration/candidate",
  };

  describe("integrate", () => {
    it("returns SUCCEEDED when all gates pass", async () => {
      const orchestrator = new IntegrationOrchestrator(new FakeGatesAllPass());
      // Mock internal git ops to avoid real execution
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      vi.spyOn(mockOrchestrator(orchestrator), "createIntegrationBranch").mockResolvedValue(
        undefined,
      );
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit").mockResolvedValue(undefined);
      vi.spyOn(mockOrchestrator(orchestrator), "git").mockResolvedValue(
        "ffffffffffffffffffffffffffffffffffffffff",
      );

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("SUCCEEDED");
      expect(result.commitsIntegrated).toBe(2);
      expect(result.gateResults).toHaveLength(5);
    });

    it("returns CONFLICT when commit application fails", async () => {
      const orchestrator = new IntegrationOrchestrator(new FakeGatesAllPass());
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      vi.spyOn(mockOrchestrator(orchestrator), "createIntegrationBranch").mockResolvedValue(
        undefined,
      );
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("CONFLICT in src/file.ts"));

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("CONFLICT");
      expect(result.commitsIntegrated).toBe(1);
      expect(result.conflict).toBeDefined();
    });

    it("returns GATES_FAILED when gates fail", async () => {
      const orchestrator = new IntegrationOrchestrator(new FakeGatesLintFails());
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      vi.spyOn(mockOrchestrator(orchestrator), "createIntegrationBranch").mockResolvedValue(
        undefined,
      );
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit").mockResolvedValue(undefined);

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("GATES_FAILED");
      expect(result.gateResults.some((g) => !g.passed)).toBe(true);
      expect(result.gateResults!.find((g) => g.gate === "lint")!.passed).toBe(false);
    });

    it("returns FAILED when git operations fail", async () => {
      // Créer une instance qui force getRepoRoot à échouer
      // en passant un mauvais integrationBase pour provoquer une erreur système
      class FailOnCreate extends IntegrationOrchestrator {
        protected async getRepoRoot(): Promise<string> {
          throw new Error("Repo not found");
        }
      }
      const orchestrator = new FailOnCreate(new FakeGatesAllPass());

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("Repo not found");
    });
  });
});
