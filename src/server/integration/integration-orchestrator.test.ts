import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { IntegrationSpec, GateResult } from "@/core/integration";
import type { WorktreeSpec } from "@/core/worktree";
import type { GlobalGatesPort, IntegrationWorktreePort } from "./ports";
import { IntegrationOrchestrator } from "./integration-orchestrator";
import { WorktreeManager } from "@/server/worktree/worktree-manager";

const exec = promisify(execFileCallback);

class FakeIntegrationWorktrees implements IntegrationWorktreePort {
  readonly create = vi.fn(
    async (input: {
      integrationId: string;
      branch: string;
      baseSha: string;
    }): Promise<WorktreeSpec> => ({
      path: `/tmp/integration/${input.integrationId}`,
      branch: input.branch,
      baseSha: input.baseSha,
      taskId: input.integrationId,
    }),
  );
  readonly cleanup = vi.fn(
    async (_path: string, _options: { preserveBranch: boolean }) => undefined,
  );

  createIntegrationWorktree(input: {
    integrationId: string;
    branch: string;
    baseSha: string;
  }): Promise<WorktreeSpec> {
    return this.create(input);
  }

  cleanupIntegrationWorktree(path: string, options: { preserveBranch: boolean }): Promise<void> {
    return this.cleanup(path, options);
  }
}

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
  applyCommit(commitSha: string, integrationPath: string): Promise<void>;
  git(args: string[], cwd: string): Promise<string>;
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
      const worktrees = new FakeIntegrationWorktrees();
      const orchestrator = new IntegrationOrchestrator(new FakeGatesAllPass(), worktrees);
      // Mock internal git ops to avoid real execution
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit").mockResolvedValue(undefined);
      const gitSpy = vi
        .spyOn(mockOrchestrator(orchestrator), "git")
        .mockResolvedValue("ffffffffffffffffffffffffffffffffffffffff");

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("SUCCEEDED");
      expect(result.commitsIntegrated).toBe(2);
      expect(result.gateResults).toHaveLength(5);
      expect(gitSpy).toHaveBeenCalledWith(
        [
          "merge-base",
          "--is-ancestor",
          "ffffffffffffffffffffffffffffffffffffffff",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ],
        "/tmp/integration/integration-001",
      );
      expect(worktrees.create).toHaveBeenCalledOnce();
      expect(worktrees.cleanup).toHaveBeenCalledWith("/tmp/integration/integration-001", {
        preserveBranch: true,
      });
    });

    it("returns CONFLICT when commit application fails", async () => {
      const worktrees = new FakeIntegrationWorktrees();
      const orchestrator = new IntegrationOrchestrator(new FakeGatesAllPass(), worktrees);
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      const gitSpy = vi
        .spyOn(mockOrchestrator(orchestrator), "git")
        .mockImplementation(async (args) => (args[0] === "diff" ? "src/file.ts" : ""));
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit")
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("CONFLICT in src/file.ts"));

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("CONFLICT");
      expect(result.commitsIntegrated).toBe(1);
      expect(result.conflict).toBeDefined();
      expect(gitSpy).toHaveBeenCalledWith(
        ["cherry-pick", "--abort"],
        "/tmp/integration/integration-001",
      );
      expect(worktrees.cleanup).toHaveBeenCalledWith("/tmp/integration/integration-001", {
        preserveBranch: false,
      });
    });

    it("fails closed when commit application fails without conflict files", async () => {
      const worktrees = new FakeIntegrationWorktrees();
      const orchestrator = new IntegrationOrchestrator(new FakeGatesAllPass(), worktrees);
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      const gitSpy = vi.spyOn(mockOrchestrator(orchestrator), "git").mockResolvedValue("");
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit").mockRejectedValueOnce(
        new Error("commit hook failed"),
      );

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("commit hook failed");
      expect(gitSpy).not.toHaveBeenCalledWith(
        ["cherry-pick", "--abort"],
        "/tmp/integration/integration-001",
      );
      expect(worktrees.cleanup).toHaveBeenCalledWith("/tmp/integration/integration-001", {
        preserveBranch: false,
      });
    });

    it("returns GATES_FAILED when gates fail", async () => {
      const worktrees = new FakeIntegrationWorktrees();
      const orchestrator = new IntegrationOrchestrator(new FakeGatesLintFails(), worktrees);
      vi.spyOn(mockOrchestrator(orchestrator), "getRepoRoot").mockResolvedValue("/tmp");
      vi.spyOn(mockOrchestrator(orchestrator), "applyCommit").mockResolvedValue(undefined);
      vi.spyOn(mockOrchestrator(orchestrator), "git").mockResolvedValue("");

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("GATES_FAILED");
      expect(result.gateResults.some((g) => !g.passed)).toBe(true);
      expect(result.gateResults!.find((g) => g.gate === "lint")!.passed).toBe(false);
      expect(worktrees.cleanup).toHaveBeenCalledWith("/tmp/integration/integration-001", {
        preserveBranch: false,
      });
    });

    it("returns FAILED when git operations fail", async () => {
      // Créer une instance qui force getRepoRoot à échouer
      // en passant un mauvais integrationBase pour provoquer une erreur système
      class FailOnCreate extends IntegrationOrchestrator {
        protected async getRepoRoot(): Promise<string> {
          throw new Error("Repo not found");
        }
      }
      const orchestrator = new FailOnCreate(new FakeGatesAllPass(), new FakeIntegrationWorktrees());

      const result = await orchestrator.integrate(defaultSpec);

      expect(result.status).toBe("FAILED");
      expect(result.summary).toContain("Repo not found");
    });
  });
});

class CapturingPassGates extends FakeGatesAllPass {
  workspacePath: string | null = null;

  override async executeAll(workspacePath: string): Promise<GateResult[]> {
    this.workspacePath = workspacePath;
    return super.executeAll(workspacePath);
  }
}

class RepoScopedIntegrationOrchestrator extends IntegrationOrchestrator {
  constructor(
    gates: GlobalGatesPort,
    worktrees: IntegrationWorktreePort,
    private readonly repoRoot: string,
  ) {
    super(gates, worktrees);
  }

  protected override async getRepoRoot(): Promise<string> {
    return this.repoRoot;
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function createTaskCommit(input: {
  repo: string;
  baseSha: string;
  branch: string;
  file: string;
  content: string;
}): Promise<string> {
  const taskWorktree = await mkdtemp("/tmp/integration-task-");
  await rm(taskWorktree, { recursive: true, force: true });
  await git(input.repo, ["worktree", "add", "-b", input.branch, taskWorktree, input.baseSha]);
  await writeFile(path.join(taskWorktree, input.file), input.content);
  await git(taskWorktree, ["add", "--", input.file]);
  await git(taskWorktree, ["commit", "-m", `test: ${input.branch}`]);
  const sha = await git(taskWorktree, ["rev-parse", "HEAD"]);
  await git(input.repo, ["worktree", "remove", "--force", taskWorktree]);
  return sha;
}

describe("IntegrationOrchestrator — real active-worktree isolation", () => {
  it("uses a dedicated worktree, validates merge-base, and preserves source state", async () => {
    const repo = await mkdtemp("/tmp/integration-source-");
    try {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "integration@test.invalid"]);
      await git(repo, ["config", "user.name", "Integration Test"]);
      await writeFile(path.join(repo, "base.txt"), "base\n");
      await git(repo, ["add", "--", "base.txt"]);
      await git(repo, ["commit", "-m", "test: base"]);
      const baseSha = await git(repo, ["rev-parse", "HEAD"]);
      const taskSha = await createTaskCommit({
        repo,
        baseSha,
        branch: "task/isolation",
        file: "task.txt",
        content: "isolated\n",
      });

      const branchBefore = await git(repo, ["branch", "--show-current"]);
      const headBefore = await git(repo, ["rev-parse", "HEAD"]);
      const indexBefore = await git(repo, ["diff", "--cached"]);
      const statusBefore = await git(repo, ["status", "--porcelain"]);
      const fileBefore = await readFile(path.join(repo, "base.txt"), "utf8");
      const gates = new CapturingPassGates();
      const worktrees = new WorktreeManager(".claude/worktrees", repo);
      const orchestrator = new RepoScopedIntegrationOrchestrator(gates, worktrees, repo);

      const result = await orchestrator.integrate({
        id: "integration-isolation",
        missionId: "mission-isolation",
        dagId: "dag-isolation",
        commits: [
          {
            taskId: "task-isolation",
            commitSha: taskSha,
            branch: "task/isolation",
            worktreePath: "/not-used",
          },
        ],
        integrationBranch: "integration/isolation-proof",
        baseSha,
      });

      expect(result.status).toBe("SUCCEEDED");
      expect(gates.workspacePath).toContain(
        path.join(".claude", "integration", "integration-isolation"),
      );
      expect(await git(repo, ["branch", "--show-current"])).toBe(branchBefore);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(await git(repo, ["diff", "--cached"])).toBe(indexBefore);
      expect(await git(repo, ["status", "--porcelain"])).toBe(statusBefore);
      expect(await readFile(path.join(repo, "base.txt"), "utf8")).toBe(fileBefore);
      await expect(access(gates.workspacePath!)).rejects.toThrow();
      expect(await git(repo, ["branch", "--list", "integration/isolation-proof"])).toContain(
        "integration/isolation-proof",
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("captures conflict files, aborts, and removes the failed integration worktree and branch", async () => {
    const repo = await mkdtemp("/tmp/integration-conflict-source-");
    try {
      await git(repo, ["init"]);
      await git(repo, ["config", "user.email", "integration@test.invalid"]);
      await git(repo, ["config", "user.name", "Integration Test"]);
      await writeFile(path.join(repo, "shared.txt"), "base\n");
      await git(repo, ["add", "--", "shared.txt"]);
      await git(repo, ["commit", "-m", "test: base"]);
      const baseSha = await git(repo, ["rev-parse", "HEAD"]);
      const firstSha = await createTaskCommit({
        repo,
        baseSha,
        branch: "task/conflict-a",
        file: "shared.txt",
        content: "first\n",
      });
      const secondSha = await createTaskCommit({
        repo,
        baseSha,
        branch: "task/conflict-b",
        file: "shared.txt",
        content: "second\n",
      });
      const sourceHead = await git(repo, ["rev-parse", "HEAD"]);
      const gates = new CapturingPassGates();
      const worktrees = new WorktreeManager(".claude/worktrees", repo);
      const orchestrator = new RepoScopedIntegrationOrchestrator(gates, worktrees, repo);
      const integrationPath = path.join(repo, ".claude", "integration", "integration-conflict");

      const result = await orchestrator.integrate({
        id: "integration-conflict",
        missionId: "mission-conflict",
        dagId: "dag-conflict",
        commits: [
          {
            taskId: "task-a",
            commitSha: firstSha,
            branch: "task/conflict-a",
            worktreePath: "/not-used-a",
          },
          {
            taskId: "task-b",
            commitSha: secondSha,
            branch: "task/conflict-b",
            worktreePath: "/not-used-b",
          },
        ],
        integrationBranch: "integration/conflict-proof",
        baseSha,
      });

      expect(result.status).toBe("CONFLICT");
      expect(result.conflict?.files).toEqual(["shared.txt"]);
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(sourceHead);
      await expect(access(integrationPath)).rejects.toThrow();
      expect(await git(repo, ["branch", "--list", "integration/conflict-proof"])).toBe("");
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
