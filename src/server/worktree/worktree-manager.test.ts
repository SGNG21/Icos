import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { InMemoryWorktreeManager } from "./worktree-manager-fake";

const exec = promisify(execFile);

// ─────────────────────────────────────
// Fake WorktreeManager (for unit tests)
// ─────────────────────────────────────

describe("InMemoryWorktreeManager (fake)", () => {
  it("creates a worktree spec", async () => {
    const mgr = new InMemoryWorktreeManager();
    const spec = await mgr.createWorktree("task-001", "0000000000000000000000000000000000000000");

    expect(spec.taskId).toBe("task-001");
    expect(spec.branch).toContain("task-001");
    expect(spec.path).toBeTruthy();
  });

  it("captures result with changed files", async () => {
    const mgr = new InMemoryWorktreeManager();
    const spec = await mgr.createWorktree("task-001", "a".repeat(40));

    // Simuler des changements
    mgr.addChange(spec.path, "src/test.ts");
    mgr.setDirty(spec.path, true);

    const result = await mgr.captureResult(spec.path);
    expect(result.changedFiles).toContain("src/test.ts");
    expect(result.isDirty).toBe(true);
  });

  it("detects changes", async () => {
    const mgr = new InMemoryWorktreeManager();
    const spec = await mgr.createWorktree("task-001", "a".repeat(40));

    mgr.addChange(spec.path, "src/foo.ts");
    mgr.addChange(spec.path, "src/bar.ts");

    const changes = await mgr.detectChanges(spec.path);
    expect(changes).toHaveLength(2);
    expect(changes).toContain("src/foo.ts");
  });

  it("lists active worktrees", async () => {
    const mgr = new InMemoryWorktreeManager();
    await mgr.createWorktree("task-001", "a".repeat(40));
    await mgr.createWorktree("task-002", "b".repeat(40));

    const active = await mgr.listActive();
    expect(active).toHaveLength(2);
  });

  it("removes cleaned worktrees from active list", async () => {
    const mgr = new InMemoryWorktreeManager();
    const spec = await mgr.createWorktree("task-001", "a".repeat(40));

    await mgr.cleanupWorktree(spec.path);
    const active = await mgr.listActive();
    expect(active).toHaveLength(0);
  });

  it("assigns worktree to task", async () => {
    const mgr = new InMemoryWorktreeManager();
    await mgr.assignToTask("/tmp/wt", "task-001");

    const active = await mgr.listActive();
    expect(active).toHaveLength(1);
    expect(active[0].spec.taskId).toBe("task-001");
  });
});

// ─────────────────────────────────────
// Integration tests (real git operations)
// ─────────────────────────────────────

// Typed accessor for WorktreeManager private internals used in tests.
// Uses a structural type to avoid the `never` intersection caused by
// conflicting private `resolvedRoot` declarations.
interface MockableWorktreeManager {
  resolvedRoot: string | null;
}

function mockWorktreeManager(mgr: object): MockableWorktreeManager {
  return mgr as unknown as MockableWorktreeManager;
}

describe("WorktreeManager (git integration)", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = path.join("/tmp", `icos-wt-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    await exec("git", ["init", tmpDir]);
    await exec("git", ["config", "user.email", "test@icos.dev"], { cwd: tmpDir });
    await exec("git", ["config", "user.name", "ICOS Test"], { cwd: tmpDir });

    // Créer un commit initial
    await writeFile(path.join(tmpDir, "README.md"), "# ICOS Test Repo\n");
    await exec("git", ["add", "."], { cwd: tmpDir });
    await exec("git", ["commit", "-m", "Initial commit"], { cwd: tmpDir });
  });

  afterAll(async () => {
    // Nettoyer les worktrees avant de supprimer le repo
    const wtDir = path.join(tmpDir, ".claude", "worktrees");
    try {
      const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: tmpDir });
      const lines = list.stdout.split("\n");
      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          const wtPath = line.slice(9).trim();
          if (wtPath && wtPath !== tmpDir) {
            await exec("git", ["worktree", "remove", "--force", wtPath], { cwd: tmpDir }).catch(() => {});
          }
        }
      }
    } catch {
      // Ignorer les erreurs de cleanup
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a worktree", async () => {
    const { WorktreeManager } = await import("./worktree-manager");
    const mgr = new WorktreeManager(path.join(".claude", "worktrees"));

    // Remplacer le repo root
    mockWorktreeManager(mgr).resolvedRoot = tmpDir;

    const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: tmpDir })).stdout.trim();
    const spec = await mgr.createWorktree("integ-test-task", baseSha);

    expect(spec.path).toContain("integ-test-task");
    expect(spec.branch).toBe("worktree-integ-test-task");
    expect(spec.baseSha).toBe(baseSha);

    // Vérifier que le worktree existe
    const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: tmpDir });
    expect(list.stdout).toContain(spec.path);

    // Nettoyer
    await mgr.cleanupWorktree(spec.path);
  });

  it("isolates worktrees from each other", async () => {
    const { WorktreeManager } = await import("./worktree-manager");
    const mgr = new WorktreeManager(path.join(".claude", "worktrees"));
    mockWorktreeManager(mgr).resolvedRoot = tmpDir;

    const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: tmpDir })).stdout.trim();

    // Créer deux worktrees
    const spec1 = await mgr.createWorktree("isol-test-1", baseSha);
    const spec2 = await mgr.createWorktree("isol-test-2", baseSha);

    // Écrire dans le premier
    await writeFile(path.join(spec1.path, "file-a.txt"), "File A content\n");
    await exec("git", ["add", "."], { cwd: spec1.path });
    await exec("git", ["commit", "-m", "Add file-a"], { cwd: spec1.path });

    // Vérifier que le second n'a pas le fichier
    const result1 = await mgr.captureResult(spec1.path);
    expect(result1.changedFiles).toContain("file-a.txt");

    const result2 = await mgr.captureResult(spec2.path);
    expect(result2.changedFiles).not.toContain("file-a.txt");
    expect(result2.changedFiles).toEqual([]);

    // Nettoyer
    await mgr.cleanupWorktree(spec1.path).catch(() => {});
    await mgr.cleanupWorktree(spec2.path).catch(() => {});
  });

  it("safely refuses to clean the repo root", async () => {
    const { WorktreeManager } = await import("./worktree-manager");
    const mgr = new WorktreeManager(path.join(".claude", "worktrees"));
    mockWorktreeManager(mgr).resolvedRoot = tmpDir;

    await expect(mgr.cleanupWorktree(tmpDir)).rejects.toThrow(/racine|root/i);
  });

  it("captures commit history", async () => {
    const { WorktreeManager } = await import("./worktree-manager");
    const mgr = new WorktreeManager(path.join(".claude", "worktrees"));
    mockWorktreeManager(mgr).resolvedRoot = tmpDir;

    const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: tmpDir })).stdout.trim();
    const spec = await mgr.createWorktree("commit-test", baseSha);

    // Faire deux commits dans le worktree
    await writeFile(path.join(spec.path, "commit-a.txt"), "A\n");
    await exec("git", ["add", "."], { cwd: spec.path });
    await exec("git", ["commit", "-m", "feat: add commit A"], { cwd: spec.path });

    await writeFile(path.join(spec.path, "commit-b.txt"), "B\n");
    await exec("git", ["add", "."], { cwd: spec.path });
    await exec("git", ["commit", "-m", "feat: add commit B"], { cwd: spec.path });

    const result = await mgr.captureResult(spec.path);
    expect(result.commitMessages).toContain("feat: add commit A");
    expect(result.commitMessages).toContain("feat: add commit B");
    expect(result.commitShas).toHaveLength(2);

    await mgr.cleanupWorktree(spec.path).catch(() => {});
  });

  it("detects dirty state", async () => {
    const { WorktreeManager } = await import("./worktree-manager");
    const mgr = new WorktreeManager(path.join(".claude", "worktrees"));
    mockWorktreeManager(mgr).resolvedRoot = tmpDir;

    const baseSha = (await exec("git", ["rev-parse", "HEAD"], { cwd: tmpDir })).stdout.trim();
    const spec = await mgr.createWorktree("dirty-test", baseSha);

    // Modifier sans commiter
    await writeFile(path.join(spec.path, "uncommitted.txt"), "dirty\n");

    const result = await mgr.captureResult(spec.path);
    expect(result.isDirty).toBe(true);
    expect(result.uncommittedFiles.length).toBeGreaterThanOrEqual(1);

    await mgr.cleanupWorktree(spec.path).catch(() => {});
  });
});
