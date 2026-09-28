import type { Git } from "./git";
import type { WorkspaceManager } from "./manager";
import { WorkspaceError, type Workspace } from "./types";

/**
 * APPLIES an accepted worker result to the integration target (M8, defect 19).
 *
 * WHY THIS EXISTS
 * `IntegrationGate` evaluates and says so in its own header: "Ne merge rien : ACCEPT
 * signifie « prêt à être intégré »". That was correct while a human did the merge. It is
 * not sufficient for autonomous self-development, where nothing at all happened to an
 * ACCEPTed result: the branch simply accumulated.
 *
 * This EXTENDS the canonical boundary rather than adding a second merge path. It lives in
 * the workspace manager, uses the same `Git` port, the same lease and fencing token, and
 * the same lifecycle. There is no other way to move the integration target.
 *
 * FAST-FORWARD ONLY, BY COMPARE-AND-SWAP
 * The target advances only when the accepted commit already contains it. That single rule
 * buys everything that matters here:
 *   - no merge commit is ever created by a machine;
 *   - no conflict is ever resolved by a machine — a diverged target is NEEDS_REBASE, which
 *     sends the work back through the gate where a human or agent resolves it;
 *   - the target's history can never be rewritten or lost;
 *   - `git update-ref <new> <expectedOld>` is atomic, so two integrators racing cannot both
 *     win and there is no read-then-write window.
 *
 * EXACTLY-ONCE IS DERIVED, NOT COUNTED
 * "Already integrated" is answered by asking git whether the accepted commit is an ancestor
 * of the target — not by a flag that could drift from reality, and not by a counter that a
 * crash could leave wrong. A replay after a crash mid-integration therefore reaches the
 * same answer as the run that crashed, because the answer is a property of the repository.
 */

export type IntegrationApplyOutcome =
  /** The target moved to this commit. Happens at most once per accepted result. */
  | { status: "INTEGRATED"; commit: string; previousTarget: string }
  /** The accepted commit is already contained in the target. A safe, silent replay. */
  | { status: "ALREADY_INTEGRATED"; commit: string }
  /** The target advanced underneath us: re-gate, never auto-merge. */
  | { status: "NEEDS_REBASE"; targetCommit: string; sourceCommit: string }
  /** Another integrator won the compare-and-swap. Retryable, not an error. */
  | { status: "RACE_LOST"; targetCommit: string };

export interface ApplyOptions {
  /** Mandatory durable ownership evidence, exactly as the gate requires. */
  lease: { owner: string; fencingToken: number };
}

interface ApplierDeps {
  git: Git;
  manager: WorkspaceManager;
}

export class IntegrationApplier {
  private readonly git: Git;
  private readonly manager: WorkspaceManager;

  constructor(deps: ApplierDeps) {
    this.git = deps.git;
    this.manager = deps.manager;
  }

  async apply(workspaceId: string, options: ApplyOptions): Promise<IntegrationApplyOutcome> {
    const ws = await this.manager.get(workspaceId);
    this.assertIntegrable(ws);

    /*
     * FENCE FIRST. A stale owner must not be able to move the canonical target, even
     * holding a report that said ACCEPT: the gate that produced it may have been
     * superseded by a newer run of the same workspace.
     */
    await this.manager.assertLease(workspaceId, options.lease.owner, options.lease.fencingToken);

    const source = ws.sourceCommit!;
    const target = await this.git.resolveCommit(ws.integrationTarget);

    /*
     * EXACTLY-ONCE, asked of git rather than of a flag. True after a successful apply, and
     * equally true after a crash that committed the ref but not the bookkeeping.
     */
    if (await this.git.isAncestor(source, target)) {
      return { status: "ALREADY_INTEGRATED", commit: source };
    }

    /*
     * FAST-FORWARD ONLY. If the target is not an ancestor of the accepted commit, the two
     * have diverged and integrating would require a merge — a decision this path is
     * deliberately incapable of making.
     */
    if (!(await this.git.isAncestor(target, source))) {
      return { status: "NEEDS_REBASE", targetCommit: target, sourceCommit: source };
    }

    const swapped = await this.git.compareAndSwapBranch(ws.integrationTarget, target, source);
    if (!swapped) {
      /* Someone else moved the target between the read and the swap. Re-run to re-evaluate. */
      return { status: "RACE_LOST", targetCommit: await this.git.resolveCommit(ws.integrationTarget) };
    }

    return { status: "INTEGRATED", commit: source, previousTarget: target };
  }

  /**
   * The preconditions, all fail-closed.
   *
   * `accepted` is required and is produced ONLY by the gate: nothing else can reach it,
   * so an unreviewed or rejected result has no path here. This is what makes "worker output
   * never self-merges" a structural property rather than a convention.
   */
  private assertIntegrable(ws: Workspace): void {
    const refuse = (why: string) =>
      new WorkspaceError("INTEGRATION_REFUSED", `${ws.workspaceId}: ${why}`);

    if (ws.releasedAt) throw refuse("workspace déjà libéré");
    if (ws.status !== "accepted") {
      throw refuse(`statut ${ws.status} (accepted requis — seule la gate peut l'accorder)`);
    }
    if (!ws.sourceCommit) {
      /* The gate records this; its absence means no evaluated commit exists to integrate. */
      throw refuse("aucun commit source enregistré par l'Integration Gate");
    }
  }
}
