import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { missionTasks, missions, tasks } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { identities, type TestIdentity } from "@/test/test-identity";
import {
  startTemporalRuntime,
  uniqueTaskQueue,
  type TemporalRuntime,
} from "@/test/temporal-runtime-harness";
import {
  composeAutonomyRuntime,
  startProductionServices,
  type ProductionServices,
} from "@/server/system/production-services";
import { PendingReviewGateSweeper } from "@/server/workspace-manager/pending-review-gate-sweeper";

/**
 * DEFECT 28 CLOSURE — the natural order, driven by the RUNTIME.
 *
 *   execution → parked pending review → real QC/reviewer (recovery sweep) → canonical review
 *   persisted → production pending-review trigger → IntegrationGate → IntegrationApplier, once.
 *
 * Nothing in the natural-order proof writes a review, calls gatePendingReview(), calls the
 * IntegrationGate or the IntegrationApplier. The only test double is at the NETWORK edge: a
 * local HTTP endpoint that speaks the OmniRoute chat-completions API (the real LLM provider is
 * external). The request to it is made by ICOS's own reviewer client, invoked by ICOS's own QC
 * service, from ICOS's own production recovery scheduler, and the review it produces is
 * persisted by ICOS's own ReviewerService. The endpoint can answer APPROVE, REQUEST_CHANGES or
 * fail — failing is how "no review exists yet" is produced WITHOUT the test touching reviews.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const CAPABILITY = "code-generation";

/**
 * IDENTITY PER CASE, not per file.
 *
 * These were fixed constants, which was harmless while mission work ran on the in-process
 * executor — each case built its own executor, so two cases sharing a task id could not
 * see each other. `DURABLE_MISSION_TASK` is orchestrated by Temporal now, and a Temporal
 * workflow id is GLOBAL to the namespace and OUTLIVES the execution that used it. One
 * `icos-task-<taskId>` was therefore shared by every case in this file, by every rerun of
 * it, and by every process running it at once: the first case of a fresh run passed, and
 * from then on each one collided with the closed workflow its predecessor left behind.
 *
 * Nothing here cleans Temporal, deliberately: correctness must not depend on a cleanup
 * step a crashed run never reaches. A fresh namespace per run makes leftover state
 * irrelevant rather than merely unlikely.
 *
 * `beforeEach` takes a new namespace, so a RETRIED case gets one too instead of colliding
 * with its own first run. Within a case every id is deterministic, so the business
 * assertions stay exactly as exact as they were.
 */
const FILE_IDENTITIES = identities("d28");

/**
 * THE ORCHESTRATOR THIS SUITE DRIVES, which it never used to start.
 *
 * `DURABLE_MISSION_TASK` is orchestrated by Temporal and by nothing else (ADR 0067). This
 * file exercises the governed path through the REAL container, so every mission dispatch
 * goes to Temporal — but nothing here ever started a worker, and no queue was configured,
 * so the dispatcher fell back to its default `hello-world`, found no poller and refused
 * every dispatch. The workspace then sat `blocked`, which is what each of these cases was
 * actually asserting against when it expected `ready_for_integration`.
 *
 * It was invisible while mission work ran on the in-process executor: the suite built its
 * own executor and needed no orchestrator at all. The harness is the production workflow,
 * activities and callbacks, started on a queue of this file's own.
 */
const TASK_QUEUE = uniqueTaskQueue("d28");
const CALLBACK_SECRET = "d28-callback-secret-at-least-32-chars-long";
let temporal: TemporalRuntime | undefined;
let caseNumber = 0;
let ids: TestIdentity;

let MISSION_ID: string;
let MISSION_TASK_ID: string;
let TASK_ID: string;
let WORKFLOW_ID: string;

beforeEach(() => {
  caseNumber += 1;
  ids = FILE_IDENTITIES.forCase(`c${caseNumber}`);
  MISSION_ID = ids.mission();
  MISSION_TASK_ID = ids.missionTask("1");
  TASK_ID = ids.task("1");
  WORKFLOW_ID = ids.workflow(TASK_ID, 1);
});
const TARGET = "integration/phase-7";

const WORKER_SCRIPT = `
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const dir = 'src/' + process.env.ICOS_TASK_ID;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/feature.txt', 'built by ' + process.env.ICOS_TASK_ID + ' attempt ' + process.env.ICOS_WORKFLOW_ID + '\\n');
  execFileSync('git', ['add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-c','user.email=w@w','-c','user.name=w','commit','-q','-m','d28 feature'], { stdio: 'ignore' });
  process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
    status: 'succeeded', summary: 'wrote src/d28/feature.txt', testsRun: ['unit'],
  }) + process.env.ICOS_RESULT_SENTINEL_END);
`;

// ------------------------------------------------------------------ OmniRoute network edge

type ReviewerMode = "fail" | "approve" | "changes";
let reviewerMode: ReviewerMode = "fail";
let reviewerRequests = 0;
let server: Server;
let reviewerUrl: string;

beforeAll(async () => {
  /*
   * The runtime's real, non-interactive health probe, declared as a deployment declares it —
   * in the PROCESS environment, which is where the prober reads it. An unprobeable runtime is
   * recorded `unsupported` and routes nothing (decision 0036).
   */
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
        res
          .writeHead(503, { "content-type": "application/json" })
          .end('{"error":"provider unavailable"}');
        return;
      }
      const content =
        reviewerMode === "approve"
          ? {
              decision: "APPROVE",
              reasons: ["change is inside its declared scope and committed"],
              confidence: 0.9,
            }
          : {
              decision: "REQUEST_CHANGES",
              reasons: ["the feature file needs a header"],
              requestedChanges: [{ field: "src/d28/feature.txt", reason: "missing header" }],
              confidence: 0.8,
            };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          model: "test/reviewer",
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          /*
           * Un vrai fournisseur OpenAI-compatible rapporte sa consommation. Sans ce bloc,
           * chaque relecture est UNMETERED, et une fenêtre non mesurée refuse — à juste
           * titre — tout appel suivant du même goal. Le faux doit être fidèle sur ce que
           * le code mesure, sinon il teste un fournisseur qui n'existe pas.
           */
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  reviewerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  /*
   * BEFORE THE HARNESS STARTS, because the executable policy FREEZES ON IMPORT.
   *
   * `executable-policy.ts` reads ICOS_WORKER_EXECUTABLE_ALLOWLIST once, when it is first
   * imported, and never again — deliberately, so that nothing which later mutates the
   * environment can widen it. `startTemporalRuntime` imports the production activities
   * dynamically, so THAT call is when the policy is frozen, and an allowlist published
   * after it arrives too late: the set is empty, `decideExecutable` answers
   * EXECUTABLE_POLICY_EMPTY, and every governed run is refused WORKER_EXECUTABLE_DENIED.
   *
   * These two are static, so they belong here. The path-dependent values are published per
   * case by `makeRepo`, which is read at call time rather than frozen.
   */
  Object.assign(process.env, {
    ICOS_WORKER_EXECUTABLE_ALLOWLIST: JSON.stringify([process.execPath, "node"]),
    ICOS_EXECUTION_CALLBACK_SECRET: CALLBACK_SECRET,
  });
  temporal = await startTemporalRuntime(TASK_QUEUE);
});

afterAll(async () => {
  await temporal?.stop();
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
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

function makeRepo() {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "d28-natural-")));
  repo = path.join(tmp, "master");
  worktreeRoot = path.join(tmp, "trees");
  mkdirSync(repo);
  mkdirSync(worktreeRoot);
  git(repo, "init", "-q", "--initial-branch=main", ".");
  writeFileSync(path.join(repo, "README.md"), "canonical\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "branch", TARGET);
  /*
   * PUBLISH THE DEPLOYMENT TO THE PROCESS, because that is where the ACTIVITY reads it.
   *
   * `envOverrides()` is handed to `buildPostgresContainer`, which configures ICOS — but the
   * Temporal activity runs in the worker and reads `process.env` directly at call time
   * (`callbackSecret()`, `workspaceRoot()`, the exec-command table). Passing the values to
   * the container only is why every run died `ICOS_EXECUTION_CALLBACK_SECRET manquant ou
   * trop court`: a real deployment sets both, because they are the same environment.
   *
   * Done HERE rather than in `beforeAll` because `makeRepo` runs per case and the paths it
   * publishes change with it; a worker started once would otherwise keep pointing at the
   * first case's repository.
   */
  Object.assign(process.env, envOverrides());
}

function envOverrides(extra: Record<string, string> = {}) {
  return {
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: reviewerUrl,
    OMNIROUTE_API_KEY: "d28-natural-key",
    ICOS_REVIEWER_MODEL: "d28-natural-model",
    /*
     * La relecture est du TRAVAIL DE MISSION et passe par le compteur de dépense : sans
     * plafond configuré, le budget du goal n'est pas applicable et la réservation REFUSE
     * avant même d'émettre — le relecteur n'est alors jamais appelé. C'est le comportement
     * voulu, et c'est ce qu'un vrai déploiement doit configurer ; le test le configure donc
     * comme la production, au lieu de dépendre d'une relecture gratuite.
     */
    ICOS_GOAL_MAX_TOTAL_TOKENS: "5000000",
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: { command: process.execPath, args: ["-e", WORKER_SCRIPT], timeoutMs: 30_000 },
    }),
    ICOS_REPO_PATH: repo,
    ICOS_WORKER_WORKSPACE_ROOT: worktreeRoot,
    /*
     * The CHECKOUT the activity binds read-only, read straight from `process.env`. A
     * governed write needs both: its own worktree to write in, and the canonical checkout
     * it branched from to read.
     */
    ICOS_WORKSPACE_ROOT: repo,
    /* A queue of this file's own, so no other worker can consume its workflows. */
    TEMPORAL_TASK_QUEUE: TASK_QUEUE,
    ICOS_EXECUTION_CALLBACK_SECRET: CALLBACK_SECRET,
    ICOS_WORKER_EXECUTABLE_ALLOWLIST: JSON.stringify([process.execPath, "node"]),
    /* Every gate RULE is real; only the four pnpm suites are replaced by trivial passing commands. */
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

async function seed(c: Container, workers = 1) {
  const now = new Date();
  await c.db!.execute(
    sql.raw(
      "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry RESTART IDENTITY CASCADE",
    ),
  );
  await c.db!.insert(missions).values({
    id: MISSION_ID,
    title: "D28",
    objective: "Integrate only after an independent review, driven by the runtime",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await c.db!.insert(tasks).values({
    id: TASK_ID,
    title: "Add d28 feature",
    description: "Write src/d28task1/feature.txt and commit it",
    status: "draft",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    riskClass: "reversible",
    allowedFileScope: [`src/${TASK_ID}/**`],
    createdAt: now,
    updatedAt: now,
  });
  await c.db!.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "Add d28 feature",
    description: "Write src/d28task1/feature.txt and commit it",
    dependsOn: [],
    status: "draft",
    workerKind: null,
    capability: CAPABILITY,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });
  for (const id of WORKER_IDS.slice(0, workers)) await registerWorker(c, id);
}

const WORKER_IDS = ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"];

async function registerWorker(c: Container, id: string) {
  await c.workerRegistration.register({
    id,
    workerKind: "hermes",
    displayName: `d28-binary-${id.slice(0, 4)}`,
    capabilities: [CAPABILITY],
    runtime: "binary",
    runtimeSupport: "SUPPORTED_RUNTIME",
    maxConcurrency: 2,
  } as never);
  await c.workerRegistration.probe(id, {
    health: "healthy",
    availability: "available",
  });
}

async function workspace(c: Container) {
  return (await c.workspaceManager!.list()).find((w) => w.workflowId === WORKFLOW_ID);
}
async function reviews(c: Container) {
  return c.reviewDecisions.listByTaskId(TASK_ID);
}
async function missionTaskStatus(c: Container) {
  const [row] = (await c.db!.execute(
    sql.raw(`select status from mission_tasks where id = '${MISSION_TASK_ID}'`),
  )) as unknown as Array<{ status: string }>;
  return row!.status;
}
async function missionStatus(c: Container) {
  const [row] = (await c.db!.execute(
    sql.raw(`select status from missions where id = '${MISSION_ID}'`),
  )) as unknown as Array<{ status: string }>;
  return row!.status;
}
async function qcJobState(c: Container, workflowId = WORKFLOW_ID) {
  const [row] = (await c.db!.execute(
    sql.raw(`select state from quality_control_jobs where workflow_id = '${workflowId}'`),
  )) as unknown as Array<{ state: string }>;
  return row?.state;
}
async function leaseOwner(c: Container) {
  return (await workspace(c))?.leaseOwner ?? null;
}
/** Simulates the passage of time after a crash: the dead process's lease has run out. */
async function expireLeases(c: Container) {
  await c.db!.execute(
    sql.raw("UPDATE icos_workspace_registry SET lease_expires_at = now() - interval '1 second'"),
  );
}
/**
 * Simulates the passage of QC's reviewer-outage cooldown (REVIEW_UNAVAILABLE_COOLDOWN_MS, 5 min).
 * Touches ONLY the retry time of parked review jobs — never a review.
 *
 * Waits for the job to BE parked first: elapsing while a failing review is still in flight lets
 * QC park it afterwards with a fresh 5-minute cooldown, and the proof then times out.
 */
async function elapseReviewerCooldown(c: Container) {
  await until(
    "QC parked the review as unavailable",
    async () => (await qcJobState(c)) === "review_unavailable",
  );
  await c.db!.execute(
    sql.raw(
      "UPDATE quality_control_jobs SET claim_until = now() - interval '1 second' WHERE state = 'review_unavailable'",
    ),
  );
}
async function crash(c: Container) {
  await c.workspaceExecutionCoordinator?.shutdown();
  await expireLeases(c);
}
async function until<T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 60_000,
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
});

// ------------------------------------------------------------------ proofs

describe("DEFECT 28 closure — natural runtime order", () => {
  it("NATURAL_RUNTIME_REVIEW_GATE_E2E: execution → no review → real QC → trigger → gate → apply, exactly once", async () => {
    makeRepo();
    const seeded = await container();
    await seed(seeded);
    const before = git(repo, "rev-parse", TARGET);

    const services = await boot();
    const c = services.container;
    const gateSpy = vi.spyOn(c.integrationGate!, "integrate");
    const applySpy = vi.spyOn(c.integrationApplier!, "apply");

    /* The runtime starts the work (same composition as the scheduler). */
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);
    const parked = await workspace(c);
    expect(parked?.status).toBe("ready_for_integration");
    expect(await reviews(c)).toEqual([]);
    expect(git(repo, "rev-parse", TARGET)).toBe(before);

    /*
     * Reviewer unavailable: the REAL QC sweep tries (the endpoint is called) and fails closed.
     * No review, no gate, no integration — and no premature escalation or failure.
     */
    await until("QC asked the reviewer", async () => reviewerRequests > 0);
    await ticks(4);
    expect(await reviews(c)).toEqual([]);
    expect(gateSpy).not.toHaveBeenCalled();
    expect(applySpy).not.toHaveBeenCalled();
    expect(git(repo, "rev-parse", TARGET)).toBe(before);
    expect((await workspace(c))?.status).toBe("ready_for_integration");
    expect(["failed", "awaiting_approval", "blocked"]).not.toContain(await missionTaskStatus(c));

    /* QC parked the review after its bounded attempts: fail-closed, retried later. */
    const parkedJob = await until("QC parked the review as unavailable", async () => {
      const rows = (await c.db!.execute(
        sql.raw(`select state from quality_control_jobs where workflow_id = '${WORKFLOW_ID}'`),
      )) as unknown as Array<{ state: string }>;
      return rows[0]?.state === "review_unavailable" ? rows[0] : undefined;
    });
    expect(parkedJob.state).toBe("review_unavailable");
    expect(await reviews(c)).toEqual([]);

    /* The reviewer becomes available and the cooldown elapses. Everything after this is the runtime alone. */
    reviewerMode = "approve";
    await elapseReviewerCooldown(c);
    const after = await until("the runtime integrated the reviewed work", async () => {
      const ref = git(repo, "rev-parse", TARGET);
      return ref !== before ? ref : undefined;
    });

    const [review] = await reviews(c);
    expect(review).toMatchObject({
      decision: "APPROVE",
      reviewerKind: "llm",
      workflowId: WORKFLOW_ID,
    });
    expect(review!.providerMetadata).toMatchObject({ model: "d28-natural-model" });

    const settled = await workspace(c);
    expect(after).toBe(settled!.sourceCommit);
    expect(settled!.releasedAt).not.toBeNull();

    /* The run SETTLES: task, mission task and mission succeed; QC's job is closed. */
    await until("the mission settled", async () => (await missionStatus(c)) === "succeeded");
    expect(await missionTaskStatus(c)).toBe("succeeded");
    expect(await qcJobState(c)).toBe("action_applied");

    /* EXACTLY ONCE: more ticks change nothing; one gate call, one apply. */
    await ticks(6);
    expect(git(repo, "rev-parse", TARGET)).toBe(after);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect((await applySpy.mock.results[0]!.value).status).toBe("INTEGRATED");
  }, 180_000);

  it("REQUEST_CHANGES never integrates and enters the bounded repair path", async () => {
    makeRepo();
    const seeded = await container();
    /* A second eligible worker, so the routed correction has somewhere to go. */
    await seed(seeded, 2);
    const before = git(repo, "rev-parse", TARGET);
    reviewerMode = "changes";

    const services = await boot();
    const c = services.container;
    const applySpy = vi.spyOn(c.integrationApplier!, "apply");
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    await until("a REQUEST_CHANGES review was persisted", async () =>
      (await reviews(c)).some((r) => r.decision === "REQUEST_CHANGES"),
    );
    /* Bounded repair: QC prepared a correction attempt for the same task. */
    await until("a correction attempt exists", async () => {
      const rows = (await c.db!.execute(
        sql.raw(`select max(attempt)::int m from dispatch_attempts where task_id = '${TASK_ID}'`),
      )) as unknown as Array<{ m: number }>;
      return rows[0]!.m >= 2;
    });
    await ticks(6);
    expect(git(repo, "rev-parse", TARGET)).toBe(before);
    const applied = await Promise.all(applySpy.mock.results.map((r) => r.value));
    expect(applied.filter((o) => o?.status === "INTEGRATED")).toEqual([]);
  }, 180_000);
});

describe("DEFECT 28 closure — restart and concurrency", () => {
  it("RESTART AFTER EXECUTION, BEFORE REVIEW: a new process reviews, gates and integrates once", async () => {
    makeRepo();
    const a = await container();
    await seed(a);
    const before = git(repo, "rev-parse", TARGET);
    await composeAutonomyRuntime(a).supervisor.run(MISSION_ID);
    expect((await workspace(a))?.status).toBe("ready_for_integration");
    expect(await reviews(a)).toEqual([]);
    const deadOwner = await leaseOwner(a);
    await crash(a);

    /*
     * The new process boots while the reviewer is still unavailable. Unreviewed work is NOT
     * adopted: no lease is taken on it, nothing is gated, nothing integrated.
     */
    const b = (await boot()).container;
    await until("QC asked the reviewer", async () => reviewerRequests > 0);
    await ticks(4);
    expect(await reviews(b)).toEqual([]);
    expect(await leaseOwner(b)).toBe(deadOwner);
    expect(git(repo, "rev-parse", TARGET)).toBe(before);

    reviewerMode = "approve";
    await elapseReviewerCooldown(b);
    const after = await until("the restarted runtime integrated", async () => {
      const ref = git(repo, "rev-parse", TARGET);
      return ref !== before ? ref : undefined;
    });
    expect(after).toBe((await workspace(b))!.sourceCommit);
    await ticks(4);
    expect(git(repo, "rev-parse", TARGET)).toBe(after);
  }, 180_000);

  it("RESTART AFTER REVIEW, BEFORE GATE: the review survives and a new process gates it once", async () => {
    makeRepo();
    const a = await container();
    await seed(a);
    const before = git(repo, "rev-parse", TARGET);
    const runtimeA = composeAutonomyRuntime(a);
    await runtimeA.supervisor.run(MISSION_ID);

    /* The real QC path reviews in process A (no trigger runs there: A has no scheduler). */
    reviewerMode = "approve";
    await runtimeA.qualityControl.recover();
    expect((await reviews(a)).map((r) => r.decision)).toEqual(["APPROVE"]);
    expect(git(repo, "rev-parse", TARGET)).toBe(before);
    await crash(a);

    const b = (await boot()).container;
    const after = await until("the restarted runtime gated the reviewed work", async () => {
      const ref = git(repo, "rev-parse", TARGET);
      return ref !== before ? ref : undefined;
    });
    expect(after).toBe((await workspace(b))!.sourceCommit);
    await ticks(4);
    expect(git(repo, "rev-parse", TARGET)).toBe(after);
    expect((await reviews(b)).map((r) => r.decision)).toEqual(["APPROVE"]);
  }, 180_000);

  it("DUPLICATE REVIEWER DELIVERY and DUPLICATE SWEEPS integrate exactly once", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    const before = git(repo, "rev-parse", TARGET);
    const runtime = composeAutonomyRuntime(c);
    await runtime.supervisor.run(MISSION_ID);

    reviewerMode = "approve";
    await Promise.all([runtime.qualityControl.recover(), runtime.qualityControl.recover()]);
    await runtime.qualityControl.recover();
    expect((await reviews(c)).map((r) => r.decision)).toEqual(["APPROVE"]);

    const gateSpy = vi.spyOn(c.integrationGate!, "integrate");
    const sweeper = new PendingReviewGateSweeper(c.workspaceExecutionCoordinator!);
    const concurrent = await Promise.all([sweeper.sweep(), sweeper.sweep(), sweeper.sweep()]);
    const sequential = [await sweeper.sweep(), await sweeper.sweep()];

    const integrated = [...concurrent, ...sequential].reduce((n, r) => n + r.succeeded, 0);
    const after = git(repo, "rev-parse", TARGET);
    expect(after).not.toBe(before);
    expect(after).toBe((await workspace(c))!.sourceCommit);
    expect(gateSpy).toHaveBeenCalledTimes(1);
    /* The three concurrent sweeps shared ONE pass; later sweeps find nothing left to gate. */
    expect(integrated).toBe(3);
    expect(sequential.every((r) => r.discovered === 0)).toBe(true);
  }, 180_000);

  it("CONCURRENT RECOVERY WORKERS in two processes: exactly one adopts, exactly one integration", async () => {
    makeRepo();
    const a = await container();
    await seed(a);
    const before = git(repo, "rev-parse", TARGET);
    const runtimeA = composeAutonomyRuntime(a);
    await runtimeA.supervisor.run(MISSION_ID);
    reviewerMode = "approve";
    await runtimeA.qualityControl.recover();
    await crash(a);

    const x = await container();
    const y = await container();
    const gateX = vi.spyOn(x.integrationGate!, "integrate");
    const gateY = vi.spyOn(y.integrationGate!, "integrate");
    const [rx, ry] = await Promise.all([
      x.workspaceExecutionCoordinator!.gatePendingReview(),
      y.workspaceExecutionCoordinator!.gatePendingReview(),
    ]);

    expect(rx.length + ry.length).toBe(1);
    expect(gateX.mock.calls.length + gateY.mock.calls.length).toBe(1);
    const [only] = [...rx, ...ry];
    expect(only!.integration?.status).toBe("INTEGRATED");
    const after = git(repo, "rev-parse", TARGET);
    expect(after).not.toBe(before);

    /* Both keep sweeping: nothing is integrated a second time. */
    await Promise.all([
      x.workspaceExecutionCoordinator!.gatePendingReview(),
      y.workspaceExecutionCoordinator!.gatePendingReview(),
    ]);
    expect(git(repo, "rev-parse", TARGET)).toBe(after);
  }, 180_000);
});

describe("DEFECT 28 closure — one canonical integration authority (structural)", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) return sources(p);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [p] : [];
    });
  }
  const root = path.join(process.cwd(), "src");
  const callers = (pattern: RegExp) =>
    sources(root)
      .filter((f) => pattern.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(root, f))
      .sort();

  it("gatePendingReview() has exactly one production caller: the pending-review sweep", () => {
    expect(callers(/\.gatePendingReview\(/)).toEqual([
      "server/workspace-manager/pending-review-gate-sweeper.ts",
    ]);
  });

  it("the IntegrationGate and IntegrationApplier are driven only by the workspace coordinator", () => {
    /*
     * Decision 0052: self-development no longer gates, applies or completes anything itself.
     * It drives the same production sweeps, so there is ONE review/gate/settlement authority.
     */
    const expected = ["server/workspace-manager/workspace-execution-coordinator.ts"];
    expect(callers(/integrationGate\.integrate\(/)).toEqual(expected);
    expect(callers(/integrationApplier\.apply\(/)).toEqual(expected);
  });

  it("self-development never writes a MissionTask status to `succeeded` itself", () => {
    const coordinator = readFileSync(
      path.join(root, "server/autonomy/governed-self-development-coordinator.ts"),
      "utf8",
    );
    expect(coordinator).not.toMatch(/updateMissionTaskStatus\([^)]*"succeeded"/s);
    expect(coordinator).not.toMatch(/integrationGate|integrationApplier|\.cleanup\(/);
  });
});
