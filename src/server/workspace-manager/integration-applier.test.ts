import { existsSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "./git";
import { InMemoryWorkspaceRegistry } from "./registry";
import { WorkspaceManager, type RequestWorkspaceInput } from "./manager";
import { IntegrationApplier } from "./integration-applier";
import { FakeProvisioner, makeRepoFixture, type RepoFixture } from "./test-fixtures";

/*
 * DEFECT 19 — EXACTLY_ONCE_WORKER_INTEGRATION_PROVEN, against REAL GIT.
 *
 * The gate said ACCEPT and then nothing happened: the branch accumulated and the canonical
 * target never moved. These prove the APPLY step that closes that, and prove just as hard
 * the things it must REFUSE — because an autonomous path that can move the canonical branch
 * is only safe if the list of ways it declines is complete.
 */

let fx: RepoFixture;
let manager: WorkspaceManager;
let applier: IntegrationApplier;
let git: Git;
let clock: number;

const LEASE = { owner: "integrator-1", fencingToken: 1 };

beforeEach(() => {
  fx = makeRepoFixture();
  clock = Date.parse("2026-09-28T10:00:00Z");
  git = new Git(fx.master);
  manager = new WorkspaceManager({
    git,
    registry: new InMemoryWorkspaceRegistry(),
    provisioner: new FakeProvisioner(),
    worktreeRoot: fx.root,
    masterRepo: fx.master,
    now: () => new Date(clock),
  });
  applier = new IntegrationApplier({ git, manager });
});
afterEach(() => fx.cleanup());

const input = (slug: string, over: Partial<RequestWorkspaceInput> = {}): RequestWorkspaceInput => ({
  slug,
  workerId: `worker-${slug}`,
  manual: true,
  integrationTarget: "integration/phase-7",
  fileScope: { owns: [`src/${slug}/**`], shared: [], forbidden: [] },
  ...over,
});

/**
 * Drives a workspace to `accepted` with a real commit, the way the gate does.
 *
 * `recordSourceCommit` + the accepted transition are exactly what `IntegrationGate`
 * performs on ACCEPT, so the applier is fed the same state production would give it.
 */
async function acceptedWorkspace(slug: string, file = "work.txt"): Promise<{
  id: string;
  commit: string;
}> {
  const ws = await manager.request(input(slug));
  await manager.create(ws.workspaceId);
  fx.write(ws.worktreePath, `src/${slug}/${file}`, `work by ${slug}\n`);
  const commit = fx.commit(ws.worktreePath, `${slug} work`);

  await manager.transition(ws.workspaceId, "working");
  await manager.transition(ws.workspaceId, "validating");
  await manager.transition(ws.workspaceId, "ready_for_integration");
  await manager.transition(ws.workspaceId, "integrating");
  await manager.recordSourceCommit(ws.workspaceId, commit, LEASE.owner, LEASE.fencingToken);
  await manager.transition(ws.workspaceId, "accepted");
  return { id: ws.workspaceId, commit };
}

const target = () => git.resolveCommit("integration/phase-7");

describe("DEFECT 19 — governed integration apply", () => {
  it("INTEGRATES an accepted result: the canonical target advances to that commit", async () => {
    const before = await target();
    const ws = await acceptedWorkspace("alpha");

    const outcome = await applier.apply(ws.id, { lease: LEASE });

    expect(outcome).toMatchObject({ status: "INTEGRATED", commit: ws.commit, previousTarget: before });
    /* The canonical branch really moved — read back from git, not from the return value. */
    expect(await target()).toBe(ws.commit);
  });

  it("EXACTLY_ONCE_WORKER_INTEGRATION: a second apply moves the target AT MOST once", async () => {
    const ws = await acceptedWorkspace("beta");

    const first = await applier.apply(ws.id, { lease: LEASE });
    const headAfterFirst = await target();
    const second = await applier.apply(ws.id, { lease: LEASE });
    const third = await applier.apply(ws.id, { lease: LEASE });

    expect(first.status).toBe("INTEGRATED");
    /*
     * Derived from git, not from a flag: the replay asks whether the commit is already
     * contained in the target, so it reaches the same answer a crashed run would.
     */
    expect(second).toEqual({ status: "ALREADY_INTEGRATED", commit: ws.commit });
    expect(third).toEqual({ status: "ALREADY_INTEGRATED", commit: ws.commit });
    /* The canonical HEAD moved once and stayed. */
    expect(await target()).toBe(headAfterFirst);
  });

  it("A CRASH BETWEEN THE REF UPDATE AND THE CALLER RESUMES SAFELY", async () => {
    const ws = await acceptedWorkspace("gamma");
    await applier.apply(ws.id, { lease: LEASE });
    const head = await target();

    /*
     * A brand-new applier, as a restarted process would build. Nothing is carried in
     * memory, and the exactly-once answer survives because it lives in the repository.
     */
    const restarted = new IntegrationApplier({ git: new Git(fx.master), manager });
    expect(await restarted.apply(ws.id, { lease: LEASE })).toMatchObject({
      status: "ALREADY_INTEGRATED",
    });
    expect(await target()).toBe(head);
  });

  it("CONCURRENT INTEGRATORS: two applies of DIFFERENT accepted results serialise", async () => {
    const a = await acceptedWorkspace("delta");
    const b = await acceptedWorkspace("epsilon");

    /*
     * Both branched from the same base, so only one can fast-forward. The other must NOT
     * be merged by machine — it is sent back to be rebased and re-gated.
     */
    const [ra, rb] = await Promise.all([
      applier.apply(a.id, { lease: LEASE }),
      applier.apply(b.id, { lease: LEASE }),
    ]);

    /*
     * Exactly one wins. The loser is RACE_LOST, not NEEDS_REBASE: both read the same target
     * and both were legal fast-forwards AT THAT MOMENT, so divergence only became true once
     * the winner's swap landed. That distinction is the compare-and-swap doing its job —
     * the loser never had a window in which it could also have moved the ref.
     */
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual(["INTEGRATED", "RACE_LOST"]);
    /* The target is exactly one of the two commits — never a machine-made merge. */
    expect([a.commit, b.commit]).toContain(await target());

    /* And the loser CONVERGES on a retry: it is now genuinely diverged, so it re-gates. */
    const loser = ra.status === "INTEGRATED" ? b : a;
    expect((await applier.apply(loser.id, { lease: LEASE })).status).toBe("NEEDS_REBASE");
  });

  it("A DIVERGED TARGET IS NEEDS_REBASE, never an automatic merge", async () => {
    const ws = await acceptedWorkspace("zeta");
    /* Someone else advanced the integration target in the meantime. */
    const other = await acceptedWorkspace("eta");
    await applier.apply(other.id, { lease: LEASE });

    const outcome = await applier.apply(ws.id, { lease: LEASE });

    expect(outcome.status).toBe("NEEDS_REBASE");
    /* Unchanged: a machine never resolves a conflict, it returns the work to the gate. */
    expect(await target()).toBe(other.commit);
  });

  it("ONLY THE GATE CAN GRANT INTEGRATION: a non-accepted workspace is REFUSED", async () => {
    const ws = await manager.request(input("theta"));
    await manager.create(ws.workspaceId);
    fx.write(ws.worktreePath, "src/theta/x.txt", "x\n");
    const commit = fx.commit(ws.worktreePath, "theta");
    await manager.transition(ws.workspaceId, "working");
    await manager.transition(ws.workspaceId, "validating");
    await manager.transition(ws.workspaceId, "ready_for_integration");
    await manager.transition(ws.workspaceId, "integrating");
    await manager.recordSourceCommit(ws.workspaceId, commit, LEASE.owner, LEASE.fencingToken);

    /*
     * `accepted` is reachable ONLY through the gate, so "worker output never self-merges"
     * is structural: there is no state a worker can put itself into that this accepts.
     */
    await expect(applier.apply(ws.workspaceId, { lease: LEASE })).rejects.toThrow(
      /INTEGRATION_REFUSED.*integrating/,
    );
    expect(await target()).not.toBe(commit);
  });

  it("A REJECTED RESULT CANNOT INTEGRATE", async () => {
    const ws = await manager.request(input("iota"));
    await manager.create(ws.workspaceId);
    fx.write(ws.worktreePath, "src/iota/x.txt", "x\n");
    const commit = fx.commit(ws.worktreePath, "iota");
    await manager.transition(ws.workspaceId, "working");
    await manager.transition(ws.workspaceId, "validating");
    await manager.transition(ws.workspaceId, "ready_for_integration");
    await manager.transition(ws.workspaceId, "integrating");
    await manager.recordSourceCommit(ws.workspaceId, commit, LEASE.owner, LEASE.fencingToken);
    await manager.transition(ws.workspaceId, "rejected");

    await expect(applier.apply(ws.workspaceId, { lease: LEASE })).rejects.toThrow(
      /INTEGRATION_REFUSED/,
    );
    expect(await target()).not.toBe(commit);
  });

  it("NO EVALUATED COMMIT means nothing to integrate", async () => {
    const ws = await manager.request(input("kappa"));
    await manager.create(ws.workspaceId);
    await manager.transition(ws.workspaceId, "working");
    await manager.transition(ws.workspaceId, "validating");
    await manager.transition(ws.workspaceId, "ready_for_integration");
    await manager.transition(ws.workspaceId, "integrating");
    await manager.transition(ws.workspaceId, "accepted");

    await expect(applier.apply(ws.workspaceId, { lease: LEASE })).rejects.toThrow(
      /aucun commit source/,
    );
  });

  it("A RELEASED WORKSPACE CANNOT INTEGRATE after reaping", async () => {
    const ws = await acceptedWorkspace("lambda");
    await applier.apply(ws.id, { lease: LEASE });
    await manager.cleanup(ws.id);

    await expect(applier.apply(ws.id, { lease: LEASE })).rejects.toThrow(/déjà libéré/);
  });

  it("REFUSES to move a branch that is CHECKED OUT in a worktree", async () => {
    /*
     * Moving a ref under a live worktree desynchronises its index from HEAD, silently
     * making every later `git status` there wrong.
     */
    const ws = await acceptedWorkspace("mu");
    const checkout = path.join(fx.root, "target-checkout");
    fx.git(fx.master, "worktree", "add", checkout, "integration/phase-7");

    await expect(applier.apply(ws.id, { lease: LEASE })).rejects.toThrow(/BRANCH_CHECKED_OUT/);
  });
});

describe("DEFECT 19 — WORKER_WORKTREE_REAPING_PROVEN", () => {
  it("REAPS the worktree and the branch AFTER integration, keeping a durable archive", async () => {
    const ws = await acceptedWorkspace("nu");
    const worktreePath = (await manager.get(ws.id)).worktreePath;
    const branch = (await manager.get(ws.id)).branch;
    await applier.apply(ws.id, { lease: LEASE });

    const result = await manager.cleanup(ws.id);

    expect(result.worktreeRemoved).toBe(true);
    /* Merged, so `branch -d` succeeds: the commits live on in the target. */
    expect(result.branchDeleted).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
    expect(await git.branchExists(branch)).toBe(false);
    /* Evidence outlives the branch: the archive is written BEFORE anything is removed. */
    expect(existsSync(result.archivePath)).toBe(true);
    /* And the work itself is still reachable from the canonical target. */
    expect(await git.isAncestor(ws.commit, await target())).toBe(true);
  });

  it("KEEPS AN UNMERGED BRANCH when a rejected workspace is reaped", async () => {
    const ws = await manager.request(input("xi"));
    await manager.create(ws.workspaceId);
    fx.write(ws.worktreePath, "src/xi/x.txt", "x\n");
    const commit = fx.commit(ws.worktreePath, "xi");
    await manager.transition(ws.workspaceId, "working");
    await manager.transition(ws.workspaceId, "validating");
    await manager.transition(ws.workspaceId, "ready_for_integration");
    await manager.transition(ws.workspaceId, "integrating");
    await manager.transition(ws.workspaceId, "rejected");

    const result = await manager.cleanup(ws.workspaceId);

    /*
     * DO NOT DELETE EVIDENCE. The work was never integrated, so the branch is the only
     * copy: cleanup reclaims the worktree and the database but keeps the commits.
     */
    expect(result.worktreeRemoved).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(await git.branchExists((await manager.get(ws.workspaceId)).branch)).toBe(true);
    expect(await git.commitExists(commit)).toBe(true);
  });

  it("REFUSES to reap a worktree holding UNCOMMITTED work", async () => {
    const ws = await acceptedWorkspace("omicron");
    fx.write((await manager.get(ws.id)).worktreePath, "src/omicron/dirty.txt", "not committed\n");

    /* Uncommitted work exists nowhere else; reaping it would destroy it silently. */
    await expect(manager.cleanup(ws.id)).rejects.toThrow(/UNCOMMITTED_CHANGES/);
  });
});
