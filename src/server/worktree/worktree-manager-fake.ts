import type { WorktreeSpec, WorktreeResult, WorktreeEntry } from "@/core/worktree";
import type { WorktreeManagerPort } from "./ports";

/**
 * Fake WorktreeManager pour les tests unitaires.
 * Simule les opérations Git sans exécuter de vraies commandes.
 */
export class InMemoryWorktreeManager implements WorktreeManagerPort {
  private readonly entries = new Map<string, WorktreeEntry>();
  private readonly changes = new Map<string, string[]>();
  private readonly dirtyStates = new Map<string, boolean>();
  private counter = 0;

  async createWorktree(taskId: string, baseSha?: string): Promise<WorktreeSpec> {
    this.counter++;
    const sanitized = taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const path = `/tmp/fake-worktree-${sanitized}-${this.counter}`;
    const now = new Date().toISOString();

    const spec: WorktreeSpec = {
      path,
      branch: `worktree-${sanitized}`,
      baseSha: baseSha ?? "0000000000000000000000000000000000000000",
      taskId,
    };

    this.entries.set(taskId, {
      spec,
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });

    this.changes.set(path, []);
    this.dirtyStates.set(path, false);

    return spec;
  }

  async assignToTask(worktreePath: string, taskId: string): Promise<void> {
    const now = new Date().toISOString();
    this.entries.set(taskId, {
      spec: {
        path: worktreePath,
        branch: `worktree-${taskId}`,
        baseSha: "0000000000000000000000000000000000000000",
        taskId,
      },
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    this.changes.set(worktreePath, []);
    this.dirtyStates.set(worktreePath, false);
  }

  async captureResult(worktreePath: string): Promise<WorktreeResult> {
    const changedFiles = this.changes.get(worktreePath) ?? [];
    const isDirty = this.dirtyStates.get(worktreePath) ?? false;

    for (const entry of this.entries.values()) {
      if (entry.spec.path === worktreePath) {
        entry.status = isDirty ? "DIRTY" : "COMMITTED";
        entry.updatedAt = new Date().toISOString();
      }
    }

    return {
      baseSha: "0000000000000000000000000000000000000000",
      headSha: "1111111111111111111111111111111111111111",
      changedFiles,
      isDirty,
      uncommittedFiles: isDirty ? changedFiles : [],
      commitMessages: isDirty ? [] : ["feat: task completed"],
      commitShas: isDirty ? [] : ["1111111111111111111111111111111111111111"],
    };
  }

  async detectChanges(worktreePath: string): Promise<string[]> {
    return this.changes.get(worktreePath) ?? [];
  }

  async cleanupWorktree(worktreePath: string): Promise<void> {
    for (const [taskId, entry] of this.entries) {
      if (entry.spec.path === worktreePath) {
        entry.status = "CLEANED";
        entry.updatedAt = new Date().toISOString();
      }
    }
    this.changes.delete(worktreePath);
    this.dirtyStates.delete(worktreePath);
  }

  async listActive(): Promise<WorktreeEntry[]> {
    return Array.from(this.entries.values()).filter((e) => e.status !== "CLEANED");
  }

  // ─────────────────────────────────────
  // Test helpers
  // ─────────────────────────────────────

  addChange(worktreePath: string, file: string): void {
    const existing = this.changes.get(worktreePath) ?? [];
    existing.push(file);
    this.changes.set(worktreePath, existing);
  }

  setDirty(worktreePath: string, dirty: boolean): void {
    this.dirtyStates.set(worktreePath, dirty);
  }
}
