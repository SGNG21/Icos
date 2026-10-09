import { createHash } from "node:crypto";

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

/** `assertSlug`: `^[a-z0-9][a-z0-9_-]{0,31}$`, and it becomes a database name too. */
const SLUG_MAX = 32;
/** 32 bits of the task id. Four billion names per title, none of them truncatable away. */
const FINGERPRINT_CHARS = 8;

/**
 * Derives a stable slug from the task. Identity comes from the workflow id, not from this.
 *
 * UNDERSCORES ONLY, and that is not cosmetic. The slug becomes both a branch name and the
 * worker's dedicated test database, and `assertWorkerDatabaseName` enforces
 * `^icos_test_[a-z0-9_]{1,32}$` — a hyphen there makes workspace creation fail outright.
 * (The coordinator's own previous default, `task-<id>`, had exactly that bug; it was never
 * reached because the coordinator was dead code in production.)
 *
 * IT MUST DISTINGUISH TWO TASKS, and truncation cannot be trusted to.
 *
 * The discriminator used to be the task id's FIRST 8 alphanumerics, after a title cut to 18
 * — so two tasks of one mission whose titles agreed for 18 characters and whose ids agreed
 * for 8 got the SAME slug, hence the same branch, the same worktree path and the same worker
 * database. Sibling ids that differ in a late character (`…-c1-a` / `…-c1-b`, a uuid tail, a
 * numbered plan) are the normal case, not a contrived one.
 *
 * Nothing noticed while every refused branch disappeared: a workspace is reaped once its
 * commit is contained in the integration target, so an INTEGRATED predecessor freed the name
 * before its sibling asked for it. A REFUSED one does not — `REQUEST_CHANGES` and a failed
 * execution both keep their branch as evidence, deliberately — and from then on the sibling's
 * allocation hit `COLLISION: branche … déjà utilisée` on every pass. The mission then had a
 * prepared, correctly-retried, permanently un-allocatable intent: no false settlement, no
 * progress either (DEFECT 36 × 0050, CORRECTION_DAG_E2E and SUPERSEDED_ATTEMPT_WORKSPACE_HELD).
 *
 * So the whole id is fingerprinted rather than cut, and the parts that carry identity — the
 * fingerprint and the attempt — are budgeted first; only the human-readable title gives way
 * to the 32-character bound.
 */
export function workspaceSlug(task: AllocationTaskView, attempt = 1): string {
  /*
   * THE ATTEMPT IS PART OF THE IDENTITY past the first one, because a refused attempt's
   * branch survives as evidence and a correction attempt would otherwise collide with its
   * own predecessor. Reserved before the title, never sliced off the end: `_a10` truncated
   * to `_a1` would name two different attempts the same thing.
   */
  const tail = attempt <= 1 ? "" : `_a${attempt}`;
  const fingerprint = createHash("sha256")
    .update(task.taskId)
    .digest("hex")
    .slice(0, FINGERPRINT_CHARS);
  const room = SLUG_MAX - tail.length - 1 - fingerprint.length;
  const readable =
    task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+/, "")
      .slice(0, Math.max(room, 0))
      .replace(/_+$/, "") || "task";
  return `${readable}_${fingerprint}${tail}`;
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

/**
 * True when the task may only run in a governed workspace — a writer, including one refused for
 * an undeclared scope. The supervisor, its recovery path and integrated settlement all ask THIS,
 * so "governed work" has one definition (decision 0052).
 */
export function requiresGovernedWorkspace(task: AllocationTaskView): boolean {
  return decideWorkspaceAllocation(task).kind !== "NOT_REQUIRED";
}
