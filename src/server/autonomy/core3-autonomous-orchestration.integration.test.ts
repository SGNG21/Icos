import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import {
  composeAutonomyRuntime,
  startProductionServices,
  type ProductionServices,
} from "@/server/system/production-services";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { missionTasks, missions, tasks } from "@/server/database/schema";
import { RuntimeDispatchRouter } from "@/server/execution/runtime-dispatch-router";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";

/*
 * CORE3 AUTONOMOUS ORCHESTRATION — the DEFAULT path, from the REAL container.
 *
 * Defects 22 and 23 were both the same shape: a capability that every test composed by hand
 * and the container never built. So this proof composes NOTHING by hand. It calls
 * `buildPostgresContainer` — the factory production calls — and `composeAutonomyRuntime`,
 * the exact function `createRecoveryScheduler` uses to build the supervisor. If the
 * container stops wiring the coordinator, or the supervisor stops allocating, this fails.
 *
 * REAL: PostgreSQL, a real git repository and worktrees, a real OS process doing the work,
 * the real router/gate/applier/manager/supervisor, restarts as new containers.
 *
 * SUBSTITUTED, and why: the gate's shell commands (install/typecheck/lint/test/build) are
 * replaced with trivial passing ones via ICOS_GATE_COMMANDS — running four full pnpm suites
 * inside a throwaway fixture would take many minutes and prove pnpm works, not that ICOS
 * orchestrates correctly. Every gate RULE (scope, secrets, migrations, diff, conflict,
 * review) is the real one.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "core3-mission";
const MISSION_TASK_ID = "core3-mt-1";
const TASK_ID = "core3task1";
const WORKER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CAPABILITY = "code-generation";
const WORKFLOW_ID = workflowIdForAttempt(TASK_ID, 1);

/* A REAL worker: writes inside its declared scope and commits. */
const WORKER_SCRIPT = `
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  fs.mkdirSync('src/core3', { recursive: true });
  fs.writeFileSync('src/core3/feature.txt', 'built by ' + process.env.ICOS_TASK_ID + '\\n');
  execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-c','user.email=w@w','-c','user.name=w','commit','-q','-m','core3 feature'], { stdio: 'ignore' });
  process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
    status: 'succeeded', summary: 'wrote src/core3/feature.txt', testsRun: ['unit'],
  }) + process.env.ICOS_RESULT_SENTINEL_END);
`;

let tmp: string | undefined;
let repo: string;
let worktreeRoot: string;
const containers: Container[] = [];
const started: ProductionServices[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

function makeRepo() {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "core3-cert-")));
  repo = path.join(tmp, "master");
  worktreeRoot = path.join(tmp, "trees");
  mkdirSync(repo);
  mkdirSync(worktreeRoot);
  git(repo, "init", "-q", "--initial-branch=main", ".");
  writeFileSync(path.join(repo, "README.md"), "canonical\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  /* The integration target the workspace manager defaults to. */
  git(repo, "branch", "integration/phase-7");
}

function envOverrides() {
  return {
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: "http://127.0.0.1:65535",
    OMNIROUTE_API_KEY: "core3-cert-key",
    ICOS_REVIEWER_MODEL: "core3-cert-model",
    /* Opt in to external execution, by RUNTIME, exactly as a deployment would. */
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: { command: process.execPath, args: ["-e", WORKER_SCRIPT], timeoutMs: 30_000 },
    }),
    ICOS_REPO_PATH: repo,
    ICOS_WORKER_WORKSPACE_ROOT: worktreeRoot,
    /*
     * The gate's verification commands, replaced by trivial passing ones. Running four
     * full pnpm suites inside a throwaway fixture would take many minutes and prove pnpm
     * works, not that ICOS orchestrates correctly. Every gate RULE — scope, secrets,
     * migrations, diff, conflict, review — is the real one and is exercised below.
     */
    ICOS_GATE_COMMANDS: JSON.stringify({
      install: [process.execPath, "-e", ""],
      typecheck: [process.execPath, "-e", ""],
      lint: [process.execPath, "-e", ""],
      unit: [process.execPath, "-e", ""],
      build: [process.execPath, "-e", ""],
      postgres: [[process.execPath, "-e", ""]],
    }),
  };
}

const env = () => loadEnv(envOverrides());

async function container(): Promise<Container> {
  const built = await buildPostgresContainer(DATABASE_URL, undefined, env());
  containers.push(built);
  return built;
}

async function seed(c: Container) {
  const now = new Date();
  await c.db!.execute(
    sql.raw(
      /* The workspace registry is durable and shared: a leftover lease blocks the next run. */
      "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry RESTART IDENTITY CASCADE",
    ),
  );
  await c.db!.insert(missions).values({
    id: MISSION_ID,
    title: "CORE3",
    objective: "Prove the default governed path",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await c.db!.insert(tasks).values({
    id: TASK_ID,
    title: "Add core3 feature",
    description: "Write src/core3/feature.txt and commit it",
    status: "draft",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    /* CANONICAL METADATA — the only thing allocation is allowed to read. */
    riskClass: "reversible",
    allowedFileScope: ["src/core3/**"],
    createdAt: now,
    updatedAt: now,
  });
  await c.db!.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "Add core3 feature",
    description: "Write src/core3/feature.txt and commit it",
    dependsOn: [],
    status: "draft",
    workerKind: null,
    capability: CAPABILITY,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });

  await c.workerRegistration.register({
    id: WORKER_ID,
    workerKind: "agent",
    displayName: "external-writer",
    capabilities: [CAPABILITY],
    /* The runtime the deployment configured an executor for. */
    runtime: "binary",
    runtimeSupport: "SUPPORTED_RUNTIME",
    maxConcurrency: 1,
    metadata: { model: "m", provider: "p", account: "a" },
  });
  await c.workerRegistration.probe(WORKER_ID, { health: "healthy", availability: "available" });
}

/** The canonical review, as QC persists it. Reviewed independently of the worker. */
async function approve(c: Container) {
  await c.reviewDecisions.save({
    id: `review-${TASK_ID}`,
    taskId: TASK_ID,
    workflowId: WORKFLOW_ID,
    missionId: MISSION_ID,
    decision: "APPROVE",
    reviewerKind: "deterministic",
    severity: "info",
    reasons: ["evidence verified"],
    humanOverridden: false,
    createdAt: new Date().toISOString(),
  });
}

afterEach(async () => {
  /* Stop the real scheduler first: it owns the container it was started with. */
  await Promise.all(started.splice(0).map((s) => s.stop()));
  await Promise.all(containers.splice(0).map((c) => c.close()));
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("CORE3_AUTONOMOUS_ORCHESTRATION — default path from the real container", () => {
  it("THE CONTAINER ITSELF wires the governed path: router, coordinator, applier", async () => {
    makeRepo();
    const c = await container();

    /* Defect 22: dispatch is chosen by runtime, by the container. */
    expect(c.taskExecution).toBeInstanceOf(RuntimeDispatchRouter);
    expect((c.taskExecution as RuntimeDispatchRouter).external()).toEqual(["binary"]);
    /* Defect 23: the coordinator and applier exist to be reached. */
    expect(c.workspaceExecutionCoordinator).toBeDefined();
    expect(c.integrationApplier).toBeDefined();
  }, 120_000);

  it("startProductionServices BOOTS the governed path and drives the mission", async () => {
    makeRepo();
    /*
     * The real process entry point, not just the container factory. It builds the container,
     * composes the autonomy runtime and starts the recovery scheduler — so this asserts the
     * path production actually takes on boot, which is the exact thing defects 22 and 23
     * were: capabilities every test composed and the running process did not.
     */
    const seeded = await container();
    await seed(seeded);
    await approve(seeded);
    const before = git(repo, "rev-parse", "integration/phase-7");

    const services = await startProductionServices({
      env: loadEnv({ ...envOverrides(), NODE_ENV: "production" }),
      registerSignals: false,
      signals: { onSignal: () => {}, removeSignal: () => {}, exit: () => {} },
    });
    started.push(services);

    /* The booted container wires external execution and governed workspaces. */
    expect(services.container.taskExecution).toBeInstanceOf(RuntimeDispatchRouter);
    expect(services.container.workspaceExecutionCoordinator).toBeDefined();

    /* Drive the mission through the SAME composition the scheduler uses. */
    await composeAutonomyRuntime(services.container).supervisor.run(MISSION_ID);

    const ws = (await services.container.workspaceManager!.list()).find(
      (w) => w.workflowId === WORKFLOW_ID,
    );
    expect(ws, "startProductionServices did not reach governed allocation").toBeDefined();
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(ws!.sourceCommit);
    expect(git(repo, "rev-parse", "integration/phase-7")).not.toBe(before);
  }, 180_000);

  it("AN ORDINARY AUTONOMOUS MISSION reaches the governed path BY DEFAULT", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    await approve(c);
    const before = git(repo, "rev-parse", "integration/phase-7");

    /*
     * The REAL production composition — the same function `createRecoveryScheduler` calls.
     * Nothing about the workspace is passed here: if the supervisor does not allocate one
     * itself, the writer runs ad-hoc and this proof fails.
     */
    const { supervisor } = composeAutonomyRuntime(c);
    await supervisor.run(MISSION_ID);

    /* A GOVERNED workspace was allocated automatically, keyed by the canonical workflow. */
    const workspaces = await c.workspaceManager!.list();
    const ws = workspaces.find((w) => w.workflowId === WORKFLOW_ID);
    expect(ws, "no governed workspace was allocated for the writer task").toBeDefined();
    /* Its scope is the TASK's declared scope, not a generic default. */
    expect(ws!.fileScope.owns).toEqual(["src/core3/**"]);
    /* And it lives under the configured root, never in the canonical repository. */
    expect(ws!.worktreePath.startsWith(worktreeRoot)).toBe(true);

    /*
     * The REAL external worker ran and committed. Read through `sourceCommit` — the commit
     * the gate recorded — because the BRANCH is already gone: reaping deleted it once its
     * commits were contained in the target, which is the behaviour asserted below.
     */
    const workerCommit = ws!.sourceCommit;
    expect(workerCommit, "the gate recorded no source commit").toBeTruthy();
    expect(workerCommit).not.toBe(ws!.baseCommit);
    expect(git(repo, "show", "--name-only", "--format=", workerCommit!).trim()).toBe(
      "src/core3/feature.txt",
    );

    /* INTEGRATED exactly once: the canonical branch advanced to that commit. */
    const after = git(repo, "rev-parse", "integration/phase-7");
    expect(after).toBe(workerCommit);
    expect(after).not.toBe(before);

    /* NO ORPHAN BRANCH: the worker branch was reaped once its commits were contained. */
    const workerBranches = git(repo, "branch", "--list", "ws/*")
      .split("\n")
      .map((b) => b.replace("*", "").trim())
      .filter(Boolean);
    expect(workerBranches).toEqual([]);
    expect(existsSync(ws!.worktreePath)).toBe(false);
  }, 180_000);

  it("RESTART: a new container re-running the mission integrates nothing twice", async () => {
    makeRepo();
    const first = await container();
    await seed(first);
    await approve(first);
    await composeAutonomyRuntime(first).supervisor.run(MISSION_ID);
    const afterFirst = git(repo, "rev-parse", "integration/phase-7");

    /* A completely new container and supervisor, as a restarted process would build. */
    const second = await container();
    await composeAutonomyRuntime(second).supervisor.run(MISSION_ID);

    /* Exactly-once dispatch AND exactly-once integration both hold across the restart. */
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(afterFirst);
    const attempts = (await second.db!.execute(
      sql.raw(
        `select count(*)::int as n from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}'`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(attempts[0]!.n).toBe(1);
  }, 180_000);

  it("A WRITER WITH NO DECLARED SCOPE IS BLOCKED, never run ungoverned", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    /* Planning forgot the scope: the task cannot be governed, so it must not run. */
    await c.db!.execute(sql.raw(`UPDATE tasks SET allowed_file_scope = '[]'::jsonb WHERE id = '${TASK_ID}'`));
    const before = git(repo, "rev-parse", "integration/phase-7");

    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    const [mt] = (await c.db!.execute(
      sql.raw(`select status from mission_tasks where id = '${MISSION_TASK_ID}'`),
    )) as unknown as Array<{ status: string }>;
    expect(mt!.status).toBe("blocked");
    /* Nothing ran, nothing was branched, nothing was integrated. */
    expect(await c.workspaceManager!.list()).toEqual([]);
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(before);
  }, 120_000);

  it("RETRY SEMANTICS: the same attempt REUSES its workspace, a new attempt gets its own", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    const coordinator = c.workspaceExecutionCoordinator!;

    /*
     * Idempotent on the canonical workflow id. A retry of the SAME logical attempt — a
     * recovery replay, a second supervisor tick — must continue in the workspace that
     * already holds its worktree and branch, never fork a second one.
     */
    const first = await coordinator.allocateWorkspace(
      MISSION_ID, TASK_ID, WORKER_ID, "retry_a", WORKFLOW_ID,
      { owns: ["src/core3/**"], shared: [], forbidden: [] },
    );
    const again = await coordinator.allocateWorkspace(
      MISSION_ID, TASK_ID, WORKER_ID, "retry_a", WORKFLOW_ID,
      { owns: ["src/core3/**"], shared: [], forbidden: [] },
    );
    expect(again.workspaceId).toBe(first.workspaceId);
    expect((await c.workspaceManager!.list()).filter((w) => w.releasedAt === null)).toHaveLength(1);

    /*
     * A DIFFERENT workflow id is a different logical attempt (M7.1 retries create attempt
     * N+1 with a new workflow id), and binding it to the same task must be REFUSED rather
     * than silently reusing the predecessor's worktree — the two attempts' work would
     * otherwise land on one branch.
     */
    await expect(
      coordinator.allocateWorkspace(
        MISSION_ID, TASK_ID, WORKER_ID, "retry_b", workflowIdForAttempt(TASK_ID, 2),
        { owns: ["src/core3/**"], shared: [], forbidden: [] },
      ),
    ).rejects.toThrow(/WORKFLOW_COLLISION/);
  }, 120_000);

  it("A READ-ONLY TASK needs no workspace and creates no branch", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    await c.db!.execute(sql.raw(`UPDATE tasks SET risk_class = 'read_only' WHERE id = '${TASK_ID}'`));

    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    /* A reader mutates nothing; provisioning a worktree would cost a checkout for nothing. */
    expect(await c.workspaceManager!.list()).toEqual([]);
    expect(git(repo, "branch", "--list", "ws/*").trim()).toBe("");
  }, 120_000);
});
