import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  startTemporalRuntime,
  uniqueTaskQueue,
  type TemporalRuntime,
} from "@/test/temporal-runtime-harness";

import { loadEnv } from "@/config/env";
import { buildPostgresContainer, resetContainer, type Container } from "@/server/container";
import { missionTasks, missions, tasks } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { identities, type TestIdentity } from "@/test/test-identity";
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
const CAPABILITY = "code-generation";
const TARGET = "integration/phase-7";

/**
 * IDENTITY PER CASE, not per file.
 *
 * These were fixed constants, which was harmless while mission work ran on the in-process
 * executor — each test built its own executor, so two tests sharing `d36taska` could not
 * see each other. `DURABLE_MISSION_TASK` is orchestrated by Temporal now, and a Temporal
 * workflow id is GLOBAL to the namespace and OUTLIVES the execution that used it. One
 * `icos-task-d36taska` was therefore shared by all fourteen cases below, by every rerun of
 * this file, and by every process running it at once: the first case of a fresh run
 * passed, and from then on each one collided with the closed workflow its predecessor had
 * left behind.
 *
 * The database is truncated per case by `seed()`, so Temporal was the only shared state —
 * and the one nothing here may clean, because correctness must not depend on a cleanup
 * step a crashed run never reaches.
 *
 * `beforeEach` takes a fresh namespace, so a RETRIED case gets one too instead of
 * colliding with its own first run. Within a case every id is deterministic, so the
 * business assertions are exactly as exact as they were.
 */
const FILE_IDENTITIES = identities("d36");
let caseNumber = 0;
let ids: TestIdentity;

let MISSION_ID: string;
let MT_A: string;
let MT_B: string;
let TASK_A: string;
let TASK_B: string;
let WF_A: string;
let WF_B: string;

beforeEach(() => {
  caseNumber += 1;
  ids = FILE_IDENTITIES.forCase(`c${caseNumber}`);
  MISSION_ID = ids.mission();
  MT_A = ids.missionTask("a");
  MT_B = ids.missionTask("b");
  TASK_A = ids.task("a");
  TASK_B = ids.task("b");
  WF_A = ids.workflow(TASK_A, 1);
  WF_B = ids.workflow(TASK_B, 1);
});

/** `normal` writes inside the declared scope; `rogue` makes A write OUTSIDE it (capture REFUSES). */
type WorkerMode = "normal" | "rogue" | "fail-once";
let workerMode: WorkerMode = "normal";

const workerScript = (mode: WorkerMode) => `
  const fs = require('fs');
  const id = process.env.ICOS_TASK_ID;
  if ('${mode}' === 'fail-once' && id === '${TASK_A}' && !process.env.ICOS_WORKFLOW_ID.includes('-attempt-')) {
    /*
     * Edit, then hang past the worker timeout without committing — what a real agent killed
     * mid-task leaves (self-build run 2). A WORKER_TIMEOUT, which the canonical review answers RETRY.
     */
    fs.mkdirSync('src/' + id, { recursive: true });
    fs.writeFileSync('src/' + id + '/half-done.txt', 'uncommitted\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  }
  if (id === '${TASK_B}' && !fs.existsSync('src/${TASK_A}/feature.txt')) {
    process.stderr.write('B started before A was integrated');
    process.exit(3);
  }
  const dir = ('${mode}' === 'rogue' && id === '${TASK_A}' ? 'outside/' : 'src/') + id;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dir + '/feature.txt', 'built by ' + id + ' ' + process.env.ICOS_WORKFLOW_ID + '\\n');
  /*
   * No \`git commit\`: a confined worker holds no Git authority — its gitdir is read-only
   * in the sandbox — and ICOS records the tree it leaves (ADR 0073).
   */
  process.stdout.write('wrote ' + dir + '/feature.txt');
  /*
   * The production worker result contract: a structured status the activity reads, at
   * the path ICOS gave us. Stdout never decides success.
   */
  fs.writeFileSync(process.env.ICOS_WORKER_STATUS_FILE, JSON.stringify({
    completed: true, failed: false,
  }));
`;

// ------------------------------------------------------------------ OmniRoute network edge

type ReviewerMode = "fail" | "approve" | "changes" | "changes-once" | "retry-once" | "block";
let reviewerMode: ReviewerMode = "fail";
let reviewerRequests = 0;
let server: Server;
let reviewerUrl: string;

/*
 * THE REAL DURABLE PATH. `DURABLE_MISSION_TASK` is orchestrated by Temporal and nothing
 * else, so these tests need what production needs: a worker polling the queue, and an
 * ICOS endpoint for it to ask its authority of and report back to. Without them a
 * dispatch opened a workflow nobody consumed and sat at `dispatched` for ever — no
 * result, no quality-control job, the reviewer never asked.
 */
const TASK_QUEUE = uniqueTaskQueue("d36");
const CALLBACK_SECRET = "d36-callback-secret-at-least-32-chars-long";
let temporal: TemporalRuntime;

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
      /* `changes-once`: the first review asks for changes, every later one approves. */
      const mode =
        reviewerMode === "changes-once"
          ? reviewerRequests === 1
            ? "changes"
            : "approve"
          : reviewerMode === "retry-once"
            ? reviewerRequests === 1
              ? "retry"
              : "approve"
            : reviewerMode;
      const content =
        mode === "approve"
          ? { decision: "APPROVE", reasons: ["inside its declared scope"], confidence: 0.9 }
          : mode === "block"
            ? { decision: "BLOCK", reasons: ["unsafe change"], confidence: 0.9 }
            : mode === "retry"
              ? { decision: "RETRY", reasons: ["the worker failed; re-execute"], confidence: 0.9 }
              : {
                  decision: "REQUEST_CHANGES",
                  reasons: ["the feature file needs a header"],
                  requestedChanges: [{ field: "feature.txt", reason: "missing header" }],
                  confidence: 0.8,
                };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          /*
           * Un vrai fournisseur rapporte sa consommation. Sans ce bloc, chaque relecture
           * est UNMETERED, et une fenêtre non mesurée refuse tout appel suivant du goal.
           */
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  reviewerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(process.env, envOverrides());
  await resetContainer();
  temporal = await startTemporalRuntime(TASK_QUEUE);
});

afterAll(async () => {
  await temporal?.stop();
  await resetContainer();
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

  /*
   * AND PUBLISH THE PATHS THE ACTIVITY ACTUALLY READS.
   *
   * `beforeAll` assigns `process.env` once, before any repository exists — so
   * `ICOS_REPO_PATH` and `ICOS_WORKER_WORKSPACE_ROOT` were literally the string
   * "undefined" for the whole file. Containers and the production process never noticed,
   * because they are built with `loadEnv(envOverrides())` AFTER this function runs and so
   * get the real values; the Temporal ACTIVITY does notice, because it reads
   * `process.env` directly at run time, in this same process.
   *
   * The result was `WORKER_WORKSPACE_ROOT_UNREADABLE: racine déclarée introuvable` on
   * every governed write — the worktree-root boundary refusing a root that did not exist,
   * which is the correct answer to the wrong question. Re-published here, where the paths
   * are finally real, and per case because `afterEach` deletes the whole tree.
   */
  Object.assign(process.env, envOverrides());
}

function envOverrides(extra: Record<string, string> = {}) {
  return {
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: reviewerUrl,
    OMNIROUTE_API_KEY: "d36-key",
    ICOS_REVIEWER_MODEL: "d36-model",
    /*
     * La relecture est du TRAVAIL DE MISSION et passe par le compteur de dépense : sans
     * plafond configuré, le budget du goal n'est pas applicable et la réservation REFUSE
     * avant même d'émettre — le relecteur n'est alors jamais appelé. C'est le comportement
     * voulu, et c'est ce qu'un vrai déploiement doit configurer ; le test le configure donc
     * comme la production, au lieu de dépendre d'une relecture gratuite.
     */
    ICOS_GOAL_MAX_TOTAL_TOKENS: "5000000",
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: {
        command: process.execPath,
        args: ["-e", workerScript(workerMode)],
        timeoutMs: workerMode === "fail-once" ? 5_000 : 30_000,
      },
    }),
    ICOS_REPO_PATH: repo,
    ICOS_WORKER_WORKSPACE_ROOT: worktreeRoot,
    /*
     * The CHECKOUT the activity binds read-only — a separate deployment variable from the
     * worktree root above, read straight from `process.env` by the activity (see
     * `workspaceRoot()`), and never set here before. A governed write needs both: its own
     * worktree to write in, and the canonical checkout it branched from to read. Missing,
     * every write failed `ICOS_WORKSPACE_ROOT manquant` — fail-closed and correct, and
     * indistinguishable from the work simply never running.
     */
    ICOS_WORKSPACE_ROOT: repo,
    /* A queue of this file's own, so no other worker can consume its workflows. */
    TEMPORAL_TASK_QUEUE: TASK_QUEUE,
    ICOS_EXECUTION_CALLBACK_SECRET: CALLBACK_SECRET,
    ICOS_WORKER_EXECUTABLE_ALLOWLIST: JSON.stringify([process.execPath, "node"]),
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

/**
 * THE CONTAINER AND THE ACTIVITY MUST READ THE SAME DEPLOYMENT.
 *
 * `envOverrides()` is evaluated here and handed to the container, but the Temporal ACTIVITY
 * reads `process.env` directly at run time — so whatever was published LAST wins for the
 * worker, and `makeRepo` publishes before a case has chosen its worker mode.
 *
 * Measured consequence: `workerMode = "fail-once"` is set on the line AFTER `makeRepo()`,
 * so the activity ran the NORMAL worker with a 30s timeout. Attempt 1 therefore SUCCEEDED,
 * there was never a failed attempt, never a QC RETRY, never an attempt 2 and never any
 * uncommitted work to preserve — the case was asserting about a supersession that had not
 * happened. It worked before only because the in-process executor took its command from
 * the container's own configuration rather than from the environment.
 *
 * Re-published at every build point, so the two can no longer disagree by construction.
 */
function publishDeployment(): ReturnType<typeof envOverrides> {
  const env = envOverrides();
  Object.assign(process.env, env);
  return env;
}

async function container(): Promise<Container> {
  const built = await buildPostgresContainer(DATABASE_URL, undefined, loadEnv(publishDeployment()));
  containers.push(built);
  return built;
}

/** The REAL process entry point with a fast recovery tick. */
async function boot(): Promise<ProductionServices> {
  const services = await startProductionServices({
    env: loadEnv({
      ...publishDeployment(),
      NODE_ENV: "production",
      AUTONOMY_RECOVERY_INTERVAL_MS: "250",
    }),
    registerSignals: false,
    signals: { onSignal: () => {}, removeSignal: () => {}, exit: () => {} },
  });
  started.push(services);
  return services;
}

const WORKER_IDS = ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "ffffffff-ffff-4fff-8fff-ffffffffffff"];

const TRUNCATE_ALL =
  "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry RESTART IDENTITY CASCADE";

/**
 * TRUNCATE TAKES AN EXCLUSIVE LOCK, AND THIS DATABASE HAS A LIVE PEER.
 *
 * The Temporal worker and the callback endpoint live for the whole FILE, by design — a
 * workflow id outlives the execution that used it and nothing here may clean Temporal. So a
 * workflow of the case that just ended can still be reporting its result while the next case
 * truncates, and Postgres then resolves the lock cycle by killing one of them:
 *
 *   deadlock detected (40P01): AccessExclusiveLock (this TRUNCATE) vs RowShareLock (the
 *   callback's write)
 *
 * Measured once in two full 8-file gate runs, in `seed`, and it has nothing to do with what
 * any case asserts. It only became reachable now because the file got eight times faster
 * (521 s → 60 s): the two cases that used to time out at 240 s each gave every late callback
 * all the time in the world to drain, and a correction chain that now actually RUNS writes
 * more rows per case than one that never did.
 *
 * Retried, not slept over. The distinction matters: this is not waiting for a business
 * outcome to maybe happen — the TRUNCATE is setup, it was chosen as the deadlock victim by
 * the server, and the answer to losing a lock race is to take the lock again. A bounded
 * number of attempts, and a throw that still names the deadlock if the peer never lets go.
 */
async function truncateAll(c: Container): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await c.db!.execute(sql.raw(TRUNCATE_ALL));
      return;
    } catch (error) {
      /* 40P01 deadlock, 55P03 lock not available: lock contention, nothing else. */
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if ((code !== "40P01" && code !== "55P03") || attempt >= 10) throw error;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

async function seed(c: Container, workers = 2) {
  const now = new Date();
  await truncateAll(c);
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
/**
 * STUCK_EXECUTION_CAPACITY_DEFECT: attempts still holding a worker slot.
 *
 * SCOPED TO THIS MISSION. It counted every row in the table, which is the same assertion
 * only as long as the table holds nothing else — and the database has a live peer (see
 * `truncateAll`), so a late callback from the previous case can land a row after this case
 * truncated. Unscoped, that row fails a case for something another case did; scoped, the
 * invariant is unchanged and belongs to the mission it is asserted about.
 */
async function nonTerminalAttempts(c: Container) {
  const [row] = await rows<{ n: number }>(
    c,
    `select count(*)::int n from dispatch_attempts
     where mission_id = '${MISSION_ID}' and state in ('prepared','dispatched')`,
  );
  return row!.n;
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

/**
 * THE DURABLE RESULT, because the dispatch is ASYNCHRONOUS.
 *
 * `supervisor.run` used to execute the work inline, on the in-process executor, so when it
 * returned the result was already recorded. Temporal orchestrates mission work now
 * (ADR 0067): `run` only DISPATCHES, and the completion callback records the outcome from
 * another process afterwards.
 *
 * A case that cancels, registers a QC job, or inspects state straight after `run` was
 * therefore talking about an execution that did not exist yet — which surfaces as
 * QUALITY_CONTROL_EXECUTION_NOT_FOUND, or as a review that was never written. The wait is
 * on the row the callback writes, never a sleep.
 */
/**
 * THE CANONICAL LIFECYCLE, AS THE DATABASE AND GIT ACTUALLY HOLD IT.
 *
 * Diagnostic only: it asserts nothing and changes nothing. It exists because three
 * failures here were each explained by a plausible story that turned out to be wrong, and
 * a story is not evidence. Printed at the exact moment a case gives up, so attempt state,
 * workspace state, preservation and the git refs are read from one instant.
 */
async function dumpLifecycle(c: Container, label: string): Promise<void> {
  const attempts = await rows<Record<string, unknown>>(
    c,
    `select id, attempt, workflow_id, state, worker_id from dispatch_attempts
     where mission_id = '${MISSION_ID}' order by task_id, attempt`,
  );
  const results = await rows<Record<string, unknown>>(
    c,
    `select workflow_id, outcome, error_code from task_execution_results
     where workflow_id like 'icos-task-${ids.runId}%' or workflow_id like '%${ids.caseId}%'`,
  );
  const spaces = await rows<Record<string, unknown>>(
    c,
    `select workspace_id, task_id, branch, status, released_at, source_commit,
            lease_owner, fencing_token, workflow_id
     from icos_workspace_registry where mission_id = '${MISSION_ID}' order by created_at`,
  );
  const qc = await rows<Record<string, unknown>>(
    c,
    `select workflow_id, state, action, review_attempt_count, last_error
     from quality_control_jobs where mission_id = '${MISSION_ID}'`,
  );
  const mts = await rows<Record<string, unknown>>(
    c,
    `select id, task_id, status from mission_tasks where mission_id = '${MISSION_ID}' order by id`,
  );
  const reviews = await rows<Record<string, unknown>>(
    c,
    /* `decisions` is a CAMEL-CASE table: `mission_id` does not exist there, so this query
       threw and the catch below reported "no reviews" on every dump — the one field that
       would have named the verdict. */
    `select "workflowId", decision, "reviewerKind" from decisions where "missionId" = '${MISSION_ID}'`,
  ).catch(() => [] as Record<string, unknown>[]);
  const refs = git(repo, "for-each-ref", "--format=%(refname:short) %(objectname:short)")
    .split("\n")
    .filter(Boolean);
  const mission = await rows<{ status: string }>(
    c,
    `select status from missions where id = '${MISSION_ID}'`,
  );
  /* eslint-disable no-console */
  console.log(
    `\n===== LIFECYCLE [${label}] =====\n` +
      JSON.stringify(
        {
          mission: mission[0]?.status,
          missionTasks: mts,
          attempts,
          results,
          workspaces: spaces,
          qualityControl: qc,
          reviews,
          refs,
          target: targetHead(),
        },
        null,
        1,
      ),
  );
  /* eslint-enable no-console */
}

/**
 * WAITS FOR SETTLEMENT AND SAYS WHAT IT WAS WAITING ON.
 *
 * `until` alone reports only that the mission never settled, which is the one fact that
 * was already known. This prints a compact lifecycle line while it waits and the full
 * dump at the moment it gives up, so the LAST successful transition and the FIRST
 * expected-but-absent one are read from the run that failed. It asserts nothing and
 * changes nothing: the predicate and the timeout are exactly as they were.
 */
async function awaitSettled(c: Container, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let traced = 0;
  try {
    await until(
      "the mission settled",
      async () => {
        const elapsed = Date.now() - started;
        if (elapsed > traced + 15_000) {
          traced = elapsed;
          const line = await rows<Record<string, unknown>>(
            c,
            `select
               (select status from missions where id = '${MISSION_ID}') mission,
               (select string_agg(task_id || '=' || status, ' ' order by task_id)
                  from mission_tasks where mission_id = '${MISSION_ID}') tasks,
               (select string_agg(task_id || '#' || attempt || '=' || state, ' ' order by task_id, attempt)
                  from dispatch_attempts where mission_id = '${MISSION_ID}') attempts,
               (select string_agg(coalesce(workflow_id,'-') || '=' || status, ' ' order by created_at)
                  from icos_workspace_registry where mission_id = '${MISSION_ID}') workspaces,
               (select string_agg(workflow_id || '=' || state || '/' || coalesce(action,'-'), ' ')
                  from quality_control_jobs where mission_id = '${MISSION_ID}') qc,
               (select string_agg(workflow_id || '=' || outcome || coalesce('/' || error_code, ''), ' ')
                  from task_execution_results
                  where workflow_id like '%' || '${ids.caseId}' || '%') results,
               (select string_agg("workflowId" || '=' || decision, ' ')
                  from decisions where "missionId" = '${MISSION_ID}') reviews`,
          );
          /* eslint-disable-next-line no-console */
          console.log(`[t+${Math.round(elapsed / 1000)}s] ${JSON.stringify(line[0])}`);
        }
        return (await missionStatus(c)) === "succeeded";
      },
      timeoutMs,
    );
  } catch (error) {
    await dumpLifecycle(c, "settlement never reached");
    throw error;
  }
}

async function awaitExecution(c: Container, workflowId: string): Promise<string> {
  return until(`the execution result of ${workflowId}`, async () => {
    const [row] = await rows<{ outcome: string }>(
      c,
      `select outcome from task_execution_results where workflow_id = '${workflowId}'`,
    );
    return row?.outcome;
  });
}
const targetHead = () => git(repo, "rev-parse", TARGET);

/**
 * Drives A to "integrated, settlement not yet observed" in a process WITHOUT a scheduler,
 * through the production classes only: supervisor, real QC + reviewer client, and the
 * production pending-review sweeper. Nothing writes a review, a status or a wake-up.
 */
async function integrateAWithoutSettling(c: Container) {
  const runtime = composeAutonomyRuntime(c);
  await runtime.supervisor.run(MISSION_ID);
  /*
   * THE DURABLE PATH IS ASYNCHRONOUS. The in-process dispatcher ran the worker inline,
   * so `run()` returned with the result already persisted. Temporal returns as soon as
   * the workflow is accepted: the worker runs, and reports, afterwards. Waiting for the
   * result is modelling that, not conceding anything — the assertions below are
   * unchanged and still have to hold.
   */
  await until("the worker reported its result", async () => {
    const [row] = await rows<{ n: number }>(
      c,
      `select count(*)::int n from task_execution_results where workflow_id = '${WF_A}'`,
    );
    return row!.n > 0;
  });
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

    await until(
      "the mission settled",
      async () => (await missionStatus(c)) === "succeeded",
      120_000,
    );

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
    /* Every finished attempt gave its worker slot back. */
    expect(await nonTerminalAttempts(c)).toBe(0);
  }, 240_000);
});

describe("DEFECT 36 × 0050 — a correction attempt settles like any governed work", () => {
  it("CORRECTION_DAG_E2E: REQUEST_CHANGES → own workspace → APPROVE → gate → integrate → settle → B", async () => {
    makeRepo();
    await seed(await container());
    const base = targetHead();
    reviewerMode = "changes-once";
    const c = (await boot()).container;
    const WF_A2 = workflowIdForAttempt(TASK_A, 2);

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

    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);
    await awaitSettled(c, 240_000);

    /* A was reviewed twice by the real reviewer client: changes, then approval of the correction. */
    expect((await reviews(c, TASK_A)).map((r) => r.decision)).toEqual([
      "REQUEST_CHANGES",
      "APPROVE",
    ]);
    expect(await attempts(c, TASK_A)).toBe(2);

    /* The correction got its OWN governed workspace and branch; attempt 1 never integrated. */
    const wsA1 = (await workspaceOf(c, WF_A))!;
    const wsA2 = (await workspaceOf(c, WF_A2))!;
    expect(wsA2.workspaceId).not.toBe(wsA1.workspaceId);
    expect(wsA2.branch).not.toBe(wsA1.branch);
    expect(wsA1.status).not.toBe("accepted");
    expect(wsA2.status).toBe("accepted");

    /*
     * Attempt 1's REQUEST_CHANGES review is gated by the pending-review sweep and REFUSED (never
     * applied); B was not admitted when the correction was gated.
     */
    const decisions = await Promise.all(gateSpy.mock.results.map((r) => r.value));
    expect(
      atGate.flatMap((g, i) => (g.workspaceId === wsA1.workspaceId ? [decisions[i].decision] : [])),
    ).not.toContain("ACCEPT");
    expect(atGate.find((g) => g.workspaceId === wsA2.workspaceId)).toEqual({
      workspaceId: wsA2.workspaceId,
      bStatus: "draft",
      bAttempts: 0,
    });

    /* B was allocated FROM the integrated correction. */
    const wsB = (await workspaceOf(c, WF_B))!;
    expect(wsB.baseCommit).toBe(wsA2.sourceCommit);
    expect(git(repo, "merge-base", "--is-ancestor", wsA2.sourceCommit!, TARGET)).toBe("");
    expect(targetHead()).toBe(wsB.sourceCommit);
    expect(targetHead()).not.toBe(base);
    expect(await status(c, MT_A)).toBe("succeeded");
    expect(await status(c, MT_B)).toBe("succeeded");

    /* Exactly once. */
    await ticks(8);
    expect(await attempts(c, TASK_A)).toBe(2);
    expect(await attempts(c, TASK_B)).toBe(1);
    expect(applySpy.mock.calls.map(([id]) => id)).toEqual([wsA2.workspaceId, wsB.workspaceId]);
    const applied = await Promise.all(applySpy.mock.results.map((r) => r.value));
    expect(applied.map((o) => o.status)).toEqual(["INTEGRATED", "INTEGRATED"]);
    expect(await nonTerminalAttempts(c)).toBe(0);
  }, 420_000);
});

describe("SUPERSEDED_ATTEMPT_WORKSPACE_HELD — a retry after a FAILED execution is governed", () => {
  it("A's attempt 1 fails → QC RETRY → attempt 2 governed → reviewed → integrated → settled → B", async () => {
    makeRepo();
    workerMode = "fail-once";
    await seed(await container());
    reviewerMode = "approve";
    const c = (await boot()).container;
    const WF_A2 = workflowIdForAttempt(TASK_A, 2);

    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);
    await awaitSettled(c, 240_000);

    /* The failed attempt's workspace was retired, never integrated; the retry had its own. */
    const wsA1 = (await workspaceOf(c, WF_A))!;
    await dumpLifecycle(c, "SUPERSEDED before branch assertion");
    /* Its uncommitted work was preserved on its own branch, never on the target. */
    expect(git(repo, "show", `${wsA1.branch}:src/${TASK_A}/half-done.txt`)).toBe("uncommitted");
    expect(git(repo, "ls-tree", "-r", "--name-only", TARGET)).not.toContain("half-done.txt");
    const wsA2 = (await workspaceOf(c, WF_A2))!;
    expect(wsA1.releasedAt).not.toBeNull();
    expect(wsA1.status).not.toBe("accepted");
    expect(wsA2.status).toBe("accepted");
    expect((await workspaceOf(c, WF_B))!.baseCommit).toBe(wsA2.sourceCommit);
    expect(await status(c, MT_A)).toBe("succeeded");
    expect(await status(c, MT_B)).toBe("succeeded");
    expect(await nonTerminalAttempts(c)).toBe(0);
  }, 420_000);
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

  it("A ROGUE WRITER IS REFUSED AT CAPTURE: A fails, nothing is ever committed, B is never admitted", async () => {
    makeRepo();
    workerMode = "rogue";
    await seed(await container());
    const base = targetHead();
    /* APPROVE, deliberately: a reviewer that would say yes must not be able to make this pass. */
    reviewerMode = "approve";
    const c = (await boot()).container;
    const gateSpy = vi.spyOn(c.integrationGate!, "integrate");
    await composeAutonomyRuntime(c).supervisor.run(MISSION_ID);

    await until("A settled as failed", async () => (await status(c, MT_A)) === "failed");

    /*
     * WHERE THE VIOLATION IS CAUGHT MOVED, AND IT MOVED EARLIER (ADR 0073).
     *
     * This case used to prove: the worker commits out-of-scope work, the reviewer approves the
     * report, and the INTEGRATION GATE is the authority that refuses it. The worker now holds
     * no Git authority, so the trusted finalizer is what sees the out-of-scope path — before
     * anything is staged — and refuses to capture it at all. Everything downstream follows from
     * a refusal rather than from a rejected commit, so the four assertions below are the same
     * invariant stated at its new location.
     */
    const [execution] = await rows<{
      outcome: string;
      error_code: string | null;
      error_message: string | null;
    }>(
      c,
      `select outcome, error_code, error_message from task_execution_results
       where task_id = '${TASK_A}' order by recorded_at desc limit 1`,
    );
    /* 1. THE REFUSAL IS DURABLE AND NAMES ITS CAUSE. A refusal nobody records is a hang. */
    expect(execution!.outcome).toBe("failure");
    expect(execution!.error_code).toBe("INVALID_RESULT");
    expect(execution!.error_message).toContain("GOVERNED_WORK_NOT_MATERIALIZED");
    expect(execution!.error_message).toContain("OUT_OF_SCOPE");

    /*
     * 2. THE REVIEW JUDGES A FAILED EXECUTION, so it BLOCKS — with `reviewerMode = approve`
     * still set. The reviewer never gets to approve work that was never materialized, which is
     * exactly the ordering ADR 0073 buys: capture, then record, then review, then gate.
     */
    expect((await reviews(c, TASK_A)).map((r) => r.decision)).toEqual(["BLOCK"]);

    /* 3. THE GATE WAS NEVER ASKED. Stricter than the gate having rejected: there is no commit. */
    expect(gateSpy).not.toHaveBeenCalled();

    /* 4. AND THE OUT-OF-SCOPE PATH EXISTS IN NO COMMIT ANYWHERE — branch included. */
    const wsA = (await workspaceOf(c, WF_A))!;
    expect(wsA.sourceCommit).toBeNull();
    expect(git(repo, "ls-tree", "-r", "--name-only", wsA.branch!)).not.toContain("outside/");
    expect(git(repo, "ls-tree", "-r", "--name-only", TARGET)).not.toContain("outside/");

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

  it("INLINE GATE: review exists at execution end, gate ACCEPTs, apply NEEDS_REBASE — A is not done, B not admitted", async () => {
    makeRepo();
    const c = await container();
    await seed(c);
    reviewerMode = "approve";
    const runtime = composeAutonomyRuntime(c);

    /*
     * THE RACE, driven by the real QC: the worker's result is recorded, and QC reviews it
     * before the coordinator looks for a review — so the coordinator gates INLINE.
     */
    const dispatch = c.taskExecution.dispatch.bind(c.taskExecution);
    vi.spyOn(c.taskExecution, "dispatch").mockImplementation(async (input) => {
      const result = await dispatch(input);
      /*
       * THE RACE HAS TO BE BUILT ON THE RESULT, not on the dispatch returning.
       *
       * `dispatch` used to run the work; now it only starts a Temporal workflow, so at this
       * point there is no execution to review and `registerExecution` would register a job
       * for a result that does not exist (QUALITY_CONTROL_EXECUTION_NOT_FOUND). Waiting for
       * the callback's row keeps the ORDERING this case exists to prove — a review already
       * written when the coordinator comes looking — while putting it after the only moment
       * at which a review is possible at all.
       */
      await awaitExecution(c, WF_A);
      await runtime.qualityControl.registerExecution({
        missionId: MISSION_ID,
        missionTaskId: MT_A,
        taskId: TASK_A,
        workflowId: WF_A,
      });
      await runtime.qualityControl.recover(MISSION_ID);
      return result;
    });
    /* The target moves between the gate's ACCEPT and the apply. */
    const gate = c.integrationGate!;
    const realIntegrate = gate.integrate.bind(gate);
    vi.spyOn(gate, "integrate").mockImplementation(async (id, options) => {
      const report = await realIntegrate(id, options);
      git(repo, "checkout", "-q", TARGET);
      writeFileSync(path.join(repo, "OTHER.md"), "moved\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-q", "-m", "concurrent change");
      git(repo, "checkout", "-q", "main");
      return report;
    });
    const applySpy = vi.spyOn(c.integrationApplier!, "apply");

    await runtime.supervisor.run(MISSION_ID);

    expect((await reviews(c, TASK_A)).map((r) => r.decision)).toEqual(["APPROVE"]);
    expect((await applySpy.mock.results[0]!.value).status).toBe("NEEDS_REBASE");
    expect(await status(c, MT_A)).not.toBe("succeeded");
    /* The accepted-but-unapplied work is kept, not reaped. */
    expect((await workspaceOf(c, WF_A))?.releasedAt).toBeNull();
    await runtime.supervisor.run(MISSION_ID);
    await expectBBlocked(c);
  }, 180_000);

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
  ])(
    "A cancelled WHILE AWAITING REVIEW, registered by %s, then approved: never integrated, not resurrected",
    async (_path, viaCallback) => {
      makeRepo();
      const c = await container();
      await seed(c);
      const base = targetHead();
      const applySpy = vi.spyOn(c.integrationApplier!, "apply");
      const runtime = composeAutonomyRuntime(c);
      await runtime.supervisor.run(MISSION_ID);
      /* AWAITING REVIEW is a state the worker reaches, not one the dispatch returns in. */
      await awaitExecution(c, WF_A);
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
      /* CANCELLED_WORK_INTEGRATION_DEFECT: approved work of a cancelled task never lands. */
      expect(applySpy).not.toHaveBeenCalled();
      expect(targetHead()).toBe(base);
      expect((await workspaceOf(c, WF_A))?.releasedAt).not.toBeNull();
    },
    180_000,
  );
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
    await until(
      "B executed after the restart",
      async () => (await workspaceOf(c, WF_B))?.sourceCommit || undefined,
    );
    await until(
      "the mission settled",
      async () => (await missionStatus(c)) === "succeeded",
      120_000,
    );
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
