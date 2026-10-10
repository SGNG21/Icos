import { describe, expect, it, vi } from "vitest";

import {
  finalizeSuccessfulWorkerExecution,
  porcelainPaths,
  type FinalizeWorkerExecutionDeps,
} from "@/server/usecases/finalize-successful-worker-execution";
import { normalizeScope } from "@/server/workspace-manager/scope";
import type { Workspace } from "@/server/workspace-manager/types";

/**
 * THE ONE PLACE A WORKER'S WORK BECOMES A COMMIT (ADR 0073), tested as the security boundary
 * it is.
 *
 * The worker holds no Git authority, so everything the review and the gate later judge exists
 * because this function decided to create it. What it must refuse therefore matters more than
 * what it accepts, and the first version of it refused EVERYTHING for a reason no integration
 * suite could name: it fed raw porcelain lines to `checkScope`, so `?? src/x/feature.txt` was
 * compared against `src/x/**` and read as out-of-scope. Seven governed writes were refused and
 * the chain timed out behind them. Hence a parser tested on its own, against the shapes git
 * actually emits.
 */

const WORKTREE = "/trees/w1";

const workspace = (over: Partial<Workspace> = {}): Workspace =>
  ({
    workspaceId: "ws-1",
    slug: "w1",
    branch: "ws/w1",
    worktreePath: WORKTREE,
    integrationTarget: "integration/phase-7",
    baseCommit: "base000",
    sourceCommit: null,
    status: "ready",
    missionId: "m-1",
    taskId: "t-1",
    workflowId: "icos-task-t-1",
    workerId: "worker-1",
    leaseOwner: "coordinator-1",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    fencingToken: 7,
    releasedAt: null,
    createdAt: new Date().toISOString(),
    testDatabase: "icos_test_w1",
    /* NORMALISED, as `manager.request` stores it — that is what carries BASELINE_FORBIDDEN. */
    fileScope: normalizeScope({ owns: ["src/w1/**"], shared: [], forbidden: [] }),
    /* BOUND AT ALLOCATION: the capture reads the repository from here, never from env. */
    canonicalRepo: "/repo",
    ...over,
  }) as unknown as Workspace;

/** Ports only: no git runs, so what is asserted is the DECISION, not git's behaviour. */
function deps(
  porcelain: string[],
  over: {
    workspaces?: Workspace[];
    head?: string;
    secondRead?: Workspace[];
    /* `undefined` = an ordinary writer task; `null` = the task does not exist. */
    task?: { id: string; title: string; riskClass?: "read_only" | "reversible" | "sensitive"; allowedFileScope?: readonly string[] } | null;
  } = {},
) {
  const rows = over.workspaces ?? [workspace()];
  let reads = 0;
  const recordSourceCommit = vi.fn(async (_id: string, commit: string) => {
    const w = workspace({ sourceCommit: commit });
    return w;
  });
  /* Typed like the real materialization, so the recorded arguments are assertable. */
  const gitRepos: string[] = [];
  const materialize = vi.fn(
    async (_repo: string, _worktree: string, _branch: string, _message: string) => undefined,
  );
  const tasks = {
    getById: async () =>
      over.task === undefined
        ? { id: "t-1", title: "Add t-1 feature", riskClass: "reversible" as const, allowedFileScope: ["src/w1/**"] }
        : over.task,
  } as unknown as FinalizeWorkerExecutionDeps["tasks"];
  const d: FinalizeWorkerExecutionDeps = {
    workspaces: {
      list: async () => {
        reads += 1;
        return reads === 1 ? rows : (over.secondRead ?? rows);
      },
      recordSourceCommit,
    },
    /*
     * A FACTORY, and it records what it was asked for. The repository a capture reads with is
     * the thing that went wrong in production, so the test holds it as data rather than
     * trusting a port someone else bound.
     */
    gitFor: (repoDir: string) => {
      gitRepos.push(repoDir);
      return {
        statusPorcelain: async () => porcelain,
        headCommit: async () => over.head ?? "commit111",
      };
    },
    materialize,
    tasks,
  };
  return { d, materialize, recordSourceCommit, tasks, gitRepos };
}

const run = (d: FinalizeWorkerExecutionDeps) =>
  finalizeSuccessfulWorkerExecution(d, { workflowId: "icos-task-t-1", taskId: "t-1" });

describe("porcelainPaths — the shapes git actually emits", () => {
  it("reads every ordinary status code as the path it carries", () => {
    expect(
      porcelainPaths([
        "?? src/foo.ts",
        " M src/foo.ts",
        "M  src/foo.ts",
        "A  src/foo.ts",
        "D  src/foo.ts",
        "MM src/foo.ts",
        "AM src/foo.ts",
      ]),
    ).toEqual([
      "src/foo.ts",
      "src/foo.ts",
      "src/foo.ts",
      "src/foo.ts",
      "src/foo.ts",
      "src/foo.ts",
      "src/foo.ts",
    ]);
  });

  it("keeps a path that contains spaces whole", () => {
    expect(porcelainPaths(["?? src/w1/a file with spaces.ts"])).toEqual([
      "src/w1/a file with spaces.ts",
    ]);
  });

  it("unquotes the quoted form git uses for paths needing escaping", () => {
    expect(porcelainPaths(['?? "src/w1/accentué.ts"'])).toEqual(["src/w1/accentué.ts"]);
  });

  it("A RENAME IS JUDGED ON ITS DESTINATION: that is where the bytes now live", () => {
    expect(porcelainPaths(["R  src/w1/old.ts -> src/w1/new.ts"])).toEqual(["src/w1/new.ts"]);
    expect(porcelainPaths(['R  "src/w1/old one.ts" -> "src/w1/new one.ts"'])).toEqual([
      "src/w1/new one.ts",
    ]);
  });

  it("does not mistake a path that merely contains an arrow for a rename", () => {
    expect(porcelainPaths(["?? src/w1/a->b.ts"])).toEqual(["src/w1/a->b.ts"]);
  });
});

describe("the finalizer captures only what it is allowed to", () => {
  it("MATERIALIZES in-scope work and records the commit identity", async () => {
    const { d, materialize, recordSourceCommit } = deps(["?? src/w1/feature.ts"]);

    const outcome = await run(d);

    expect(outcome).toEqual({ finalized: true, commit: "commit111", reason: "MATERIALIZED" });
    expect(materialize).toHaveBeenCalledWith(
      "/repo",
      WORKTREE,
      "ws/w1",
      expect.stringContaining("icos-task-t-1"),
    );
    /* The lease owner and the fencing token are carried into the record, not assumed. */
    expect(recordSourceCommit).toHaveBeenCalledWith("ws-1", "commit111", "coordinator-1", 7);
  });

  it("REFUSES an out-of-scope file, and commits NOTHING", async () => {
    const { d, materialize } = deps(["?? src/other/sneaky.ts"]);

    const outcome = await run(d);

    expect(outcome.finalized).toBe(false);
    expect(outcome.finalized === false && outcome.reason).toMatch(/^OUT_OF_SCOPE:/);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES a rename whose DESTINATION leaves the scope", async () => {
    const { d, materialize } = deps(["R  src/w1/ok.ts -> src/elsewhere/ok.ts"]);

    expect((await run(d)).finalized).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("ACCEPTS a rename whose destination stays inside the scope", async () => {
    const { d, materialize } = deps(["R  src/w1/old.ts -> src/w1/new.ts"]);

    expect((await run(d)).finalized).toBe(true);
    expect(materialize).toHaveBeenCalledTimes(1);
  });

  it("REFUSES a path that escapes the worktree, fail-closed", async () => {
    const { d, materialize } = deps(["?? ../outside/evil.ts", "?? src/w1/ok.ts"]);

    expect((await run(d)).finalized).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES a baseline-forbidden file even when the scope would own it", async () => {
    /* `effectiveScope` applies BASELINE_FORBIDDEN, so a key is refused however broad `owns` is. */
    const { d, materialize } = deps(["?? secrets/id_rsa.pem"], {
      workspaces: [
        workspace({ fileScope: normalizeScope({ owns: ["**"], shared: [], forbidden: [] }) }),
      ],
    });

    expect((await run(d)).finalized).toBe(false);
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("the finalizer refuses without authority", () => {
  it("REFUSES when the lease has expired", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      workspaces: [workspace({ leaseExpiresAt: new Date(Date.now() - 1).toISOString() })],
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "LEASE_NOT_HELD" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES when the fencing token changed between the scope check and the capture", async () => {
    /*
     * The real race: the worker finished, and another owner took the workspace over before
     * ICOS captured it. Capturing then would commit a stranger's tree under our workflow id.
     */
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      secondRead: [workspace({ fencingToken: 8 })],
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "FENCED_OUT_BEFORE_CAPTURE" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES when the workspace was released between the two reads", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      secondRead: [workspace({ releasedAt: new Date().toISOString() })],
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "LEASE_LOST_BEFORE_CAPTURE" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES a workspace bound to ANOTHER task: a workflow id selects nothing on its own", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      workspaces: [workspace({ taskId: "t-2" })],
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "WORKSPACE_TASK_MISMATCH" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES when two live workspaces claim the same workflow", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      workspaces: [workspace(), workspace({ workspaceId: "ws-2" })],
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "WORKSPACE_AMBIGUOUS" });
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("the finalizer is idempotent, and never invents work", () => {
  it("COMMITS NOTHING when the worker changed nothing", async () => {
    const { d, materialize, recordSourceCommit } = deps([]);

    expect(await run(d)).toEqual({
      finalized: true,
      commit: null,
      reason: "NOTHING_TO_MATERIALIZE",
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(recordSourceCommit).not.toHaveBeenCalled();
  });

  it("A DUPLICATE COMPLETION makes no second commit: the tree is already clean", async () => {
    /*
     * What a replayed Temporal callback or a retried settle actually looks like: the first
     * finalization committed the tree, so the second finds nothing uncommitted. No divergent
     * commit, and no second write of the identity.
     */
    const first = deps(["?? src/w1/feature.ts"]);
    expect((await run(first.d)).finalized).toBe(true);
    expect(first.materialize).toHaveBeenCalledTimes(1);

    const second = deps([], {
      workspaces: [workspace({ sourceCommit: "commit111", status: "validating" })],
    });
    const outcome = await run(second.d);

    expect(outcome).toEqual({ finalized: true, commit: null, reason: "NOTHING_TO_MATERIALIZE" });
    expect(second.materialize).not.toHaveBeenCalled();
    expect(second.recordSourceCommit).not.toHaveBeenCalled();
  });

  it("A READ-ONLY TASK with no workspace has simply nothing to capture", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      workspaces: [],
      task: { id: "t-1", title: "Read the logs", riskClass: "read_only" },
    });

    expect(await run(d)).toEqual({
      finalized: true,
      commit: null,
      reason: "NOTHING_TO_MATERIALIZE",
    });
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("C — the canonical repository is bound at allocation and carried on the record", () => {
  it("MATERIALIZES INTO THE PERSISTED REPOSITORY, whatever the ambient value is now", async () => {
    /*
     * The capture happens after the execution closes, so ambient state may have moved on.
     * Changing it here must change NOTHING: the binding is on the row.
     */
    const previous = process.env.ICOS_REPO_PATH;
    process.env.ICOS_REPO_PATH = "/some/other/repo";
    try {
      const { d, materialize } = deps(["?? src/w1/feature.ts"], {
        workspaces: [workspace({ canonicalRepo: "/bound/at/allocation" })],
      });

      expect((await run(d)).finalized).toBe(true);
      expect(materialize).toHaveBeenCalledWith(
        "/bound/at/allocation",
        WORKTREE,
        "ws/w1",
        expect.anything(),
      );
    } finally {
      if (previous === undefined) delete process.env.ICOS_REPO_PATH;
      else process.env.ICOS_REPO_PATH = previous;
    }
  });

  it("TWO CONCURRENT WORKSPACES CANNOT CROSS-BIND: each captures into its own repository", async () => {
    const a = deps(["?? src/w1/feature.ts"], {
      workspaces: [workspace({ workflowId: "icos-task-t-1", canonicalRepo: "/repo/a" })],
    });
    expect((await run(a.d)).finalized).toBe(true);

    const b = deps(["?? src/w1/feature.ts"], {
      workspaces: [workspace({ workflowId: "icos-task-t-1", canonicalRepo: "/repo/b" })],
    });
    expect((await run(b.d)).finalized).toBe(true);

    expect(a.materialize.mock.calls[0]![0]).toBe("/repo/a");
    expect(b.materialize.mock.calls[0]![0]).toBe("/repo/b");
  });

  it("A RESTART READS THE SAME BINDING, because it lives in persistence", async () => {
    /* A fresh process has no memory; the row is the memory. */
    const reloaded = workspace({ canonicalRepo: "/repo/persisted" });
    const { d, materialize } = deps(["?? src/w1/feature.ts"], { workspaces: [reloaded] });

    expect((await run(d)).finalized).toBe(true);
    expect(materialize.mock.calls[0]![0]).toBe("/repo/persisted");
  });

  it("A LEGACY ROW WITH NO BINDING REFUSES, and does not fall back to the environment", async () => {
    const previous = process.env.ICOS_REPO_PATH;
    process.env.ICOS_REPO_PATH = "/tempting/fallback";
    try {
      const { d, materialize } = deps(["?? src/w1/feature.ts"], {
        workspaces: [workspace({ canonicalRepo: null })],
      });

      expect(await run(d)).toEqual({ finalized: false, reason: "CANONICAL_REPO_UNBOUND" });
      expect(materialize).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.ICOS_REPO_PATH;
      else process.env.ICOS_REPO_PATH = previous;
    }
  });

  it("THE WORKTREE PATH CANNOT REDIRECT THE REPOSITORY: only the record decides", async () => {
    /*
     * A worktree whose path suggests another repository changes nothing — the finalizer never
     * reads the worktree's pointer, so there is no discovery for a worker to aim at. (It
     * cannot write that pointer either; `sandbox-escape.test.ts` proves that on the OS.)
     */
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      workspaces: [
        workspace({ worktreePath: "/attacker/repo/trees/w1", canonicalRepo: "/repo/real" }),
      ],
    });

    expect((await run(d)).finalized).toBe(true);
    expect(materialize).toHaveBeenCalledWith(
      "/repo/real",
      "/attacker/repo/trees/w1",
      "ws/w1",
      expect.anything(),
    );
  });

  it("A WRONG REPOSITORY/WORKTREE PAIRING IS REFUSED BY THE AUTHORITY, not papered over", async () => {
    /*
     * The hardened authority refuses a worktree that is not registered in the repository it
     * was handed — the real refusal, surfaced rather than swallowed.
     */
    const { d, recordSourceCommit } = deps(["?? src/w1/feature.ts"]);
    const failing: FinalizeWorkerExecutionDeps = {
      ...d,
      materialize: async () => {
        throw new Error("WORKTREE_UNREGISTERED: pas un worktree enregistré");
      },
    };

    await expect(run(failing)).rejects.toThrow(/WORKTREE_UNREGISTERED/);
    expect(recordSourceCommit).not.toHaveBeenCalled();
  });
});

describe("C — a governed writer whose workspace vanished is never finalized", () => {
  it("REFUSES a writer with no live workspace", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], {
      workspaces: [],
      task: { id: "t-1", title: "Add t-1 feature", riskClass: "reversible", allowedFileScope: ["src/w1/**"] },
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "WORKSPACE_REQUIRED_BUT_ABSENT" });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("REFUSES a writer with an UNDECLARED scope too: it is governed work we cannot govern", async () => {
    const { d } = deps(["?? src/w1/feature.ts"], {
      workspaces: [],
      task: { id: "t-1", title: "Add t-1 feature", riskClass: "reversible" },
    });

    expect(await run(d)).toEqual({ finalized: false, reason: "WORKSPACE_REQUIRED_BUT_ABSENT" });
  });

  it("REFUSES when the task is unknown: absence of evidence is not evidence of a reader", async () => {
    const { d, materialize } = deps(["?? src/w1/feature.ts"], { workspaces: [], task: null });

    expect(await run(d)).toEqual({ finalized: false, reason: "TASK_UNKNOWN" });
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("the repository authority is EXECUTION-SCOPED, never the process's", () => {
  /*
   * The defect this closes: `getContainer()` memoises a container on `globalThis`, and a
   * `Git` port carries its own `repoDir`. A port taken from that container belongs to
   * whichever composition ran first, so a capture read one execution's worktree against
   * another's repository and was refused as unregistered — while the persisted row was
   * correct the whole time. Nothing here resets a container, because nothing may depend on
   * that: the binding must come from the row.
   */
  const inRepo = (root: string) =>
    workspace({
      canonicalRepo: `${root}/master`,
      worktreePath: `${root}/trees/w1`,
      fileScope: normalizeScope({ owns: ["src/w1/**"], shared: [], forbidden: [] }),
    });

  it("A THEN B in one process: each capture uses its own persisted repository", async () => {
    const a = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/a")] });
    expect((await run(a.d)).finalized).toBe(true);
    const b = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/b")] });
    expect((await run(b.d)).finalized).toBe(true);

    expect(a.gitRepos).toEqual(["/repo/a/master"]);
    expect(b.gitRepos).toEqual(["/repo/b/master"]);
    expect(a.materialize.mock.calls[0]![0]).toBe("/repo/a/master");
    expect(b.materialize.mock.calls[0]![0]).toBe("/repo/b/master");
  });

  it("B THEN A: order cannot pin the authority either", async () => {
    const b = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/b")] });
    expect((await run(b.d)).finalized).toBe(true);
    const a = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/a")] });
    expect((await run(a.d)).finalized).toBe(true);

    expect(b.gitRepos).toEqual(["/repo/b/master"]);
    expect(a.gitRepos).toEqual(["/repo/a/master"]);
  });

  it("THREE REPOSITORIES SEQUENTIALLY: no drift across a run", async () => {
    for (const root of ["/repo/one", "/repo/two", "/repo/three"]) {
      const d = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo(root)] });
      expect((await run(d.d)).finalized).toBe(true);
      expect(d.gitRepos).toEqual([`${root}/master`]);
      expect(d.materialize.mock.calls[0]![0]).toBe(`${root}/master`);
    }
  });

  it("CONCURRENT CAPTURES in two repositories do not borrow each other's authority", async () => {
    const a = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/a")] });
    const b = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/b")] });

    const [ra, rb] = await Promise.all([run(a.d), run(b.d)]);

    expect(ra.finalized).toBe(true);
    expect(rb.finalized).toBe(true);
    expect(a.gitRepos).toEqual(["/repo/a/master"]);
    expect(b.gitRepos).toEqual(["/repo/b/master"]);
  });

  it("THE REPOSITORY READ AND THE REPOSITORY WRITTEN ARE THE SAME, and both are the row's", async () => {
    const { d, materialize, gitRepos } = deps(["?? src/w1/feature.ts"], {
      workspaces: [inRepo("/repo/only")],
    });

    expect((await run(d)).finalized).toBe(true);
    expect(gitRepos).toEqual(["/repo/only/master"]);
    expect(materialize.mock.calls[0]![0]).toBe("/repo/only/master");
    expect(gitRepos[0]).toBe(materialize.mock.calls[0]![0]);
  });

  it("A PORT BOUND TO REPOSITORY X CANNOT SERVE AN EXECUTION IN Y", async () => {
    /*
     * The old shape, expressed: a factory that ignores what it is asked for and answers with
     * X's port — which is what an injected container port did. Its own registration check
     * then refuses Y's worktree, exactly as production did, and the capture never happens.
     */
    const pinned = deps(["?? src/w1/feature.ts"], { workspaces: [inRepo("/repo/y")] });
    const withPinnedPort: FinalizeWorkerExecutionDeps = {
      ...pinned.d,
      gitFor: () => ({
        statusPorcelain: async (cwd: string) => {
          throw new Error(`WORKTREE_UNREGISTERED: ${cwd} not in /repo/x/master`);
        },
        headCommit: async () => "commit111",
      }),
    };

    await expect(run(withPinnedPort)).rejects.toThrow(/WORKTREE_UNREGISTERED/);
    expect(pinned.materialize).not.toHaveBeenCalled();
  });
});
