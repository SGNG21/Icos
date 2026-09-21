import { WorkspaceError, type WorkspaceStatus } from "./types";
import type { WorktreeInfo, ChangedFile, AddedLine } from "./git";
import { Git } from "./git";

/** In-memory git implementation for memory-backed containers. */
export class InMemoryGit extends Git {
  private worktreesMap = new Map<string, { path: string; branch: string | null; head: string }>();
  private branches = new Map<string, string>();
  private commits = new Map<string, string>(); // ref -> commit hash
  private statusPorcelainMap = new Map<string, string[]>();
  private diffMap = new Map<string, ChangedFile[]>();
  private addedLinesMap = new Map<string, AddedLine[]>();

  constructor() {
    super("/tmp/mock-repo");
    // Initialize with a fake master repo
    this.commits.set("integration/phase-7", "0000000000000000000000000000000000000000");
    this.commits.set("HEAD", "0000000000000000000000000000000000000000");
    this.branches.set("integration/phase-7", "0000000000000000000000000000000000000000");
  }

  async exec(args: string[], cwd = ".", okCodes: number[] = [0]): Promise<{ code: number; stdout: string; stderr: string }> {
    // Simplified mock - just return success
    return { code: 0, stdout: "", stderr: "" };
  }

  protected async out(args: string[], cwd?: string): Promise<string> {
    const result = await this.exec(args, cwd);
    return result.stdout.trim();
  }

  async resolveCommit(ref: string, cwd?: string): Promise<string> {
    return this.commits.get(ref) ?? "0000000000000000000000000000000000000000";
  }

  async commitExists(ref: string): Promise<boolean> {
    return this.commits.has(ref);
  }

  async branchExists(branch: string): Promise<boolean> {
    return this.branches.has(branch);
  }

  async worktrees(): Promise<WorktreeInfo[]> {
    return Array.from(this.worktreesMap.values());
  }

  async addWorktree(worktreePath: string, branch: string, baseCommit: string): Promise<void> {
    this.worktreesMap.set(worktreePath, { path: worktreePath, branch, head: baseCommit });
    this.branches.set(branch, baseCommit);
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    this.worktreesMap.delete(worktreePath);
  }

  async deleteBranchIfMerged(branch: string): Promise<boolean> {
    this.branches.delete(branch);
    return true;
  }

  async statusPorcelain(cwd: string): Promise<string[]> {
    return this.statusPorcelainMap.get(cwd) ?? [];
  }

  async headCommit(cwd: string): Promise<string> {
    return this.commits.get("HEAD") ?? "0000000000000000000000000000000000000000";
  }

  async changedFiles(from: string, to: string): Promise<ChangedFile[]> {
    return this.diffMap.get(`${from}..${to}`) ?? [];
  }

  async addedLines(from: string, to: string): Promise<AddedLine[]> {
    return this.addedLinesMap.get(`${from}..${to}`) ?? [];
  }

  async diffCheck(from: string, to: string): Promise<{ ok: boolean; output: string }> {
    return { ok: true, output: "" };
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    return true;
  }

  async mergeBase(a: string, b: string): Promise<string> {
    return "0000000000000000000000000000000000000000";
  }

  async countCommits(range: string): Promise<number> {
    return 1;
  }

  async mergeConflicts(target: string, head: string): Promise<string[]> {
    return [];
  }

  async listDir(ref: string, dir: string): Promise<string[]> {
    return [];
  }

  async showFile(ref: string, file: string): Promise<string> {
    return "";
  }

  // Test helper methods
  __setCommit(ref: string, hash: string): void {
    this.commits.set(ref, hash);
  }

  __setBranch(branch: string, hash: string): void {
    this.branches.set(branch, hash);
  }

  __setStatusPorcelain(cwd: string, files: string[]): void {
    this.statusPorcelainMap.set(cwd, files);
  }

  __setChangedFiles(from: string, to: string, files: ChangedFile[]): void {
    this.diffMap.set(`${from}..${to}`, files);
  }
}