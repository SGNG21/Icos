import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationFailure } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify([process.execPath, "node"]);
});

/*
 * THE TEMPORAL ACTIVITY CONTEXT, controlled: attempt number and heartbeat sink. The real
 * `Context.current()` throws outside a worker; here it answers what the test decides.
 */
const temporal = vi.hoisted(() => ({
  attempt: 1,
  heartbeats: [] as unknown[],
  inWorker: true,
}));
vi.mock("@temporalio/activity", () => ({
  Context: {
    current: () => {
      if (!temporal.inWorker) throw new Error("not in activity context");
      return {
        info: { attempt: temporal.attempt },
        heartbeat: (details: unknown) => temporal.heartbeats.push(details),
      };
    },
  },
}));

import { GOVERNED_RUN_FAILURE, resetWorktreeForRetry, runGovernedWorker } from "./activities";

/**
 * AUTOMATIC RECOVERY OF A DEAD WORKER (W6, after N1 run 10). Run 10 needed a manual `kill -9`
 * and a manual Temporal reset to re-run an attempt whose worker had died: the activity had no
 * heartbeat, so the server waited 16 minutes, and nothing restored the worktree. These pin
 * the three properties that make the second try automatic and safe:
 *
 *  - the activity HEARTBEATS while the executor runs (the server sees death in seconds);
 *  - the run's own failures are NON-RETRYABLE `GovernedRunFailure` (only transport timeouts
 *    may trigger the single retry — never work ICOS saw fail);
 *  - a retry (attempt ≥ 2) starts from the attempt's base: a dead try's half-written edits
 *    are discarded, the installed dependencies are kept.
 */
type RunOptions = Parameters<
  typeof import("@/server/workers/process/run-process").runNonInteractive
>[0];
let calls: RunOptions[] = [];
let runFails = false;

vi.mock("@/server/workers/process/run-process", () => ({
  runNonInteractive: vi.fn(async (options: RunOptions) => {
    calls.push(options);
    if (runFails) throw new Error("SANDBOX_LAUNCH_FAILED: injected");
    return {
      stdout: "RESULT_SENTINEL",
      stderr: "",
      timedOut: false,
      aborted: false,
      exitCode: 0,
      confinement: "bubblewrap",
    };
  }),
}));
vi.mock("./worker-run", () => ({
  classifyWorkerRun: () => ({ ok: true, result: "done" }),
}));

const CALLBACK_SECRET = "a".repeat(48);
let root: string;
let canonical: string;

function allocate(name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${join(canonical, ".git", "worktrees", name)}\n`);
  return path;
}

function grant(worktreePath: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      grant: {
        taskId: "task-1",
        missionId: "mission-1",
        workflowId: "icos-task-task-1",
        goalId: "goal-1",
        credentialScope: ["node"],
        writeAllowed: true,
        model: "cc/claude-sonnet-5",
        provider: "omniroute",
        workspace: {
          worktreePath,
          branch: "icos/task-1",
          baseCommit: "0".repeat(40),
          fencingToken: 1,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          fileScope: ["src/*"],
        },
      },
    }),
  } as unknown as Response;
}

const ctx = { taskId: "task-1", workflowId: "icos-task-task-1" };

describe("automatic recovery of a dead worker", () => {
  beforeEach(() => {
    calls = [];
    runFails = false;
    temporal.attempt = 1;
    temporal.heartbeats = [];
    temporal.inWorker = true;
    root = realpathSync(mkdtempSync(join(tmpdir(), "icos-root-")));
    canonical = realpathSync(mkdtempSync(join(tmpdir(), "icos-canonical-")));
    process.env.ICOS_BASE_URL = "http://127.0.0.1:1";
    process.env.ICOS_EXECUTION_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.ICOS_WORKER_WORKSPACE_ROOT = root;
    process.env.ICOS_WORKSPACE_ROOT = canonical;
    process.env.ICOS_REPO_PATH = canonical;
    process.env.ICOS_WORKER_HEARTBEAT_MS = "5";
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: { command: process.execPath, args: ["-e", "", "-p", "{{prompt}}"], timeoutMs: 5_000 },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("HEARTBEAT_WHILE_RUNNING: the activity heartbeats as soon as the executor is launched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(allocate("task-1"))),
    );

    await runGovernedWorker(ctx, "do it");

    expect(temporal.heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(temporal.heartbeats[0]).toMatchObject({ taskId: "task-1" });
  });

  it("RUN_FAILURE_IS_FINAL: a failed run is a non-retryable GovernedRunFailure, message intact", async () => {
    runFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(allocate("task-1"))),
    );

    const error = await runGovernedWorker(ctx, "do it").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    const failure = error as ApplicationFailure;
    expect(failure.type).toBe(GOVERNED_RUN_FAILURE);
    expect(failure.nonRetryable).toBe(true);
    expect(failure.message).toContain("SANDBOX_LAUNCH_FAILED: injected");
  });

  it("OUTSIDE_A_WORKER_NOTHING_CHANGES: no activity context means attempt 1, no heartbeat, same run", async () => {
    temporal.inWorker = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(allocate("task-1"))),
    );

    await runGovernedWorker(ctx, "do it");

    expect(temporal.heartbeats).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("RETRY_STARTS_FROM_BASE: attempt 2 discards a dead try's edits and keeps node_modules", async () => {
    /* A real git worktree: the reset is a real `git checkout` + `git clean`. */
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "icos-repo-")));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "base\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    const wt = join(root, "task-1");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt]);
    writeFileSync(join(wt, "a.ts"), "half-written by a dead try\n");
    writeFileSync(join(wt, "scratch.txt"), "untracked leftover\n");
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(wt, "node_modules", ".bin", "eslint"), "#!/bin/sh\n");

    temporal.attempt = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(wt)),
    );
    await runGovernedWorker(ctx, "do it");

    expect(execFileSync("cat", [join(wt, "a.ts")]).toString()).toBe("base\n");
    expect(existsSync(join(wt, "scratch.txt"))).toBe(false);
    expect(existsSync(join(wt, "node_modules", ".bin", "eslint"))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("FIRST_TRY_NEVER_RESETS: attempt 1 leaves the worktree exactly as allocated", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "icos-repo-")));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "base\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    const wt = join(root, "task-1");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", wt]);
    writeFileSync(join(wt, "pre-existing.txt"), "allocated like this\n");

    temporal.attempt = 1;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(wt)),
    );
    await runGovernedWorker(ctx, "do it");

    expect(existsSync(join(wt, "pre-existing.txt"))).toBe(true);
  });

  it("resetWorktreeForRetry is a plain checkout + clean that spares node_modules", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "icos-repo-")));
    execFileSync("git", ["-C", repo, "init", "-q"]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "a.ts"), "base\n");
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
    writeFileSync(join(repo, "a.ts"), "dirty\n");
    writeFileSync(join(repo, "junk"), "x");
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "keep"), "x");

    await resetWorktreeForRetry(repo);

    expect(execFileSync("cat", [join(repo, "a.ts")]).toString()).toBe("base\n");
    expect(existsSync(join(repo, "junk"))).toBe(false);
    expect(existsSync(join(repo, "node_modules", "keep"))).toBe(true);
  });
});
