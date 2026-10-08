import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { WorkerCommitEvidence } from "@/core/contracts/worker-execution";
import {
  addAdHocWorktree,
  pruneWorktrees,
  removeAdHocWorktree,
  runGuardedGit,
} from "@/server/workspace-manager/git-authority";

/**
 * WRITER ISOLATION (M6.3, requirement 6).
 *
 * THE INVARIANT
 * A writer worker NEVER receives the canonical integration checkout. It gets its
 * own git worktree on its own branch, and that is enforced here rather than
 * requested politely — `provisionWorkspace` REFUSES to hand a writer a path inside
 * the canonical repository.
 *
 * WHY THIS IS NOT PARANOIA
 * An external worker is an autonomous process running a model's decisions. Pointed
 * at the integration checkout it can stage, commit, amend, reset or checkout at
 * will, concurrently with the supervisor and with every other worker. A worktree
 * makes the blast radius a branch: if the run is wrong, the branch is deleted and
 * nothing else moved. It also makes "what did this worker actually change" a
 * question git can answer exactly, which is what turns a worker's CLAIM into
 * EVIDENCE.
 *
 * READERS may share the canonical checkout, because a read cannot corrupt it. That
 * is a deliberate asymmetry, not an oversight: provisioning a worktree per read
 * would cost a full checkout for nothing. A reader is handed an EMPTY
 * `allowedFileScope`, so nothing invites it to write.
 *
 * Worktrees are shared state across this machine, so every name here carries a
 * unique suffix and disposal is always attempted.
 */

export type WorkspaceMode = "writer" | "reader";

export interface WorkerWorkspace {
  /** Absolute path the worker must run in. */
  path: string;
  mode: WorkspaceMode;
  /** The dedicated branch. Null for a reader, which creates none. */
  branch: string | null;
  /** The commit the branch started from, so evidence can be diffed against it. */
  baseCommit: string | null;
  /**
   * The CANONICAL repository this worktree belongs to. Required to read a writer's
   * evidence: its gitdir is derived from here, never discovered from the worktree, whose
   * `.git` the worker controls (ADR 0072, phase 0).
   */
  repoPath?: string;
  /** Removes the worktree. The BRANCH is kept: it is the evidence. */
  dispose(): Promise<void>;
}

export interface ProvisionWorkspaceInput {
  /** The canonical repository. A writer is guaranteed NOT to work here. */
  repoPath: string;
  mode: WorkspaceMode;
  /**
   * Stable identity of the logical attempt (missionTaskId + attempt). It names the
   * branch, so the same logical attempt is recognisable in git afterwards.
   */
  attemptKey: string;
  /** What to branch from. Defaults to the repository's current HEAD. */
  baseRef?: string;
  /** Where worktrees are created. Defaults to the OS temp directory. */
  rootDir?: string;
}

export const GIT_TIMEOUT_MS = 30_000;
/** Branch namespace, so a worker branch is never mistaken for a human's. */
export const WORKER_BRANCH_PREFIX = "icos/worker";

/**
 * Git through the ONE privileged authority (ADR 0072, phase 0): fixed binary, constructed
 * environment, neutralised config surfaces. A `worktree` is addressed with a gitdir derived
 * from the canonical repository — its own `.git` belongs to the worker and is never read.
 */
async function git(repoPath: string, args: string[], worktree?: string): Promise<string> {
  const result = await runGuardedGit(args, {
    repoDir: repoPath,
    ...(worktree === undefined ? {} : { worktree }),
    timeoutMs: GIT_TIMEOUT_MS,
  });
  return result.stdout.trim();
}

/** A branch name that is unique per provisioning, from an opaque attempt key. */
export function workerBranchName(attemptKey: string, unique: string): string {
  const safe = attemptKey.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 80);
  return `${WORKER_BRANCH_PREFIX}/${safe}-${unique}`;
}

export async function provisionWorkspace(
  input: ProvisionWorkspaceInput,
): Promise<WorkerWorkspace> {
  const repoPath = resolve(input.repoPath);

  if (input.mode === "reader") {
    /*
     * A reader shares the canonical checkout. Nothing is created, so nothing is
     * disposed — and `branch: null` records that this workspace can produce no
     * commit evidence, rather than leaving a caller to infer it.
     */
    return {
      path: repoPath,
      mode: "reader",
      branch: null,
      baseCommit: null,
      dispose: async () => {},
    };
  }

  const baseRef = input.baseRef ?? "HEAD";
  const baseCommit = await git(repoPath, ["rev-parse", baseRef]);

  const root = await mkdtemp(join(input.rootDir ?? tmpdir(), "icos-worker-"));
  const path = join(root, "workspace");
  const branch = workerBranchName(input.attemptKey, root.slice(-8));

  try {
    // -b creates the branch; git refuses if it already exists, so two runs can
    // never silently share one branch.
    await addAdHocWorktree(repoPath, branch, path, baseCommit, GIT_TIMEOUT_MS);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  /*
   * THE ENFORCEMENT. A writer path inside the canonical repository would mean the
   * isolation silently did nothing, which is worse than failing: the run would
   * look isolated and would not be. Checked after the fact so it holds regardless
   * of how rootDir was configured.
   */
  if (resolve(path) === repoPath || resolve(path).startsWith(repoPath + "/")) {
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `WRITER_WORKSPACE_NOT_ISOLATED: refusing to run a writer inside the canonical checkout (${path})`,
    );
  }

  return {
    path,
    mode: "writer",
    branch,
    baseCommit,
    repoPath,
    dispose: async () => {
      // Never let cleanup mask the run's own outcome.
      try {
        await removeAdHocWorktree(repoPath, path, GIT_TIMEOUT_MS);
      } catch {
        /* fall through to the filesystem */
      }
      await rm(root, { recursive: true, force: true });
      try {
        await pruneWorktrees(repoPath, GIT_TIMEOUT_MS);
      } catch {
        /* nothing to do */
      }
    },
  };
}

/**
 * Reads what the worker ACTUALLY changed, from git — never from what it claimed.
 *
 * A worker reporting "committed the fix" is a claim. `git rev-parse HEAD` is
 * evidence. When they disagree, this is the one that counts.
 */
/** Enough for an ordinary reviewable change; a runaway agent cannot grow a prompt past it. */
export const MAX_DIFF_BYTES = 64 * 1024;

export async function collectCommitEvidence(
  workspace: WorkerWorkspace,
): Promise<WorkerCommitEvidence | undefined> {
  if (workspace.mode !== "writer" || !workspace.branch || !workspace.baseCommit) {
    /* A reader produces no commits: absent evidence, not empty evidence. */
    return undefined;
  }
  if (!workspace.repoPath) {
    /* No canonical repository, no derivable gitdir: never fall back to discovery. */
    throw new Error(
      "WORKER_EVIDENCE_REPO_UNKNOWN: a writer workspace must name its canonical repository",
    );
  }

  const repo = workspace.repoPath;
  const inWorktree = (args: string[]) => git(repo, args, workspace.path);
  const head = await inWorktree(["rev-parse", "HEAD"]);
  const range = `${workspace.baseCommit}..${head}`;

  const commitsRaw = await inWorktree(["rev-list", "--reverse", range]);
  const commits = commitsRaw ? commitsRaw.split("\n").filter(Boolean) : [];

  const committedFiles = commits.length
    ? (await inWorktree(["diff", "--name-only", range])).split("\n").filter(Boolean)
    : [];

  /*
   * Uncommitted work counts as a changed file too. A worker that edited without
   * committing has still changed something, and hiding that would make the
   * evidence claim less than actually happened.
   */
  const status = await inWorktree(["status", "--porcelain", "--ignore-submodules=dirty"]);
  const dirtyFiles = status
    ? status
        .split("\n")
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
    : [];

  /*
   * THE CHANGE ITSELF (defect 35). Without it the reviewer receives file names and a hash
   * and cannot judge content, which is most of what a review is. Bounded, because a runaway
   * agent's diff must not be able to fill a prompt or a row, and truncation is RECORDED so
   * the reviewer knows whether it saw the whole change.
   */
  const diffRaw = commits.length
    ? await inWorktree(["diff", "--unified=3", range])
    : "";
  const diff = diffRaw.slice(0, MAX_DIFF_BYTES);

  return {
    branch: workspace.branch,
    /* Null when nothing was committed: HEAD would otherwise imply work was done. */
    commitHash: commits.length ? head : null,
    commits,
    changedFiles: [...new Set([...committedFiles, ...dirtyFiles])].sort(),
    diff: diff.length ? diff : undefined,
    diffTruncated: diffRaw.length > diff.length ? true : undefined,
    dirty: dirtyFiles.length > 0,
  };
}
