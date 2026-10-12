import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify([process.execPath, "node"]);
});

import { allowBashPatterns, runGovernedWorker, withExecutionEnvironment } from "./activities";

/**
 * W10 / W7 — THE WRITER CAN VERIFY ITS OWN WORK, AND IS TOLD HOW (N1 lab, 2026-10-12).
 *
 * Runs 8–9 ended at the token cap for one reason: the allocated worktree had no
 * `node_modules`, so the writer could not run eslint/vitest, guessed `npx eslint` (refused:
 * not in the allowlist, no prompt surface), and the independent reviewer kept requesting the
 * verification it could not produce. Two properties are pinned here:
 *
 *  - W10: when the worktree is a pnpm package without `node_modules`, the dependencies are
 *    installed BEFORE the writer launches, through the gate's sandboxed runner — offline, no
 *    network, ephemeral HOME, confinement required — and a failed install refuses the run.
 *  - W7: the prompt the writer receives states the exact `--allow-bash` forms the executor
 *    enforces and the dependency status, from the same declaration — one source.
 */
type RunOptions = Parameters<
  typeof import("@/server/workers/process/run-process").runNonInteractive
>[0];

let calls: RunOptions[] = [];
let installExit = 0;

vi.mock("@/server/workers/process/run-process", () => ({
  runNonInteractive: vi.fn(async (options: RunOptions) => {
    calls.push(options);
    const isInstall = options.command === "pnpm";
    return {
      stdout: isInstall ? "" : "RESULT_SENTINEL",
      stderr: isInstall && installExit !== 0 ? "ERR_PNPM_NO_OFFLINE_META" : "",
      timedOut: false,
      aborted: false,
      exitCode: isInstall ? installExit : 0,
      confinement: "bubblewrap",
    };
  }),
}));
vi.mock("./worker-run", () => ({
  classifyWorkerRun: () => ({ ok: true, result: "done" }),
}));

const CALLBACK_SECRET = "a".repeat(48);
const WORKER_COMMAND = process.execPath;
const ALLOW = ["pnpm vitest run src/core/autonomy/*", "pnpm exec eslint src/core/autonomy/*"];

let root: string;
let canonical: string;

function allocate(name: string, opts: { pkg?: boolean; modules?: boolean } = {}): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".git"), `gitdir: ${join(canonical, ".git", "worktrees", name)}\n`);
  if (opts.pkg) {
    writeFileSync(join(path, "package.json"), '{"name":"fixture","private":true}\n');
    writeFileSync(join(path, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  }
  if (opts.modules) mkdirSync(join(path, "node_modules"), { recursive: true });
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
          fileScope: ["src/core/autonomy/*"],
        },
      },
    }),
  } as unknown as Response;
}

describe("W10 — the writer's worktree has its dependencies before it runs", () => {
  beforeEach(() => {
    calls = [];
    installExit = 0;
    root = realpathSync(mkdtempSync(join(tmpdir(), "icos-root-")));
    canonical = realpathSync(mkdtempSync(join(tmpdir(), "icos-canonical-")));
    process.env.ICOS_BASE_URL = "http://127.0.0.1:1";
    process.env.ICOS_EXECUTION_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.ICOS_WORKER_WORKSPACE_ROOT = root;
    process.env.ICOS_WORKSPACE_ROOT = canonical;
    process.env.ICOS_REPO_PATH = canonical;
    delete process.env.ICOS_GATE_COMMANDS;
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: {
        command: WORKER_COMMAND,
        args: ["-e", "", "--allow-bash", ALLOW[0], "--allow-bash", ALLOW[1], "-p", "{{prompt}}"],
        timeoutMs: 5_000,
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const ctx = { taskId: "task-1", workflowId: "icos-task-task-1" };
  const launch = () => calls.find((c) => c.command === WORKER_COMMAND) as RunOptions;
  const install = () => calls.find((c) => c.command === "pnpm");

  it("DEPS_INSTALLED_OFFLINE_IN_SANDBOX: a package without node_modules is installed first, frozen, offline, no network", async () => {
    const worktree = allocate("task-1", { pkg: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(worktree)),
    );

    await runGovernedWorker(ctx, "fix the lint");

    const i = install();
    expect(i).toBeDefined();
    expect(i!.args).toEqual(["install", "--frozen-lockfile", "--offline"]);
    expect(i!.cwd).toBe(worktree);
    expect(i!.sandbox?.allowNetwork).toBe(false);
    expect(i!.confinement).toBe("required");
    expect(i!.envPassthrough).toEqual([]);
    /* No secret of the deployment leaks into the install: only the gate's named variables. */
    expect(Object.keys(i!.env ?? {}).sort()).toEqual(
      [
        "CI",
        "HOME",
        "TMPDIR",
        "npm_config_verify_deps_before_run",
        "pnpm_config_verify_deps_before_run",
      ].sort(),
    );
    /* Ordered: the install completes before the writer is launched. */
    expect(calls.indexOf(i!)).toBeLessThan(calls.indexOf(launch()));
    /* The pnpm store the links resolve into is readable by the writer, read-only. */
    expect(launch().sandbox?.readOnlyPaths?.some((p) => p.includes("pnpm"))).toBe(true);
    expect(launch().sandbox?.readWritePaths?.some((p) => p.includes("pnpm/store"))).toBe(false);
  });

  it("DEPS_PRESENT_NOT_REINSTALLED: an existing node_modules is left alone", async () => {
    const worktree = allocate("task-1", { pkg: true, modules: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(worktree)),
    );

    await runGovernedWorker(ctx, "fix the lint");

    expect(install()).toBeUndefined();
    expect((launch().args ?? []).join("\n")).toContain(
      "Dependencies are installed in this worktree",
    );
  });

  it("NOT_A_PACKAGE_NEEDS_NOTHING: a worktree without package.json + lockfile is launched as before", async () => {
    const worktree = allocate("task-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(worktree)),
    );

    await runGovernedWorker(ctx, "fix the lint");

    expect(install()).toBeUndefined();
    expect((launch().args ?? []).join("\n")).toContain("not a package");
  });

  it("DEPS_UNAVAILABLE_FAILS_CLOSED: a failed install refuses the run; the writer never launches", async () => {
    installExit = 1;
    const worktree = allocate("task-1", { pkg: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(worktree)),
    );

    await expect(runGovernedWorker(ctx, "fix the lint")).rejects.toThrow(
      /WORKER_DEPENDENCIES_UNAVAILABLE.*ERR_PNPM_NO_OFFLINE_META/,
    );
    expect(calls.find((c) => c.command === WORKER_COMMAND)).toBeUndefined();
  });

  it("GATE_INSTALL_COMMAND_REUSED: the deployment's gate install step is the one used", async () => {
    process.env.ICOS_GATE_COMMANDS = JSON.stringify({
      install: ["pnpm", "install", "--frozen-lockfile", "--offline", "--ignore-scripts"],
      lint: ["pnpm", "exec", "eslint", "."],
    });
    const worktree = allocate("task-1", { pkg: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(worktree)),
    );

    await runGovernedWorker(ctx, "fix the lint");

    expect(install()!.args).toEqual([
      "install",
      "--frozen-lockfile",
      "--offline",
      "--ignore-scripts",
    ]);
  });
});

describe("W7 — the writer is told exactly what the executor will allow", () => {
  beforeEach(() => {
    calls = [];
    installExit = 0;
    root = realpathSync(mkdtempSync(join(tmpdir(), "icos-root-")));
    canonical = realpathSync(mkdtempSync(join(tmpdir(), "icos-canonical-")));
    process.env.ICOS_BASE_URL = "http://127.0.0.1:1";
    process.env.ICOS_EXECUTION_CALLBACK_SECRET = CALLBACK_SECRET;
    process.env.ICOS_WORKER_WORKSPACE_ROOT = root;
    process.env.ICOS_WORKSPACE_ROOT = canonical;
    process.env.ICOS_REPO_PATH = canonical;
    delete process.env.ICOS_GATE_COMMANDS;
    process.env.ICOS_WORKER_EXEC_COMMANDS = JSON.stringify({
      binary: {
        command: WORKER_COMMAND,
        args: ["-e", "", "--allow-bash", ALLOW[0], "--allow-bash", ALLOW[1], "-p", "{{prompt}}"],
        timeoutMs: 5_000,
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("ALLOWLIST_STATED_FROM_DECLARATION: the permitted forms in the prompt are the declared --allow-bash values", async () => {
    const worktree = allocate("task-1", { pkg: true, modules: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => grant(worktree)),
    );

    await runGovernedWorker({ taskId: "task-1", workflowId: "icos-task-task-1" }, "fix the lint");

    const prompt = (calls.find((c) => c.command === WORKER_COMMAND) as RunOptions).args.at(
      -1,
    ) as string;
    expect(prompt.startsWith("fix the lint")).toBe(true);
    for (const pattern of ALLOW) expect(prompt).toContain(`\`${pattern}\``);
    expect(prompt).toContain("refused without a prompt");
    expect(prompt).not.toContain("npx");
  });

  it("allowBashPatterns reads only --allow-bash values, in order", () => {
    expect(
      allowBashPatterns(["-p", "x", "--allow-bash", "a *", "--allow-bash", "b", "--allow-bash"]),
    ).toEqual(["a *", "b"]);
    expect(allowBashPatterns(["-p", "x"])).toEqual([]);
  });

  it("NO_SHELL_MEANS_EDIT_ONLY: without --allow-bash the writer is told no command is permitted", () => {
    const text = withExecutionEnvironment("objective", {
      shellPatterns: [],
      dependencies: "present",
    });
    expect(text).toContain("No shell command is permitted");
    expect(text).toContain("Do not install anything");
  });
});
