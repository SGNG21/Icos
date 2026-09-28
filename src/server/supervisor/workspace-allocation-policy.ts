import type { FileScope } from "@/server/workspace-manager/types";
import type { z } from "zod";
import type { riskClassSchema } from "@/core/contracts/task";

type RiskClass = z.infer<typeof riskClassSchema>;

/**
 * Decides whether a task needs a GOVERNED workspace, from CANONICAL TASK METADATA only
 * (M9, defect 23).
 *
 * WHAT IT MAY LOOK AT, AND WHY
 * `riskClass` and `allowedFileScope` describe what the WORK is allowed to do. That is the
 * only thing that determines whether an isolated, reviewable, integrable workspace is
 * required — a task that may modify files needs one, a task that may not does not.
 *
 * WHAT IT MUST NEVER LOOK AT
 * Provider, worker kind and model. Those describe WHO executes, which cannot change what
 * the work is permitted to touch. The supervisor's previous workspace branch gated on
 * `routedWorkerKind`, which is exactly that mistake: it meant an unrouted task silently
 * skipped governance, and it is the same provider-shaped routing the rest of CORE3 spent
 * four milestones removing.
 */

export type WorkspaceAllocationDecision =
  /** A writer: it must run in a registered workspace before any external execution. */
  | { kind: "GOVERNED"; fileScope: FileScope; slug: string }
  /** A reader: it mutates nothing, so a worktree would cost a checkout for nothing. */
  | { kind: "NOT_REQUIRED"; reason: string }
  /** A writer we cannot govern. Fail closed — never silently run it ungoverned. */
  | { kind: "REFUSED"; reason: string };

export interface AllocationTaskView {
  taskId: string;
  title: string;
  riskClass?: RiskClass;
  allowedFileScope?: readonly string[];
}

/**
 * Derives a stable slug from the task. Identity comes from the workflow id, not from this.
 *
 * UNDERSCORES ONLY, and that is not cosmetic. The slug becomes both a branch name and the
 * worker's dedicated test database, and `assertWorkerDatabaseName` enforces
 * `^icos_test_[a-z0-9_]{1,32}$` — a hyphen there makes workspace creation fail outright.
 * (The coordinator's own previous default, `task-<id>`, had exactly that bug; it was never
 * reached because the coordinator was dead code in production.)
 *
 * Bounded to 32 characters total for the same reason.
 */
export function workspaceSlug(task: AllocationTaskView): string {
  const fromTitle = task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 18);
  const suffix = task.taskId.replace(/[^a-z0-9]+/gi, "").slice(0, 8).toLowerCase();
  return `${fromTitle || "task"}_${suffix}`.slice(0, 32);
}

export function decideWorkspaceAllocation(
  task: AllocationTaskView,
): WorkspaceAllocationDecision {
  /*
   * `read_only` is the ONLY class that mutates nothing. Absent metadata is treated as a
   * writer: the canonical contract defaults `riskClass` to `reversible`, and guessing
   * "reader" for an undeclared task would silently skip governance for exactly the tasks
   * whose intent nobody wrote down.
   */
  if (task.riskClass === "read_only") {
    return { kind: "NOT_REQUIRED", reason: "riskClass read_only: the task mutates nothing" };
  }

  const scope = task.allowedFileScope ?? [];
  if (scope.length === 0) {
    /*
     * A writer with no declared scope CANNOT be governed. Not a technicality: the
     * Integration Gate rejects every file outside `owns`, so an empty scope guarantees
     * rejection — and the alternatives are worse. Inventing a permissive scope would let
     * an autonomous agent write anywhere, and falling back to an ad-hoc worktree is the
     * orphan-branch defect this whole milestone exists to close. Blocking is recoverable;
     * the other two are not.
     */
    return {
      kind: "REFUSED",
      reason:
        "WORKSPACE_SCOPE_UNDECLARED: a writer task must declare allowedFileScope; refusing to run it ungoverned",
    };
  }

  return {
    kind: "GOVERNED",
    /* The declared scope IS the workspace's scope: one source of truth, not two. */
    fileScope: { owns: [...scope], shared: [], forbidden: [] },
    slug: workspaceSlug(task),
  };
}
