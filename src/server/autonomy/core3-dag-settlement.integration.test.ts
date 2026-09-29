import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { missionTasks, missions, tasks } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { computeReadyTasks } from "@/server/supervisor/readiness";
import {
  composeAutonomyRuntime,
  startProductionServices,
  type ProductionServices,
} from "@/server/system/production-services";
import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import { PendingReviewGateSweeper } from "@/server/workspace-manager/pending-review-gate-sweeper";

/**
 * DEFECT 36 — a dependent task becomes runnable only after its prerequisite's CANONICAL
 * SETTLEMENT (decision 0049).
 *
 *   A → B (B depends on A)
 *
 *   A ready → A executes → A awaits review → APPROVE persisted → pending-review gate →
 *   A integrated once → QC settlement observes the integration → A `succeeded` + durable wake
 *   → the canonical readiness authority (`computeReadyTasks`) admits B → B executes.
 *
 * Before the fix QC's ACCEPT wrote A `succeeded` and woke the mission on the same tick, BEFORE
 * the gate ran: B was dispatched from the pre-A target. The worker below makes that observable
 * without any clock: task B refuses to run unless A's file is already in its worktree.
 *
 * The only test double is the OmniRoute NETWORK edge (the real LLM provider is external); the
 * reviewer client, QC, the recovery scheduler, the gate and the applier are ICOS's own. The
 * natural proof never writes a review, a status, a wake-up, or calls the gate.
 *
 * Uses a DEDICATED database: run with ICOS_TEST_DATABASE_URL pointing at e.g. icos_d36_test.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "d36-mission";
const MT_A = "d36-mt-a";
const MT_B = "d36-mt-b";
const TASK_A = "d36taska";
const TASK_B = "d36taskb";
const CAPABILITY = "code-generation";
const WF_A = workflowIdForAttempt(TASK_A, 1);
const WF_B = workflowIdForAttempt(TASK_B, 1);
const TARGET = "integration/phase-7";

/** `normal` writes inside the declared scope; `rogue` makes A write OUTSIDE it (gate REJECT). */
type WorkerMode = "normal" | "rogue";
let workerMode: WorkerMode = "normal";

const workerScript = (mode: WorkerMode) => `
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const id = process.env.ICOS_TASK_ID;
  if (id === '${TASK_B}' && !fs.existsSync('src/${TASK_A}/feature.txt')) {
    process.stderr.write('B started before A was integrated');
    process.exit(3);
  }
  const dir = ('${mode}' === 'rogue' && id === '${TASK_A}' ? 'outside/' : 'src/') + id;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/feature.txt', 'built by ' + id + ' ' + process.env.ICOS_WORKFLOW_ID + '\\n');
  execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-c','user.email=w@w','-c','user.name=w','commit','-q','-m','d36 ' + id], { stdio: 'ignore' });
  process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
    status: 'succeeded', summary: 'wrote ' + dir + '/feature.txt', testsRun: ['unit'],
  }) + process.env.ICOS_RESULT_SENTINEL_END);
`;

// ------------------------------------------------------------------ OmniRoute network edge

type ReviewerMode = "fail" | "approve" | "changes" | "block";
let reviewerMode: ReviewerMode = "fail";
let reviewerRequests = 0;
let server: Server;
let reviewerUrl: string;

beforeAll(async () => {
  vi.stubEnv(
    "ICOS_WORKER_PROBE_COMMANDS",
    JSON.stringify({ binary: { command: process.execPath, args: ["-e", ""], timeoutMs: 10_000 } }),
  );
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      reviewerRequests += 1;
      if (reviewerMode === "fail") {
        res.writeHead(503, { "content-type": "application/json" }).end('{"error":"down"}');
        return;
      }
      const content =
        reviewerMode === "approve"
          ? { decision: "APPROVE", reasons: ["inside its declared scope"], confidence: 0.9 }
          : reviewerMode === "block"
            ? { decision: "BLOCK", reasons: ["unsafe change"], confidence: 0.9 }
            : {
                decision: "REQUEST_CHANGES",
                reasons: ["the feature file needs a header"],
                requestedChanges: [{ field: "feature.txt", reason: "missing header" }],
                confidence: 0.8,
              };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  reviewerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ------------------------------------------------------------------ fixture

let tmp: string | undefined;
let repo: string;
let worktreeRoot: string;
const containers: Container[] = [];
const started: ProductionServices[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

function makeRepo() {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "d36-dag-")));
  repo = path.join(tmp, "master");
  worktreeRoot = path.join(tmp, "trees");
  mkdirSync(repo);
  mkdirSync(worktreeRoot);
  git(repo, "init", "-q", "--initial-branch=main", ".");
  writeFileSync(path.join(repo, "README.md"), "canonical\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "branch", TARGET);
}

function envOverrides(extra: Record<string, string> = {}) {
  return {
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: reviewerUrl,
    OMNIROUTE_API_KEY: "d36-key",
    ICOS_REVIEWER_MODEL: "d36-model",
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: {
        command: process.execPath,
        args: ["-e", workerScript(workerMode)],
        timeoutMs: 30_000,
      },
    }),
    ICOS_REPO_PATH: repo,
    ICOS_WORKER_WORKSPACE_ROOT: worktreeRoot,
    /* Every gate RULE is real; only the pnpm suites are trivial passing commands. */
    ICOS_GATE_COMMANDS: JSON.stringify({
      install: [process.execPath, "-e", ""],
      typecheck: [process.execPath, "-e", ""],
      lint: [process.execPath, "-e", ""],
      unit: [process.execPath, "-e", ""],
      build: [process.execPath, "-e", ""],
      postgres: [[process.execPath, "-e", ""]],
    }),
    ...extra,
  };
}

async function container(): Promise<Container> {
  const built = await buildPostgresContainer(DATABASE_URL, undefined, loadEnv(envOverrides()));
  containers.push(built);
  return built;
}

/** The REAL process entry point with a fast recovery tick. */
async function boot(): Promise<ProductionServices> {
  const services = await startProductionServices({
    env: loadEnv(envOverrides({ NODE_ENV: "production", AUTONOMY_RECOVERY_INTERVAL_MS: "250" })),
    registerSignals: false,
    signals: { onSignal: () => {}, removeSignal: () => {}, exit: () => {} },
  });
  started.push(services);
  return services;
}

const WORKER_IDS = ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"];

async function seed(c: Container, workers = 2) {
  const now = new Date();
  await c.db!.execute(
    sql.raw(
      "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry RESTART IDENTITY CASCADE",
    ),
  );
  await c.db!.insert(missions).values({
    id: MISSION_ID,
    title: "D36",
    objective: "B runs only after A is canonically settled",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  for (const [id, mt, dependsOn] of [
    [TASK_A, MT_A, []],
    [TASK_B, MT_B, [MT_A]],
  ] as const) {
    await c.db!.insert(tasks).values({
      id,
      title: `Add ${id} feature`,
      description: `Write src/${id}/feature.txt and commit it`,
      status: "draft",
      assignedAgentId: null,
      requiredCapabilities: [CAPABILITY],
      riskClass: "reversible",
      allowedFileScope: [`src/${id}/**`],
      createdAt: now,
      updatedAt: now,
    });
    await c.db!.insert(missionTasks).values({
      id: mt,
      missionId: MISSION_ID,
      title: `Add ${id} feature`,
      description: `Write src/${id}/feature.txt and commit it`,
      dependsOn: [...dependsOn],
      status: "draft",
      workerKind: null,
      capability: CAPABILITY,
      taskId: id,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const id of WORKER_IDS.slice(0, workers)) {
    await c.workerRegistration.register({
      id,
      workerKind: "hermes",
      displayName: `d36-binary-${id.slice(0, 4)}`,
      capabilities: [CAPABILITY],
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: 2,
    } as never);
    await c.workerRegistration.probe(id, { health: "healthy", availability: "available" });
  }
}

async function rows<T>(c: Container, query: string): Promise<T[]> {
  return (await c.db!.execute(sql.raw(query))) as unknown as T[];
}
async function status(c: Container, missionTaskId: string) {
  const [row] = await rows<{ status: string }>(
    c,
    `select status from mission_tasks where id = '${missionTaskId}'`,
  );
  return row!.status;
}
async function missionStatus(c: Container) {
  const [row] = await rows<{ status: string }>(
    c,
    `select status from missions where id = '${MISSION_ID}'`,
  );
  return row!.status;
}
async function attempts(c: Container, taskId: string) {
  const [row] = await rows<{ n: number }>(
    c,
    `select count(*)::int n from dispatch_attempts where task_id = '${taskId}'`,
  );
  return row!.n;
}
async function workspaceOf(c: Container, workflowId: string) {
  return (await c.workspaceManager!.list()).find((w) => w.workflowId === workflowId);
}
async function reviews(c: Container, taskId: string) {
  return c.reviewDecisions.listByTaskId(taskId);
}
async function readyKeys(c: Container) {
  const mission = await c.mission.findById(MISSION_ID);
  return computeReadyTasks(mission!, await c.mission.listTasks(MISSION_ID)).map((t) => t.id);
}
/** B is NOT admitted: not ready, never prepared, never dispatched. */
async function expectBBlocked(c: Container) {
  expect(await status(c, MT_B)).toBe("draft");
  expect(await attempts(c, TASK_B)).toBe(0);
  expect(await readyKeys(c)).not.toContain(MT_B);
}
async function expireLeases(c: Container) {
  await c.db!.execute(
    sql.raw("UPDATE icos_workspace_registry SET lease_expires_at = now() - interval '1 second'"),
  );
}
async function crash(c: Container) {
  await c.workspaceExecutionCoordinator?.shutdown();
  await expireLeases(c);
}
/**
 * The reviewer comes back: waits until QC PARKED A's review (reviewer down), THEN makes the
 * reviewer answer APPROVE and elapses QC's outage cooldown. Touches ONLY the retry time of
 * parked jobs — never a review.
 */
async function approveAfterOutage(c: Container) {
  await until("QC parked A's review as unavailable", async () => {
    const [row] = await rows<{ state: string }>(
      c,
      `select state from quality_control_jobs where workflow_id = '${WF_A}'`,
    );
    return row?.state === "review_unavailable";
  });
  reviewerMode = "approve";
  await c.db!.execute(
    sql.raw(
      "UPDATE quality_control_jobs SET claim_until = now() - interval '1 second' WHERE state = 'review_unavailable'",
    ),
  );
}
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const ticks = (n: number) => new Promise((r) => setTimeout(r, n * 250 + 200));
const targetHead = () => git(repo, "rev-parse", TARGET);

/**
 * Drives A to "integrated, settlement not yet observed" in a process WITHOUT a scheduler,
 * through the production classes only: supervisor, real QC + reviewer client, and the
 * production pending-review sweeper. Nothing writes a review, a status or a wake-up.
 */
async function integrateAWithoutSettling(c: Container) {
  const runtime = composeAutonomyRuntime(c);
  await runtime.supervisor.run(MISSION_ID);
  reviewerMode = "approve";
  await runtime.qualityControl.recover();
  expect((await reviews(c, TASK_A)).map((r) => r.decision)).toEqual(["APPROVE"]);
  const before = targetHead();
  const gated = await new PendingReviewGateSweeper(c.workspaceExecutionCoordinator!).sweep();
  expect(gated.succeeded).toBe(1);
  const integrated = targetHead();
  expect(integrated).not.toBe(before);
  expect(integrated).toBe((await workspaceOf(c, WF_A))!.sourceCommit);
  return { runtime, integrated };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(started.splice(0).map((s) => s.stop()));
  await Promise.all(
    containers.splice(0).map(async (c) => {
      await c.workspaceExecutionCoordinator?.shutdown();
      await c.close();
    }),
  );
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
  reviewerMode = "fail";
  reviewerRequests = 0;
  workerMode = "normal";
});

// ------------------------------------------------------------------ proofs

describe("DEFECT 36 — natural two-task DAG progression", () => {
  it("TWO_TASK_DAG_E2E: B becomes ready only after A's canonical integrated settlement, exactly once", async () => {
    makeRepo();
    const seeded = await container();
    await seed(seeded);
    const base = targetHead();

    /* 1-2. A is ready, B is blocked by its dependency (the canonical readiness authority). */
    expect(await readyKeys(seeded)).toEqual([MT_A]);
    await expectBBlocked(seeded);

    const services = await boot();
    const c = services.container;

    /*
     * Observe B at the exact moments A is gated and applied. The spies wrap the REAL gate and
     * applier; they only record, they never decide.
     */
    const atGate: Array<{ workspaceId: string; bStatus: string; bAttempts: number }> = [];
    const gate = c.integrationGate!;
    const realIntegrate = gate.integrate.bind(gate);
    const gateSpy = vi.spyOn(gate, "integrate").mockImplementation(async (id, options) => {
      atGate.push({
        workspaceId: id,
        bStatus: await status(c, MT_B),
        bAttempts: await attempts(c, TASK_B),
      });
      return realIntegrate(id, options);
    });
    const applySpy = vi.spyOn(c.integrationApplier!, "apply");

    /* 3. The runtime starts the mission: A executes (same composition as the scheduler). */
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);
    expect((await workspaceOf(c, WF_A))?.status).toBe("ready_for_integration");
    expect(await attempts(c, TASK_A)).toBe(1);
    /* 4-6. A executed and awaits review: B is still blocked. */
    await expectBBlocked(c);

    /* No review yet (reviewer down): QC fails closed, nothing is gated, B stays blocked. */
    await until("QC asked the reviewer", async () => reviewerRequests > 0);
    await ticks(4);
    expect(await reviews(c, TASK_A)).toEqual([]);
    expect(gateSpy).not.toHaveBeenCalled();
    expect(targetHead()).toBe(base);
    expect(await status(c, MT_A)).not.toBe("succeeded");
    await expectBBlocked(c);

    /* 7-9. The reviewer comes back; from here on everything is the runtime alone. */
    await approveAfterOutage(c);

    /* A's APPROVE existed and A was gated while B was still NOT admitted. */
    await until("A was gated", async () => atGate.length > 0);
    expect(atGate[0]).toEqual({
      workspaceId: (await workspaceOf(c, WF_A))!.workspaceId,
      bStatus: "draft",
      bAttempts: 0,
    });

    await until("the mission settled", async () => (await missionStatus(c)) === "succeeded", 120_000);

    const wsA = (await workspaceOf(c, WF_A))!;
    const wsB = (await workspaceOf(c, WF_B))!;
    /* 10. B was allocated FROM the integrated A — it could not have started earlier. */
    expect(wsB.baseCommit).toBe(wsA.sourceCommit);
    expect(git(repo, "merge-base", "--is-ancestor", wsA.sourceCommit!, TARGET)).toBe("");
    expect(targetHead()).toBe(wsB.sourceCommit);

    expect((await reviews(c, TASK_A)).map((r) => [r.decision, r.reviewerKind])).toEqual([
      ["APPROVE", "llm"],
    ]);
    expect((await reviews(c, TASK_B)).map((r) => r.decision)).toEqual(["APPROVE"]);
    expect(await status(c, MT_A)).toBe("succeeded");
    expect(await status(c, MT_B)).toBe("succeeded");

    /* 11-15. Exactly once: one attempt each, one gate + one apply each, nothing after. */
    await ticks(8);
    expect(await attempts(c, TASK_A)).toBe(1);
    expect(await attempts(c, TASK_B)).toBe(1);
    expect(gateSpy).toHaveBeenCalledTimes(2);
    const applied = await Promise.all(applySpy.mock.results.map((r) => r.value));
    expect(applied.map((o) => o.status)).toEqual(["INTEGRATED", "INTEGRATED"]);
    expect(targetHead()).toBe(wsB.sourceCommit);
  }, 240_000);
});

describe("DEFECT 36 — B stays blocked unless A settles successfully", () => {
  it("REQUEST_CHANGES on A: A never settles, B is never admitted", async () => {
    makeRepo();
    await seed(await container());
    const base = targetHead();
    reviewerMode = "changes";
    const c = (await boot()).container;
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    await until("a REQUEST_CHANGES review on A", async () =>
      (await reviews(c, TASK_A)).some((r) => r.decision === "REQUEST_CHANGES"),
    );
    await until("QC prepared A's correction attempt", async () => (await attempts(c, TASK_A)) >= 2);
    await ticks(8);
    expect(targetHead()).toBe(base);
    expect(await status(c, MT_A)).not.toBe("succeeded");
    await expectBBlocked(c);
  }, 240_000);

  it("A review BLOCK: A fails, B is never admitted", async () => {
    makeRepo();
    await seed(await container());
    const base = targetHead();
    reviewerMode = "block";
    const c = (await boot()).container;
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    await until("A failed", async () => (await status(c, MT_A)) === "failed");
    await ticks(8);
    expect(targetHead()).toBe(base);
    await expectBBlocked(c);
  }, 240_000);

  it("A APPROVED but the gate REJECTS its integration: A fails, B is never admitted", async () => {
    makeRepo();
    workerMode = "rogue";
    await seed(await container());
    const base = targetHead();
    reviewerMode = "approve";
    const c = (await boot()).container;
    const gateSpy = vi.spyOn(c.integrationGate!, "integrate");
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    await until("A settled as failed", async () => (await status(c, MT_A)) === "failed");
    expect((await reviews(c, TASK_A)).map((r) => r.decision)).toEqual(["APPROVE"]);
    expect((await gateSpy.mock.results[0]!.value).decision).toBe("REJECT");
    await ticks(8);
    expect(targetHead()).toBe(base);
    await expectBBlocked(c);
  }, 240_000);

  it("A APPROVED but its integration cannot apply (target moved, NEEDS_REBASE): B is never admitted", async () => {
    makeRepo();
    await seed(await container());
    const c = (await boot()).container;
    const gateSpy = vi.spyOn(c.integrationGate!, "integrate");
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);
    expect((await workspaceOf(c, WF_A))?.status).toBe("ready_for_integration");

    /* Someone else advances the target while A waits for review. */
    git(repo, "checkout", "-q", TARGET);
    writeFileSync(path.join(repo, "OTHER.md"), "moved\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "concurrent change");
    git(repo, "checkout", "-q", "main");
    const moved = targetHead();

    await approveAfterOutage(c);
    await until("A was gated", async () => gateSpy.mock.calls.length > 0);
    expect((await gateSpy.mock.results[0]!.value).decision).toBe("NEEDS_REBASE");
    await ticks(8);
    expect((await reviews(c, TASK_A)).map((r) => r.decision)).toEqual(["APPROVE"]);
    expect(targetHead()).toBe(moved);
    expect(await status(c, MT_A)).not.toBe("succeeded");
    await expectBBlocked(c);
  }, 240_000);

  it("A cancelled: B is never admitted", async () => {
    makeRepo();
    const seeded = await container();
    await seed(seeded);
    await seeded.mission.updateMissionTaskStatus(MISSION_ID, MT_A, "cancelled");
    reviewerMode = "approve";
    const c = (await boot()).container;
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);
    await ticks(8);
    expect(await attempts(c, TASK_A)).toBe(0);
    expect(await status(c, MT_A)).toBe("cancelled");
    await expectBBlocked(c);
  }, 120_000);

  it.each([
    ["the recovery sweep (recoverUnregistered)", false],
    ["the completion callback (registerExecution)", true],
  ])("A cancelled WHILE AWAITING REVIEW, registered by %s, then approved and integrated: not resurrected", async (_path, viaCallback) => {
    makeRepo();
    const c = await container();
    await seed(c);
    const runtime = composeAutonomyRuntime(c);
    await runtime.supervisor.run(MISSION_ID);
    await c.mission.updateMissionTaskStatus(MISSION_ID, MT_A, "cancelled");
    if (viaCallback) {
      /* What the execution-completed route does for a recorded result. */
      await runtime.qualityControl.registerExecution({
        missionId: MISSION_ID,
        missionTaskId: MT_A,
        taskId: TASK_A,
        workflowId: WF_A,
      });
    }

    reviewerMode = "approve";
    await runtime.qualityControl.recover();
    await new PendingReviewGateSweeper(c.workspaceExecutionCoordinator!).sweep();
    const sweeper = new QualityControlRecoverySweeper(
      runtime.qualityControl,
      c.qualityControlJobs,
      (missionId) => runtime.wakeup.wake(missionId),
    );
    await sweeper.sweep();
    await sweeper.sweep();

    expect(await status(c, MT_A)).toBe("cancelled");
    await expectBBlocked(c);
  }, 180_000);
});

describe("DEFECT 36 — durability and exactly-once", () => {
  it("A INTEGRATED but settlement not yet observed: B is not ready; A is not yet succeeded", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    await integrateAWithoutSettling(c);
    /* Integrated in git, reaped — but the settlement has not been observed: not a dependency yet. */
    expect(await status(c, MT_A)).toBe("review_pending");
    await expectBBlocked(c);
  }, 180_000);

  it("RESTART after A's integration, before B's readiness: a new process settles A and admits B once", async () => {
    makeRepo();
    const a = await container();
    await seed(a);
    const { integrated } = await integrateAWithoutSettling(a);
    await expectBBlocked(a);
    await crash(a);

    const c = (await boot()).container;
    await until("B executed after the restart", async () => (await workspaceOf(c, WF_B))?.sourceCommit || undefined);
    await until("the mission settled", async () => (await missionStatus(c)) === "succeeded", 120_000);
    expect(await status(c, MT_A)).toBe("succeeded");
    expect((await workspaceOf(c, WF_B))!.baseCommit).toBe(integrated);
    await ticks(6);
    expect(await attempts(c, TASK_B)).toBe(1);
  }, 240_000);

  it("DUPLICATE SETTLEMENT / RECOVERY SWEEPS admit B at most once", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    const { runtime, integrated } = await integrateAWithoutSettling(c);

    const sweeper = new QualityControlRecoverySweeper(
      runtime.qualityControl,
      c.qualityControlJobs,
      (missionId) => runtime.wakeup.wake(missionId),
    );
    await Promise.all([sweeper.sweep(), sweeper.sweep(), sweeper.sweep()]);
    await sweeper.sweep();
    await sweeper.sweep();
    expect(await c.qualityControlJobs.settleAccepted(MISSION_ID)).toBe(0);

    expect(await status(c, MT_A)).toBe("succeeded");
    expect(await attempts(c, TASK_B)).toBe(1);
    const bWorkspaces = (await c.workspaceManager!.list()).filter((w) => w.taskId === TASK_B);
    expect(bWorkspaces).toHaveLength(1);
    expect(bWorkspaces[0]!.baseCommit).toBe(integrated);
  }, 240_000);

  it("TWO CONCURRENT RECONCILERS in two processes: B is admitted and dispatched exactly once", async () => {
    makeRepo();
    const a = await container();
    await seed(a);
    const { integrated } = await integrateAWithoutSettling(a);
    await crash(a);

    const x = await container();
    const y = await container();
    const rx = composeAutonomyRuntime(x);
    const ry = composeAutonomyRuntime(y);
    const sx = new QualityControlRecoverySweeper(rx.qualityControl, x.qualityControlJobs, (m) =>
      rx.wakeup.wake(m),
    );
    const sy = new QualityControlRecoverySweeper(ry.qualityControl, y.qualityControlJobs, (m) =>
      ry.wakeup.wake(m),
    );
    const dispatchX = vi.spyOn(x.taskExecution, "dispatch");
    const dispatchY = vi.spyOn(y.taskExecution, "dispatch");

    await Promise.all([sx.sweep(), sy.sweep()]);
    await Promise.all([sx.sweep(), sy.sweep()]);

    expect(await status(x, MT_A)).toBe("succeeded");
    expect(await attempts(x, TASK_B)).toBe(1);
    const bDispatches = [...dispatchX.mock.calls, ...dispatchY.mock.calls].filter(
      ([input]) => input.taskId === TASK_B,
    );
    expect(bDispatches).toHaveLength(1);
    expect((await workspaceOf(x, WF_B))!.baseCommit).toBe(integrated);
  }, 240_000);
});
