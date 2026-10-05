import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    return { stdout: "RESULT_SENTINEL", stderr: "", timedOut: false, exitCode: 0 };
  }),
}));
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
    writeAllowed,
    workspace: worktreePath
      ? { worktreePath, branch: "icos/w/task-1", baseCommit: "abc123", fencingToken: 1 }
      : null,
  };
}

describe("the governed Temporal writer", () => {
  beforeEach(() => {
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
