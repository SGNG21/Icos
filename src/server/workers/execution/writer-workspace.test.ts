import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runNonInteractive } from "@/server/workers/process/run-process";
import {
  WORKER_BRANCH_PREFIX,
  MAX_DIFF_BYTES,
  collectCommitEvidence,
  provisionWorkspace,
  type WorkerWorkspace,
} from "./writer-workspace";

/*
 * M6.3 WRITER ISOLATION, against REAL GIT.
 *
 * A throwaway repository is created per suite, so these prove the behaviour with
 * actual `git worktree` semantics while never touching the ICOS checkout — which is
 * itself the property under test.
 */

let repo: string;
let root: string;
const created: WorkerWorkspace[] = [];

const git = async (cwd: string, args: string[]) => {
  const result = await runNonInteractive({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "icos-wt-test-"));
  repo = join(root, "canonical");
  await git(root, ["init", "--initial-branch=main", "canonical"]);
  await git(repo, ["config", "user.email", "test@icos.local"]);
  await git(repo, ["config", "user.name", "ICOS Test"]);
  await writeFile(join(repo, "README.md"), "canonical\n", "utf8");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base"]);
});

afterAll(async () => {
  for (const workspace of created) await workspace.dispose().catch(() => {});
  await rm(root, { recursive: true, force: true });
});

async function writer(attemptKey: string): Promise<WorkerWorkspace> {
  const workspace = await provisionWorkspace({
    repoPath: repo,
    mode: "writer",
    attemptKey,
    rootDir: root,
  });
  created.push(workspace);
  return workspace;
}

describe("M6.3 writer worktree isolation", () => {
  it("WRITER_WORKTREE_ISOLATION: a writer NEVER receives the canonical checkout", async () => {
    const workspace = await writer("mt-1-a1");

    expect(workspace.path).not.toBe(repo);
    // Not merely different — not underneath it either.
    expect(workspace.path.startsWith(repo + "/")).toBe(false);
    expect(workspace.mode).toBe("writer");
    expect(workspace.branch).toContain(WORKER_BRANCH_PREFIX);
    expect(workspace.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    // It is a real, usable checkout.
    await stat(join(workspace.path, "README.md"));
  });

  it("A WRITER'S COMMIT DOES NOT MOVE THE CANONICAL CHECKOUT", async () => {
    const before = await git(repo, ["rev-parse", "HEAD"]);
    const beforeBranch = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const workspace = await writer("mt-2-a1");
    await writeFile(join(workspace.path, "worker-output.txt"), "work\n", "utf8");
    await git(workspace.path, ["add", "."]);
    await git(workspace.path, ["commit", "-m", "worker did work"]);

    /*
     * THE point of the isolation. The worker committed real work, and the
     * integration checkout neither moved nor changed branch — so a wrong run costs
     * a branch, not the repository.
     */
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(beforeBranch);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  });

  it("COMMIT_EVIDENCE_CAPTURE: the commit, its files and its hash are read from git", async () => {
    const workspace = await writer("mt-3-a1");
    await writeFile(join(workspace.path, "alpha.txt"), "a\n", "utf8");
    await writeFile(join(workspace.path, "beta.txt"), "b\n", "utf8");
    await git(workspace.path, ["add", "."]);
    await git(workspace.path, ["commit", "-m", "two files"]);
    const head = await git(workspace.path, ["rev-parse", "HEAD"]);

    const evidence = await collectCommitEvidence(workspace);

    // Evidence, not a claim: this is what git says happened.
    expect(evidence?.commitHash).toBe(head);
    expect(evidence?.commits).toEqual([head]);
    expect(evidence?.changedFiles).toEqual(["alpha.txt", "beta.txt"]);
    expect(evidence?.dirty).toBe(false);
    expect(evidence?.branch).toBe(workspace.branch);
  });

  it("SEVERAL COMMITS are all captured, oldest first", async () => {
    const workspace = await writer("mt-4-a1");
    const hashes: string[] = [];
    for (const name of ["one", "two", "three"]) {
      await writeFile(join(workspace.path, `${name}.txt`), name, "utf8");
      await git(workspace.path, ["add", "."]);
      await git(workspace.path, ["commit", "-m", name]);
      hashes.push(await git(workspace.path, ["rev-parse", "HEAD"]));
    }

    const evidence = await collectCommitEvidence(workspace);
    expect(evidence?.commits).toEqual(hashes);
    expect(evidence?.changedFiles).toEqual(["one.txt", "three.txt", "two.txt"]);
  });

  it("NOTHING COMMITTED means commitHash is NULL, not the base commit", async () => {
    const workspace = await writer("mt-5-a1");
    const evidence = await collectCommitEvidence(workspace);

    /* Reporting HEAD here would imply work was done when none was. */
    expect(evidence?.commitHash).toBeNull();
    expect(evidence?.commits).toEqual([]);
    expect(evidence?.dirty).toBe(false);
  });

  it("UNCOMMITTED WORK IS STILL EVIDENCE: dirty files are reported as changed", async () => {
    const workspace = await writer("mt-6-a1");
    await writeFile(join(workspace.path, "half-done.txt"), "partial\n", "utf8");

    const evidence = await collectCommitEvidence(workspace);

    // A worker that edited without committing has still changed something; hiding
    // it would claim less happened than actually did.
    expect(evidence?.dirty).toBe(true);
    expect(evidence?.changedFiles).toContain("half-done.txt");
    expect(evidence?.commitHash).toBeNull();
  });

  it("TWO WRITERS FOR THE SAME ATTEMPT KEY GET DIFFERENT BRANCHES", async () => {
    /*
     * A stale or colliding worktree has stalled dispatch before. `git worktree add
     * -b` refuses an existing branch, so a collision would be a hard failure rather
     * than two workers silently sharing one branch.
     */
    const a = await writer("mt-collide-a1");
    const b = await writer("mt-collide-a1");

    expect(a.branch).not.toBe(b.branch);
    expect(a.path).not.toBe(b.path);
  });

  it("DISPOSE removes the worktree but KEEPS the branch, because the branch IS the evidence", async () => {
    const workspace = await provisionWorkspace({
      repoPath: repo,
      mode: "writer",
      attemptKey: "mt-7-a1",
      rootDir: root,
    });
    await writeFile(join(workspace.path, "kept.txt"), "kept\n", "utf8");
    await git(workspace.path, ["add", "."]);
    await git(workspace.path, ["commit", "-m", "evidence"]);
    const head = await git(workspace.path, ["rev-parse", "HEAD"]);

    await workspace.dispose();

    // The checkout is gone...
    await expect(stat(workspace.path)).rejects.toThrow();
    // ...and the commit is still reachable by branch name from the canonical repo.
    expect(await git(repo, ["rev-parse", workspace.branch!])).toBe(head);
  });

  it("DEFECT 35 — THE EVIDENCE CARRIES THE CHANGE ITSELF, bounded and honestly flagged", async () => {
    const workspace = await provisionWorkspace({ repoPath: repo, mode: "writer", attemptKey: "d" });
    await writeFile(join(workspace.path, "note.md"), "hello reviewer\n");
    await git(workspace.path, ["add", "."]);
    await git(workspace.path, ["commit", "-m", "add note"]);

    const evidence = await collectCommitEvidence(workspace);

    /*
     * File names and a hash say THAT something changed, not WHAT. A reviewer given only
     * those can do nothing but escalate — and did, against a perfectly good change.
     */
    expect(evidence?.diff).toContain("hello reviewer");
    expect(evidence?.diff).toContain("note.md");
    expect(evidence?.diffTruncated).toBeUndefined();
    expect(evidence!.diff!.length).toBeLessThanOrEqual(MAX_DIFF_BYTES);

    await workspace.dispose();
  });

  it("DEFECT 35 — a runaway diff is TRUNCATED and says so, rather than filling a prompt", async () => {
    const workspace = await provisionWorkspace({ repoPath: repo, mode: "writer", attemptKey: "big" });
    await writeFile(join(workspace.path, "big.txt"), "x\n".repeat(MAX_DIFF_BYTES));
    await git(workspace.path, ["add", "."]);
    await git(workspace.path, ["commit", "-m", "big"]);

    const evidence = await collectCommitEvidence(workspace);

    expect(evidence!.diff!.length).toBe(MAX_DIFF_BYTES);
    expect(evidence?.diffTruncated).toBe(true);

    await workspace.dispose();
  });

  it("A READER SHARES the canonical checkout and creates NO branch", async () => {
    const workspace = await provisionWorkspace({ repoPath: repo, mode: "reader", attemptKey: "r" });

    // Deliberate asymmetry: a read cannot corrupt the checkout, and provisioning a
    // worktree per read would cost a full checkout for nothing.
    expect(workspace.path).toBe(repo);
    expect(workspace.mode).toBe("reader");
    expect(workspace.branch).toBeNull();
    // Null branch also records that a reader can produce no commit evidence.
    expect(await collectCommitEvidence(workspace)).toBeUndefined();
  });

  it("A WRITER WORKSPACE INSIDE THE CANONICAL REPO IS REFUSED", async () => {
    /*
     * If isolation silently did nothing, the run would LOOK isolated and would not
     * be — worse than failing outright.
     */
    await expect(
      provisionWorkspace({
        repoPath: repo,
        mode: "writer",
        attemptKey: "inside",
        rootDir: repo,
      }),
    ).rejects.toThrow(/WRITER_WORKSPACE_NOT_ISOLATED/);
  });
});
