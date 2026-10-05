import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The executable policy is frozen when its module loads, so a deployment authorises the
 * binary BEFORE anything imports it. `vi.hoisted` is the only way to be earlier than the
 * import — which is the property under test, not a workaround for it.
 */
vi.hoisted(() => {
  process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify([process.execPath, "node", "hermes"]);
});

import { runGovernedWorker } from "./activities";

/**
 * WRITE AUTHORITY IS GRANTED BY ICOS, NEVER CLAIMED BY THE WORKER (ADR 0067, amendment A).
 *
 * The activity used to bind the repository read-only and hand the worker a scratch
 * directory, so routing every durable mission task to Temporal did not relocate
 * code-writing work — it removed it. Granting the capability back is only safe if the
 * authority travels one way: ICOS looks up what the task may do from its own durable
 * state and tells the worker, and nothing the worker, the payload or the environment
 * says can widen that.
 *
 * These pin the boundary. Each one asserts what the sandbox is ASKED for, because that
 * request is the whole security decision — what `run-process.ts` then enforces has its
 * own certified proof (`certify:gateway`).
 */
const CALLBACK_SECRET = "a".repeat(48);

let root: string;
let canonical: string;
let sandboxArgs: Parameters<typeof import("@/server/workers/process/run-process").runNonInteractive>[0][];

vi.mock("@/server/workers/process/run-process", () => ({
  runNonInteractive: vi.fn(async (options: never) => {
    sandboxArgs.push(options);
    const signal = (options as { abortSignal?: AbortSignal }).abortSignal;
    /*
     * Models the real runner: a long run that ends when its authority is revoked. A mock
     * that returned at once could never show that revocation stops anything.
     */
    if (signal && !slowRun) {
      return { stdout: "RESULT_SENTINEL", stderr: "", timedOut: false, aborted: false, exitCode: 0 };
    }
    if (signal) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { stdout: "", stderr: "", timedOut: false, aborted: true, exitCode: null };
    }
    return { stdout: "RESULT_SENTINEL", stderr: "", timedOut: false, aborted: false, exitCode: 0 };
  }),
}));

/** Set by the lease-loss tests: makes the mocked run wait for revocation. */
let slowRun = false;

/*
 * Every test starts from the same declaration. The scope test deliberately re-declares
 * the executor, and without this the change leaked into the suites below it — which is
 * the ordinary version of the configuration-widening defect those tests exist to catch.
 */
beforeEach(() => {
  slowRun = false;
  process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
    binary: { command: WORKER_COMMAND, args: ["-e", ""], timeoutMs: 5_000 },
  });
  delete process.env.ICOS_WORKER_AUTHORITY_CHECK_MS;
});
vi.mock("./hermes-run", () => ({
  classifyHermesRun: () => ({ ok: true, result: "done" }),
}));

function grantResponse(grant: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ grant }),
  } as unknown as Response;
}

const WORKER_COMMAND = process.execPath;

/** A worktree the WorkspaceManager would really have created. */
function allocate(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function baseGrant(worktreePath: string | null, writeAllowed: boolean) {
  return {
    taskId: "task-1",
    missionId: "mission-1",
    workflowId: "icos-task-task-1",
    goalId: "goal-1",
    credentialScope: ["node"],
    writeAllowed,
    workspace: worktreePath
      ? {
          worktreePath,
          branch: "icos/w/task-1",
          baseCommit: "abc123",
          fencingToken: 1,
          /* A live lease, well beyond any test's runtime. */
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() as string | null,
        }
      : null,
  };
}

describe("the governed Temporal writer", () => {
  beforeEach(() => {
    slowRun = false;
    sandboxArgs = [];
    root = realpathSync(mkdtempSync(join(tmpdir(), "icos-root-")));
    canonical = realpathSync(mkdtempSync(join(tmpdir(), "icos-canonical-")));
    process.env.ICOS_BASE_URL = "http://127.0.0.1:1";
    process.env.ICOS_EXECUTION_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.ICOS_WORKER_WORKSPACE_ROOT = root;
    process.env.ICOS_WORKSPACE_ROOT = canonical;
    process.env.ICOS_REPO_PATH = canonical;
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: { command: WORKER_COMMAND, args: ["-e", ""], timeoutMs: 5_000 },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ctx = { taskId: "task-1", workflowId: "icos-task-task-1" };
  const run = () => runGovernedWorker(ctx, "do the thing");
  const answerWith = (grant: Record<string, unknown>) =>
    vi.stubGlobal("fetch", vi.fn(async () => grantResponse(grant)));

  it("CAN_WRITE_ALLOCATED_WORKTREE: the granted worktree is writable and is the cwd", async () => {
    const worktree = allocate("task-1");
    answerWith(baseGrant(worktree, true));

    await run();

    const [options] = sandboxArgs;
    expect(options!.cwd).toBe(realpathSync(worktree));
    expect(options!.sandbox?.readWritePaths).toContain(resolve(worktree));
  });

  it("CANNOT_WRITE_CANONICAL_REPO: the checkout is readable and never writable", async () => {
    const worktree = allocate("task-1");
    answerWith(baseGrant(worktree, true));

    await run();

    const [options] = sandboxArgs;
    expect(options!.sandbox?.readOnlyPaths).toContain(canonical);
    expect(options!.sandbox?.readWritePaths).not.toContain(canonical);
  });

  it("CANNOT_WRITE_CANONICAL_REPO: a grant naming the checkout is refused outright", async () => {
    answerWith(baseGrant(canonical, true));

    await expect(run()).rejects.toThrow("WORKER_WORKSPACE_OUTSIDE_ROOT");
    expect(sandboxArgs).toHaveLength(0);
  });

  it("PATH_TRAVERSAL_BLOCKED: `..` out of the root is refused before any process starts", async () => {
    /*
     * A REAL sibling of the root, reached by traversal, so containment — not absence —
     * is what refuses it.
     */
    const sibling = mkdtempSync(join(tmpdir(), "icos-elsewhere-"));
    answerWith(baseGrant(join(root, "..", basename(sibling)), true));

    await expect(run()).rejects.toThrow("WORKER_WORKSPACE_OUTSIDE_ROOT");
    expect(sandboxArgs).toHaveLength(0);
  });

  it("PATH_TRAVERSAL_BLOCKED: a sibling that merely shares the prefix is not inside", async () => {
    /* `${root}-evil` starts with `${root}` as a string and is NOT under it as a path. */
    mkdirSync(`${root}-evil`, { recursive: true });
    answerWith(baseGrant(`${root}-evil`, true));

    await expect(run()).rejects.toThrow("WORKER_WORKSPACE_OUTSIDE_ROOT");
  });

  it("SYMLINK_ESCAPE_BLOCKED: a worktree that is a link to the checkout is refused", async () => {
    /*
     * The lexical check passes here — the link itself lives under the root — so only
     * resolving the real path catches it. Without that, a writer would be handed a path
     * inside its sandbox that lands in the canonical repository.
     */
    const link = join(root, "task-1");
    symlinkSync(canonical, link, "dir");
    answerWith(baseGrant(link, true));

    await expect(run()).rejects.toThrow(/WORKER_WORKSPACE_(IS_CANONICAL|OUTSIDE_ROOT)/);
    expect(sandboxArgs).toHaveLength(0);
  });

  it("SYMLINK_ESCAPE_BLOCKED: a link pointing outside the root is refused", async () => {
    const outside = mkdtempSync(join(tmpdir(), "icos-outside-"));
    const link = join(root, "task-2");
    symlinkSync(outside, link, "dir");
    answerWith(baseGrant(link, true));

    await expect(run()).rejects.toThrow("WORKER_WORKSPACE_OUTSIDE_ROOT");
    expect(sandboxArgs).toHaveLength(0);
  });

  it("CANNOT_WRITE_OTHER_WORKTREE: only the granted worktree is writable", async () => {
    const mine = allocate("task-1");
    answerWith(baseGrant(mine, true));

    await run();

    const writable = sandboxArgs[0]!.sandbox?.readWritePaths ?? [];
    expect(writable).toContain(realpathSync(mine));
    expect(writable).not.toContain(realpathSync(root) + "/task-2");
  });

  it("a reader is granted no write path into the repository at all", async () => {
    answerWith(baseGrant(null, false));

    await run();

    const writable = sandboxArgs[0]!.sandbox?.readWritePaths ?? [];
    expect(writable).not.toContain(canonical);
    expect(sandboxArgs[0]!.cwd).toBe(canonical);
    /* Unchanged from before the writer existed: scratch and HOME only. */
    expect(writable).toHaveLength(2);
  });

  it("refuses a write grant that names no worktree", async () => {
    answerWith(baseGrant(null, true));

    await expect(run()).rejects.toThrow("WORKER_WORKSPACE_MISSING");
    expect(sandboxArgs).toHaveLength(0);
  });

  describe("CALLER_ENV_SPOOF_BLOCKED", () => {
    it("identity comes from the grant, not from the environment", async () => {
      process.env.ICOS_TASK_ID = "spoofed-task";
      process.env.ICOS_WORKFLOW_ID = "spoofed-workflow";
      process.env.ICOS_GOAL_ID = "spoofed-goal";
      answerWith(baseGrant(allocate("task-1"), true));

      await run();

      const env = sandboxArgs[0]!.env ?? {};
      expect(env.ICOS_TASK_ID).toBe("task-1");
      expect(env.ICOS_WORKFLOW_ID).toBe("icos-task-task-1");
      expect(env.ICOS_GOAL_ID).toBe("goal-1");
    });

    it("the worker environment is constructed, never inherited", async () => {
      process.env.AWS_SECRET_ACCESS_KEY = "must-not-travel";
      answerWith(baseGrant(allocate("task-1"), true));

      await run();

      /* HOST_HOME_SECRETS_BLOCKED: an allow-list, so an unrelated secret cannot leak. */
      const env = sandboxArgs[0]!.env ?? {};
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.HOME).not.toBe(process.env.HOME);
      delete process.env.AWS_SECRET_ACCESS_KEY;
    });
  });

  describe("no grant, no run", () => {
    it("a refused grant starts no process", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 403 }) as unknown as Response),
      );

      await expect(run()).rejects.toThrow("WORKER_GRANT_REFUSED");
      expect(sandboxArgs).toHaveLength(0);
    });

    it("a malformed grant starts no process", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response),
      );

      await expect(run()).rejects.toThrow("WORKER_GRANT_MALFORMED");
      expect(sandboxArgs).toHaveLength(0);
    });

    it("an undeclared workspace root refuses rather than guessing one", async () => {
      delete process.env.ICOS_WORKER_WORKSPACE_ROOT;
      answerWith(baseGrant(allocate("task-1"), true));

      await expect(run()).rejects.toThrow("WORKER_WORKSPACE_ROOT_UNDECLARED");
      expect(sandboxArgs).toHaveLength(0);
    });

    it("asks for the grant before provisioning anything", async () => {
      const fetchSpy = vi.fn(async () => grantResponse(baseGrant(allocate("task-1"), true)));
      vi.stubGlobal("fetch", fetchSpy);

      await run();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
      expect(url).toContain("/api/internal/executions/grant");
      /* Identifiers only: nothing in the request can confer authority. */
      expect(JSON.parse(String(init.body))).toEqual({
        taskId: "task-1",
        workflowId: "icos-task-task-1",
      });
    });
  });
});

/**
 * LOSING THE LEASE STOPS THE WRITER, not merely its result.
 *
 * A fencing token proves authority at the instant it is read, and a write runs for
 * minutes afterwards. Until now the only consequence of losing the workspace lease was
 * that the result would be refused later — but refusing a result does not unwrite the
 * files, and the process went on writing into a worktree another owner may hold.
 */
describe("authority is re-checked while the writer runs", () => {
  const ctx = { taskId: "task-1", workflowId: "icos-task-task-1" };

  it("LEASE_LOSS_STOPS_WRITER: a fencing change aborts the run", async () => {
    slowRun = true;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    let token = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const grant = baseGrant(worktree, true);
        /* Somebody else fenced the workspace between two checks. */
        grant.workspace = { ...grant.workspace!, fencingToken: token };
        token = 2;
        return grantResponse(grant);
      }),
    );

    await expect(runGovernedWorker(ctx, "write it")).rejects.toThrow("WORKER_AUTHORITY_LOST");
  });

  it("NO_POST_LEASE_WRITE_ACCEPTED: the result is refused for authority, not classified", async () => {
    slowRun = true;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    let first = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const grant = baseGrant(first ? worktree : null, !first ? false : true);
        first = false;
        return grantResponse(grant);
      }),
    );

    /* FENCED/REVOKED is the reason, so a post-revocation result cannot be read as success. */
    await expect(runGovernedWorker(ctx, "write it")).rejects.toThrow(
      /WORKER_AUTHORITY_LOST: (WRITE_REVOKED|WORKSPACE_RELEASED)/,
    );
  });

  it("an unreachable ICOS does NOT kill live work", async () => {
    /* Absence of evidence is not revocation: a blip must not destroy a running build. */
    slowRun = false;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return grantResponse(baseGrant(worktree, true));
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(runGovernedWorker(ctx, "write it")).resolves.toMatchObject({ result: "done" });
  });

  it("a reader is not watched at all: it holds no worktree to lose", async () => {
    slowRun = false;
    const fetchSpy = vi.fn(async () => grantResponse(baseGrant(null, false)));
    vi.stubGlobal("fetch", fetchSpy);

    await runGovernedWorker(ctx, "just read");
    /* Long enough for several poll intervals, had any been scheduled. */
    await new Promise((resolve) => setTimeout(resolve, 60));

    /* Exactly one call: the initial grant, and no polling after it. */
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("the deployment cannot widen a task's secret scope", () => {
  const ctx = { taskId: "task-1", workflowId: "icos-task-task-1" };

  it("CALLER_SECRET_SCOPE_WIDENING_BLOCKED: an unauthorised executor is refused", async () => {
    /*
     * The declaration names `hermes`, which HAS a credential policy — but ICOS routed
     * this task to something else, so handing over hermes's secrets would be a grant
     * nobody authorised.
     */
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: { command: "hermes", args: [], timeoutMs: 5_000 },
    });
    const grant = baseGrant(allocate("task-1"), true);
    grant.credentialScope = ["codex"];
    vi.stubGlobal("fetch", vi.fn(async () => grantResponse(grant)));

    await expect(runGovernedWorker(ctx, "x")).rejects.toThrow("WORKER_CREDENTIAL_SCOPE_MISMATCH");
  });
});

/**
 * SILENCE IS TOLERATED, BUT NOT FOR EVER.
 *
 * Aborting on the first failed callback would turn a network blip into lost work; never
 * aborting would let a writer keep writing with authority nobody can confirm. The
 * resolution is that silence costs nothing UNTIL the lease the writer was last told it
 * held runs out — the workspace lease already in the registry, not a second clock, so a
 * grace period can never outlast the authority it stands in for.
 */
describe("bounded authority revalidation", () => {
  const ctx = { taskId: "task-1", workflowId: "icos-task-task-1" };

  function grantWithLease(worktreePath: string, msFromNow: number) {
    const grant = baseGrant(worktreePath, true);
    grant.workspace = { ...grant.workspace!, leaseExpiresAt: new Date(Date.now() + msFromNow).toISOString() };
    return grant;
  }

  it("TRANSIENT_CALLBACK_FAILURE_TOLERATED: a blip inside the lease does not stop the writer", async () => {
    slowRun = false;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        /* First call grants; every later one fails, well inside a 10-minute lease. */
        if (calls === 1) return grantResponse(grantWithLease(worktree, 600_000));
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(runGovernedWorker(ctx, "write it")).resolves.toMatchObject({ result: "done" });
  });

  it("CALLBACK_SILENCE_NOT_INDEFINITE: silence past the lease aborts", async () => {
    slowRun = true;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        /* Granted with a lease that expires almost at once, then ICOS goes quiet. */
        if (calls === 1) return grantResponse(grantWithLease(worktree, 25));
        throw new Error("ECONNREFUSED");
      }),
    );

    await expect(runGovernedWorker(ctx, "write it")).rejects.toThrow(
      "WORKER_AUTHORITY_LOST: AUTHORITY_REVALIDATION_TIMEOUT",
    );
  });

  it("LEASE_EXPIRY_WITHOUT_REVALIDATION_ABORTS: an expired lease ends it even when ICOS answers", async () => {
    slowRun = true;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    /* ICOS is perfectly reachable and still reports a lease that has already run out. */
    vi.stubGlobal("fetch", vi.fn(async () => grantResponse(grantWithLease(worktree, -1_000))));

    await expect(runGovernedWorker(ctx, "write it")).rejects.toThrow(
      "WORKER_AUTHORITY_LOST: AUTHORITY_REVALIDATION_TIMEOUT",
    );
  });

  it("a workspace holding no lease at all can coast nowhere", async () => {
    slowRun = true;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    const grant = baseGrant(worktree, true);
    grant.workspace = { ...grant.workspace!, leaseExpiresAt: null };
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 1) return grantResponse(grant);
        throw new Error("ECONNREFUSED");
      }),
    );

    /* Authority that was never verifiable is not authority. */
    await expect(runGovernedWorker(ctx, "write it")).rejects.toThrow(
      "AUTHORITY_REVALIDATION_TIMEOUT",
    );
  });

  it("POSITIVE_REVOKE_ABORTS_IMMEDIATELY: revocation does not wait for the lease", async () => {
    slowRun = true;
    process.env.ICOS_WORKER_AUTHORITY_CHECK_MS = "10";
    const worktree = allocate("task-1");
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        /* A ten-minute lease, revoked on the second answer. */
        if (calls === 1) return grantResponse(grantWithLease(worktree, 600_000));
        const revoked = grantWithLease(worktree, 600_000);
        revoked.workspace = { ...revoked.workspace!, fencingToken: 99 };
        return grantResponse(revoked);
      }),
    );

    const started = Date.now();
    await expect(runGovernedWorker(ctx, "write it")).rejects.toThrow(
      "WORKER_AUTHORITY_LOST: FENCED_OUT",
    );
    /* Immediately: nowhere near the lease it still nominally held. */
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
