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

/**
 * The canonical review, as QC persists it — written AFTER execution, never before (M13).
 *
 * It used to be pre-seeded before `supervisor.run`, which was a certification artifact hiding
 * defect 28: the gate ran immediately after execution and consulted a review QC had not yet
 * written, so the only way past it was to write one in advance. The gate now waits for a
 * review, and this runs where QC actually would.
 */
async function qcReviews(c: Container) {
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

    /*
     * Drive the mission through the SAME composition the scheduler uses. The first pass
     * executes and leaves the work AWAITING REVIEW; QC then reviews; the later governed pass
     * gates and integrates. Nothing is pre-seeded and no stage is advanced by hand.
     */
    const bootRuntime = composeAutonomyRuntime(services.container);
    await bootRuntime.supervisor.run(MISSION_ID);
    await qcReviews(services.container);
    await services.container.workspaceExecutionCoordinator!.gatePendingReview();

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
    const before = git(repo, "rev-parse", "integration/phase-7");

    /*
     * The REAL production composition — the same function `createRecoveryScheduler` calls.
     * Nothing about the workspace is passed here: if the supervisor does not allocate one
     * itself, the writer runs ad-hoc and this proof fails.
     */
    const { supervisor } = composeAutonomyRuntime(c);
    await supervisor.run(MISSION_ID);

    /*
     * NATURAL ORDER (M13, defect 28). Execution finished with NO review, so nothing was
     * gated and nothing integrated — the canonical branch has not moved yet. QC reviews
     * independently, and only then does the governed pass gate and integrate.
     */
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(before);
    await qcReviews(c);
    await c.workspaceExecutionCoordinator!.gatePendingReview();

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
    await composeAutonomyRuntime(first).supervisor.run(MISSION_ID);
    await qcReviews(first);
    await first.workspaceExecutionCoordinator!.gatePendingReview();
    const afterFirst = git(repo, "rev-parse", "integration/phase-7");

    /* A completely new container and supervisor, as a restarted process would build. */
    const second = await container();
    await composeAutonomyRuntime(second).supervisor.run(MISSION_ID);
    await second.workspaceExecutionCoordinator!.gatePendingReview();

    /* Exactly-once dispatch AND exactly-once integration both hold across the restart. */
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(afterFirst);
    const attempts = (await second.db!.execute(
      sql.raw(
        `select count(*)::int as n from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}'`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(attempts[0]!.n).toBe(1);
  }, 180_000);

  it("DEFECT 28 — NATURAL ORDER: no review means no integration, and no premature escalation", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    const before = git(repo, "rev-parse", "integration/phase-7");

    /* ---- Execution completes, with NO review anywhere. ---- */
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    const ws = (await c.workspaceManager!.list()).find((w) => w.workflowId === WORKFLOW_ID);
    expect(ws, "no governed workspace was allocated").toBeDefined();

    /*
     * The work is DURABLE and WAITING: worktree intact, commits held, workspace parked where
     * a later pass can gate it. Nothing integrated, and the task was NOT failed — "nobody has
     * looked at it" must stay distinguishable from "it was judged bad".
     */
    expect(ws!.status).toBe("ready_for_integration");
    expect(existsSync(ws!.worktreePath)).toBe(true);
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(before);

    const [mt] = (await c.db!.execute(
      sql.raw(`select status from mission_tasks where id = '${MISSION_TASK_ID}'`),
    )) as unknown as Array<{ status: string }>;
    expect(mt!.status).not.toBe("failed");

    /* A governed pass while STILL unreviewed changes nothing: silence is never consent. */
    expect(await c.workspaceExecutionCoordinator!.gatePendingReview()).toEqual([]);
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(before);

    /* ---- QC reviews independently, and only now may the gate run. ---- */
    await qcReviews(c);
    const gated = await c.workspaceExecutionCoordinator!.gatePendingReview();

    expect(gated).toHaveLength(1);
    expect(gated[0]!.decision).toBe("ACCEPT");
    expect(gated[0]!.integration?.status).toBe("INTEGRATED");

    /* Re-read: `sourceCommit` is recorded BY the gate, so the pre-gate snapshot has none. */
    const gatedWs = (await c.workspaceManager!.list()).find((w) => w.workflowId === WORKFLOW_ID);
    const after = git(repo, "rev-parse", "integration/phase-7");
    expect(after).toBe(gatedWs!.sourceCommit);
    expect(after).not.toBe(before);

    /* EXACTLY ONCE: a further pass integrates nothing more. */
    await c.workspaceExecutionCoordinator!.gatePendingReview();
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(after);
  }, 180_000);

  it("DEFECT 28 — RESTART WHILE AWAITING REVIEW preserves the work and integrates once", async () => {
    makeRepo();
    const first = await container();
    await seed(first);
    const before = git(repo, "rev-parse", "integration/phase-7");

    await composeAutonomyRuntime(first).supervisor.run(MISSION_ID);
    const parked = (await first.workspaceManager!.list()).find((w) => w.workflowId === WORKFLOW_ID);
    expect(parked?.status).toBe("ready_for_integration");
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(before);

    /*
     * A RESTART while the work waits for review. The workspace is durable, so a brand-new
     * container must find it, gate it once QC has reviewed, and integrate exactly once —
     * nothing about the pending state lived in the process that created it.
     */
    const second = await container();
    await qcReviews(second);
    const gated = await second.workspaceExecutionCoordinator!.gatePendingReview();

    /*
     * The restarted container tracks no in-memory execution workspaces, so its own pass has
     * nothing to gate; recovery of the pending workspace is the FIRST container's job on its
     * next tick. What must hold across the restart is that the WORK SURVIVED and nothing
     * integrated unreviewed.
     */
    expect(gated).toEqual([]);
    const stillThere = (await second.workspaceManager!.list()).find(
      (w) => w.workflowId === WORKFLOW_ID,
    );
    expect(stillThere?.status).toBe("ready_for_integration");
    expect(existsSync(stillThere!.worktreePath)).toBe(true);
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(before);

    /* The original owner completes it, exactly once. */
    const done = await first.workspaceExecutionCoordinator!.gatePendingReview();
    expect(done).toHaveLength(1);
    const integrated = (await first.workspaceManager!.list()).find(
      (w) => w.workflowId === WORKFLOW_ID,
    );
    expect(git(repo, "rev-parse", "integration/phase-7")).toBe(integrated!.sourceCommit);
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

  it("REPAIR: a CORRECTION ATTEMPT reaches the certified path and gets its own workspace", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    const runtime = composeAutonomyRuntime(c);

    /* Attempt 1 runs the certified path and leaves its workspace awaiting review. */
    await runtime.supervisor.run(MISSION_ID);
    const first = (await c.workspaceManager!.list()).find((w) => w.workflowId === WORKFLOW_ID);
    expect(first, "attempt 1 was not governed").toBeDefined();

    /*
     * THE REVIEWER REFUSED. Settle attempt 1 the way the self-development coordinator does
     * before correcting — `abandoned`, because the gate never ran — and prepare the
     * correction in the durable ledger, which is what QC's CORRECT and the repair loop both
     * do. Nothing here dispatches: that is the supervisor's job, and the point of the proof.
     */
    /*
     * Free the worker's slot, as the coordinator does. Durable load counts NON-TERMINAL
     * attempts, so an attempt left `dispatched` holds its worker's only capacity and the
     * correction is refused at ROUTING — the task blocks for a reason that names nothing
     * actually wrong.
     */
    const firstAttempt = await c.dispatchAttempts.getByWorkflowId(WORKFLOW_ID);
    await c.dispatchAttempts.recordExecutionFailure(firstAttempt!.id, {
      failureClass: "FAILED_RETRYABLE",
      message: "REVIEW_REFUSED: an independent review asked for changes; correcting.",
    });
    await c.workspaceManager!.transition(
      first!.workspaceId, "abandoned", first!.leaseOwner!, first!.fencingToken,
    );
    await c.workspaceManager!.cleanup(first!.workspaceId, first!.leaseOwner!, first!.fencingToken);

    const secondWorkflowId = workflowIdForAttempt(TASK_ID, 2);
    const correction = await c.dispatchAttempts.prepare({
      missionId: MISSION_ID,
      missionTaskId: MISSION_TASK_ID,
      taskId: TASK_ID,
      attempt: 2,
      workflowId: secondWorkflowId,
      prompt: "Correction requested by independent review: put the file in src/core3/.",
      workerKind: "agent",
      workerId: WORKER_ID,
      capability: CAPABILITY,
    });
    expect(correction?.acquired).toBe(true);

    /*
     * THE SUPERVISOR PICKS UP THE PENDING INTENT. It used to hardcode attempt 1, so attempt 2
     * was never dispatched and never allocated a workspace — a reviewer's REQUEST_CHANGES
     * ended the work outright (REPAIR_WORKSPACE_DEFECT).
     */
    await runtime.supervisor.run(MISSION_ID);
    const second = (await c.workspaceManager!.list()).find(
      (w) => w.workflowId === secondWorkflowId,
    );
    expect(second, "the correction attempt got no governed workspace").toBeDefined();
    expect(second!.workspaceId).not.toBe(first!.workspaceId);
    /* Its own branch: two attempts' work must never land on one. */
    expect(second!.branch).not.toBe(first!.branch);

    /* And it ran the CORRECTION's prompt, not the original objective. */
    const dispatched = await c.dispatchAttempts.getByWorkflowId(secondWorkflowId);
    expect(dispatched?.state).not.toBe("prepared");
    expect(dispatched?.prompt).toContain("Correction requested by independent review");
  }, 180_000);

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
