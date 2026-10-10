import type { z } from "zod";

import type { riskClassSchema } from "@/core/contracts/task";
import { requiresGovernedWorkspace } from "@/server/supervisor/workspace-allocation-policy";
import { effectiveScope } from "@/server/workspace-manager/checks";
import { checkScope } from "@/server/workspace-manager/scope";
import type { Git } from "@/server/workspace-manager/git";
import type { Workspace } from "@/server/workspace-manager/types";

/**
 * THE ONE PLACE A WORKER'S WORK BECOMES A COMMIT (ADR 0073).
 *
 * The worker holds no Git authority: it modifies files inside its allocated workspace and
 * writes its structured status, and that is all it can do — it never receives a writable
 * gitdir (proven on the real OS in `sandbox-escape.test.ts`). So the tree it leaves is not
 * yet anything the review or the gate can judge, and turning it into a commit is ICOS's job.
 *
 * WHY THIS IS A SHARED FUNCTION AND NOT CODE IN A DISPATCHER.
 *
 * There are two production execution paths — the Temporal activity and the in-process
 * external worker dispatcher — and the materialization used to exist in only ONE of them.
 * Measured consequence: every governed write routed through `ICOS_WORKER_EXEC_COMMANDS` (which
 * is every worker in every integration harness, and any deployment that configures one) left
 * its change uncommitted, and the gate refused it with `GATE_PRECONDITION: changements non
 * commités` — correct, and fatal to the whole chain. A second copy of this logic in the other
 * dispatcher would be the copy that drifts, so there is one implementation and both paths call
 * it.
 *
 * THE ORDER IS THE SECURITY PROPERTY, not a style choice:
 *
 *   1. the caller has already confirmed the execution SUCCEEDED (a failure, a timeout or a
 *      cancellation never reaches here — those paths throw or settle before calling);
 *   2. the workspace is resolved from the DURABLE registry by workflow id, and must still be
 *      bound to this very workflow and task — a workflow id is guessable, so it may never
 *      select a workspace on its own;
 *   3. the lease must still be live and the fencing token unchanged;
 *   4. the declared file scope must hold for every path the worker touched — checked BEFORE
 *      the commit, so an out-of-scope change never enters a commit at all, rather than being
 *      caught later by the gate;
 *   5. the lease and fencing token are revalidated again IMMEDIATELY before capture, because
 *      the window between "the worker finished" and "ICOS captures" is exactly where a
 *      takeover lands, and capturing then would commit a stranger's tree under our identity;
 *   6. the hardened Git authority materializes the exact tree (derived gitdir, no hooks, no
 *      filters, nested repositories and gitlinks refused, and the worktree must be on the
 *      granted branch);
 *   7. the resulting commit identity is persisted through `recordSourceCommit`, which
 *      revalidates the lease and the fencing token a third time under the registry's own
 *      lock. If THAT fails the commit exists but is not registered, so the gate sees no
 *      source commit and refuses — fail-closed, never a silent integration.
 *
 * Nothing here advances the integration target: the IntegrationApplier remains the only
 * writer allowed to do that.
 */


type RiskClass = z.infer<typeof riskClassSchema>;

/** What the finalizer needs. Ports only — it owns no connection and no process. */
export interface FinalizeWorkerExecutionDeps {
  /** The durable workspace registry, read by workflow id. */
  readonly workspaces: {
    list(): Promise<Workspace[]>;
    recordSourceCommit(
      workspaceId: string,
      commit: string,
      owner: string,
      expectedFencingToken: number,
    ): Promise<Workspace>;
  };
  /**
   * THE GIT AUTHORITY, BUILT FOR ONE REPOSITORY — the one the row names.
   *
   * Not a pre-bound port. `Git.exec` carries `repoDir: this.repoDir`, so a port IS a
   * repository binding, and a port injected from a process-global container is that
   * container's repository rather than this execution's. Measured: a worktree from one
   * governed execution resolved against another's `.git`, refused as unregistered, before
   * the capture could even begin. A factory makes the binding execution-scoped by
   * construction.
   */
  readonly gitFor: (repoDir: string) => Pick<Git, "statusPorcelain" | "headCommit">;
  /**
   * The hardened materialization. Injected rather than imported so this usecase stays a
   * policy: the one implementation is `git-authority.commitWorkerChanges`.
   */
  readonly materialize: (
    repoDir: string,
    worktree: string,
    expectedBranch: string,
    message: string,
  ) => Promise<void>;
  /**
   * The canonical TASK, read to answer one question: does this work REQUIRE governance?
   *
   * A reader is allocated no workspace, so "no workspace" is simply nothing to capture. A
   * WRITER without one ran outside governance, and reporting that as nothing-to-do would
   * finalize an execution whose work no gate ever saw (decision 0052's reasoning, applied at
   * the moment of capture).
   */
  readonly tasks: {
    getById(id: string): Promise<
      | {
          id: string;
          title: string;
          /* The canonical union, imported rather than restated: a copy drifts. */
          riskClass?: RiskClass;
          allowedFileScope?: readonly string[];
        }
      | null
      | undefined
    >;
  };
  readonly now?: () => Date;
}

export interface FinalizeWorkerExecutionInput {
  readonly workflowId: string;
  readonly taskId: string;
}

export type FinalizeWorkerExecutionOutcome =
  /** A commit was made, or there was nothing to commit. */
  | { readonly finalized: true; readonly commit: string | null; readonly reason: string }
  /** Fail-closed: nothing was committed, and the reason says why. */
  | { readonly finalized: false; readonly reason: string };

/**
 * Porcelain v1 is `XY <path>`, and `XY <old> -> <new>` for a rename — never a bare path.
 *
 * Reading it as a path is not a theoretical mistake: it made every file out-of-scope and the
 * finalizer refused work it should have captured. Quotes appear when the path needs escaping,
 * and the rename arrow means the NEW path is the one that must satisfy the scope.
 */
export function porcelainPaths(lines: readonly string[]): string[] {
  return lines.map((line) => {
    const raw = line.length > 3 ? line.slice(3) : line.trim();
    const arrow = raw.lastIndexOf(" -> ");
    const path = arrow >= 0 ? raw.slice(arrow + 4) : raw;
    return path.replace(/^"(.*)"$/, "$1");
  });
}

export async function finalizeSuccessfulWorkerExecution(
  deps: FinalizeWorkerExecutionDeps,
  input: FinalizeWorkerExecutionInput,
): Promise<FinalizeWorkerExecutionOutcome> {

  const now = deps.now ?? (() => new Date());

  const bound = (await deps.workspaces.list()).filter(
    (w) => w.workflowId === input.workflowId && w.releasedAt === null,
  );
  if (bound.length === 0) {
    /*
     * NO LIVE WORKSPACE — and whether that is innocent depends ENTIRELY on the task.
     *
     * A reader is allocated none, so there is nothing to capture and nothing to refuse. A
     * WRITER without one ran outside governance: nothing was branched, nothing can be gated,
     * and calling that "finalized" would let an execution whose work no gate ever saw be
     * recorded as a success. The predicate is the canonical one the grant route and the
     * integration settlement already use, so "governed work" keeps one definition.
     *
     * An unknown task is refused rather than assumed ungoverned: absence of evidence is not
     * evidence that nothing needed governing.
     */
    const task = await deps.tasks.getById(input.taskId);
    if (!task) {
      return { finalized: false, reason: "TASK_UNKNOWN" };
    }
    if (requiresGovernedWorkspace({ taskId: task.id, title: task.title, riskClass: task.riskClass, allowedFileScope: task.allowedFileScope })) {
      return { finalized: false, reason: "WORKSPACE_REQUIRED_BUT_ABSENT" };
    }
    return { finalized: true, commit: null, reason: "NOTHING_TO_MATERIALIZE" };
  }
  if (bound.length > 1) {
    return { finalized: false, reason: "WORKSPACE_AMBIGUOUS" };
  }

  const before = bound[0]!;
  if (before.taskId !== input.taskId) {
    /* A workflow id may never select a workspace belonging to another task. */
    return { finalized: false, reason: "WORKSPACE_TASK_MISMATCH" };
  }
  if (!before.branch) {
    return { finalized: false, reason: "WORKSPACE_HAS_NO_BRANCH" };
  }
  /*
   * THE REPOSITORY COMES FROM THE RECORD, bound by the allocator before any worker existed.
   *
   * Not from `process.env`, not from a container singleton, not from the worktree's own
   * pointer. A capture happens after the execution closes, so ambient state may have moved on
   * — measured as 145 worktrees being looked for in another repository's `.git` — and a
   * pointer inside the sandbox is the worker's side of the boundary, however read-only it is
   * today.
   *
   * A row written before this binding carries `null`, and that REFUSES. There is deliberately
   * no fallback: falling back to the ambient value is the defect, and a wrong repository is
   * worse than a stopped capture.
   */
  if (!before.canonicalRepo) {
    return { finalized: false, reason: "CANONICAL_REPO_UNBOUND" };
  }
  const leaseHeld = (w: Workspace): boolean =>
    w.leaseOwner !== null &&
    w.leaseExpiresAt !== null &&
    Date.parse(w.leaseExpiresAt) > now().getTime();
  if (!leaseHeld(before)) {
    return { finalized: false, reason: "LEASE_NOT_HELD" };
  }

  /*
   * FROM HERE ON, EVERY GIT READ IS BOUND TO THE ROW'S REPOSITORY. Built after the binding
   * has been proven present, so there is no moment at which this code holds a repository it
   * did not get from the record.
   */
  const git = deps.gitFor(before.canonicalRepo);

  /*
   * THE SCOPE IS CHECKED ON WHAT THE WORKER ACTUALLY TOUCHED, before anything is staged.
   * `statusPorcelain` is the uncommitted truth of the worktree; the gate re-checks the
   * committed diff afterwards, and the two agreeing is the point.
   */
  const changed = porcelainPaths(await git.statusPorcelain(before.worktreePath));
  if (changed.length === 0) {
    /* EMPTY_RESULT_COMMITTED=NO: nothing to capture is not something to commit. */
    return { finalized: true, commit: null, reason: "NOTHING_TO_MATERIALIZE" };
  }
  /*
   * THE GATE'S RULE, NOT A SECOND ONE. It rejects on `forbidden` or `outOfScope` and PERMITS
   * `SHARED_CHANGED` — a declared shared file changed is reported there, never refused.
   * Refusing on `status !== "PASS"` was stricter than the authority this anticipates, which
   * would have refused, before the commit, work the gate would have accepted. `effectiveScope`
   * is what applies BASELINE_FORBIDDEN (.env.local, secrets/**, *.pem), so those are forbidden
   * here exactly as they are there.
   */
  const scope = checkScope(effectiveScope(before), changed);
  const violations = [...scope.forbidden, ...scope.outOfScope];
  if (violations.length > 0) {
    return {
      finalized: false,
      reason: `OUT_OF_SCOPE:${scope.status}:${violations.slice(0, 5).join(",")}`,
    };
  }

  /* IMMEDIATELY BEFORE CAPTURE: the authority must still be ours, and the same. */
  const again = (await deps.workspaces.list()).find((w) => w.workspaceId === before.workspaceId);
  if (!again || again.releasedAt !== null || !leaseHeld(again)) {
    return { finalized: false, reason: "LEASE_LOST_BEFORE_CAPTURE" };
  }
  if (again.fencingToken !== before.fencingToken) {
    return { finalized: false, reason: "FENCED_OUT_BEFORE_CAPTURE" };
  }

  await deps.materialize(
    before.canonicalRepo,
    before.worktreePath,
    before.branch,
    `icos: record governed work of ${input.workflowId}`,
  );

  const commit = await git.headCommit(before.worktreePath);
  /* Revalidates the lease and the token a third time, under the registry's own lock. */
  await deps.workspaces.recordSourceCommit(
    before.workspaceId,
    commit,
    again.leaseOwner!,
    again.fencingToken,
  );

  return { finalized: true, commit, reason: "MATERIALIZED" };
}
