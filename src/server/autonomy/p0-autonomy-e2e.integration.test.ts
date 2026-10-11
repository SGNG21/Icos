import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadEnv } from "@/config/env";
import { classifyMissionAutonomy } from "@/core/autonomy/mission-autonomy-policy";
import { POLICY_DECIDER } from "@/core/cognitive/turn-policy";
import { CanonicalGoalLauncher } from "@/server/cognitive/mission-gateway";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { EXECUTION_CALLBACK_HEADER } from "@/server/execution/callback-auth";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import {
  composeAutonomyRuntime,
  startProductionServices,
  type ProductionServices,
} from "@/server/system/production-services";
import type { IntegrationReport } from "@/server/workspace-manager/report";
import {
  startTemporalRuntime,
  uniqueTaskQueue,
  type TemporalRuntime,
} from "@/test/temporal-runtime-harness";

/*
 * THE EXECUTABLE POLICY FREEZES ON FIRST IMPORT (executable-policy.ts), and this file's static
 * imports (the cognitive launcher's graph) reach it before any `beforeAll` runs. A deployment
 * sets its environment before the process starts; hoisting is the test's equivalent.
 */
vi.hoisted(() => {
  process.env.ICOS_WORKER_EXECUTABLE_ALLOWLIST = JSON.stringify([process.execPath, "node"]);
});

/**
 * P0 AUTONOMY E2E — one goal sentence to one integrated, tested, reviewed fix.
 *
 * INPUT: a goal ("audit module X, find the defect, fix it in an isolated worktree, run its
 * tests, get it reviewed, correct if needed, prepare it for integration") launched through the
 * CANONICAL goal path (`CanonicalGoalLauncher` → durable `start_mission` job), with a client
 * and project in its metadata. Nothing after that is driven by this file: the production
 * recovery tick (startProductionServices) ignites the mission, plans it, routes and dispatches
 * each task to Temporal, QC reviews, the supervisor dispatches the correction, the pending-review
 * pass gates and applies, and settlement completes the mission.
 *
 * REAL: PostgreSQL, Temporal (isolated server, queue of this file), the production workflow /
 * activities / callbacks, a real git repository and worktrees, the worker sandbox, the gate's
 * SandboxedCommandRunner actually running the fixture's own `node --test` suite.
 *
 * DOUBLES, and why: the PLANNER and the WORKER are deterministic node scripts declared as
 * configuration (no model, no network); the REVIEWER is the production LLM reviewer talking to
 * a local OpenAI-compatible endpoint (the provider is the network edge). The gate's install /
 * typecheck / lint / build / postgres steps are trivial: the fixture has none of those, and
 * the step that matters here — the unit tests — is the fixture's real suite.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const TARGET = "integration/phase-7";
const SCOPE = "src/x/**";
const CLIENT_ID = "p0-e2e-client";
const PROJECT_ID = "p0-e2e-project";
const TASK_QUEUE = uniqueTaskQueue("p0e2e");
const CALLBACK_SECRET = "p0-e2e-callback-secret-at-least-32-chars";

/*
 * CANARIES. Set in THIS process's environment, which is the parent of the worker activity and
 * of the gate. The OmniRoute-like key is the reviewer's real credential in this run (the fake
 * provider asserts it arrives), so it is a LIVE secret of the parent, not a decoy nobody uses.
 */
const CANARY_MARK = "p0e2e-canary";
const CANARY_VALUE = `${CANARY_MARK}-${process.pid}-${Date.now().toString(36)}`;
const OMNIROUTE_KEY = `sk-${CANARY_MARK}-omniroute-${process.pid}`;

const WRITER_TITLE = "Fix the defect in module X";
const READER_TITLE = "Audit module X";

// ------------------------------------------------------------------ fixture module X

const SUM_DEFECTIVE = `// Sums a list of numbers.
export function sum(values) {
  let total = 0;
  for (let i = 1; i < values.length; i += 1) total += values[i];
  return total;
}
`;
const SUM_FIXED = `// Sums a list of numbers.
export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i];
  return total;
}
`;
/* A plausible but WRONG fix: passes the empty case, still drops an element. */
const SUM_BROKEN_FIX = `// Sums a list of numbers.
export function sum(values) {
  let total = 0;
  for (let i = 0; i < values.length - 1; i += 1) total += values[i];
  return total;
}
`;
const SUM_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.mjs";

test("sums every element", () => {
  assert.equal(sum([1, 2, 3]), 6);
});
`;
const SUM_REGRESSION_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { sum } from "./sum.mjs";

test("regression: the first element is counted", () => {
  assert.equal(sum([5]), 5);
  assert.equal(sum([]), 0);
});
`;
/*
 * Runs INSIDE the gate's unit step. It fails if the gate's environment carries any canary, by
 * name or by value — so an ACCEPT is itself evidence the sandboxed runner did not inherit them.
 * Proven able to fail (positive control) before the mission starts.
 *
 * `ICOS_TEST_DATABASE_URL` is deliberately NOT matched: the gate hands every step the URL of the
 * workspace's OWN disposable test database (integration-gate.ts `command`), by design. The
 * parent's `DATABASE_URL` is matched exactly.
 */
const ENV_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";

test("the verification environment carries no parent secret", () => {
  const leaked = Object.entries(process.env)
    .filter(([k, v]) => /CANARY|OMNIROUTE|API_KEY|CALLBACK_SECRET|^DATABASE_URL$/.test(k) || String(v).includes(${JSON.stringify(CANARY_MARK)}))
    .map(([k]) => k);
  assert.deepEqual(leaked, []);
});
`;

// ------------------------------------------------------------------ deterministic worker

type WorkerMode = "correct" | "broken";
/*
 * Attempt 1 fixes the defect. The reviewer then asks for a regression test, and the correction
 * (attempt 2, its own worktree from the same base) fixes it again AND adds the test. In
 * "broken" mode every attempt writes the plausible-but-wrong fix.
 *
 * Its stdout — the recorded result — reports what it OBSERVED of its own environment: the
 * client/project it was told it works for, and whether any canary reached it. It never runs git
 * (ADR 0073).
 */
const workerScript = (mode: WorkerMode) => `
  const fs = require('fs');
  const env = process.env;
  const wf = env.ICOS_WORKFLOW_ID || '';
  const m = /-attempt-(\\d+)$/.exec(wf);
  const attempt = m ? Number(m[1]) : 1;
  const leaked = Object.entries(env)
    .filter(([k, v]) => /CANARY|OMNIROUTE|API_KEY|CALLBACK_SECRET|^DATABASE_URL$/.test(k) || String(v).includes(${JSON.stringify(CANARY_MARK)}))
    .map(([k]) => k);
  const observed = {
    attempt,
    clientId: env.ICOS_CLIENT_ID || null,
    projectId: env.ICOS_PROJECT_ID || null,
    leaked,
    wrote: [],
  };
  if (env.ICOS_WORKSPACE_PATH) {
    fs.writeFileSync('src/x/sum.mjs', ${JSON.stringify(mode === "broken" ? SUM_BROKEN_FIX : SUM_FIXED)});
    observed.wrote.push('src/x/sum.mjs');
    if (${JSON.stringify(mode)} === 'correct' && attempt >= 2) {
      fs.writeFileSync('src/x/sum.regression.test.mjs', ${JSON.stringify(SUM_REGRESSION_TEST)});
      observed.wrote.push('src/x/sum.regression.test.mjs');
    }
  } else {
    const source = fs.readFileSync('src/x/sum.mjs', 'utf8');
    observed.finding = source.includes('let i = 1') ? 'DEFECT: sum() skips values[0] (loop starts at 1)' : 'no defect found';
  }
  process.stdout.write('P0E2E_WORKER ' + JSON.stringify(observed));
  fs.writeFileSync(env.ICOS_WORKER_STATUS_FILE, JSON.stringify({ completed: true, failed: false }));
`;

// ------------------------------------------------------------------ planner (deterministic)

const PLAN = JSON.stringify({
  version: 1,
  tasks: [
    {
      key: "audit",
      title: READER_TITLE,
      description: "Read src/x and identify the defect in sum().",
      dependsOn: [],
      riskClass: "read_only",
    },
    {
      key: "fix",
      title: WRITER_TITLE,
      description: "Fix sum() in src/x/sum.mjs inside the declared scope; tests must pass.",
      dependsOn: ["audit"],
      riskClass: "reversible",
      allowedFileScope: [SCOPE],
    },
  ],
});

// ------------------------------------------------------------------ reviewer network edge

type WriterReview = "changes-then-approve" | "approve" | "fail";
let writerReview: WriterReview = "changes-then-approve";
let writerReviewRequests = 0;
let readerReviewRequests = 0;
const reviewerAuth = new Set<string>();
let server: Server;
let reviewerUrl: string;

function reviewerReply(body: string): { status: number; content?: unknown } {
  const isWriter = body.includes(WRITER_TITLE);
  if (!isWriter) {
    readerReviewRequests += 1;
    return { status: 200, content: { decision: "APPROVE", reasons: ["audit is accurate"], confidence: 0.9 } };
  }
  writerReviewRequests += 1;
  if (writerReview === "fail") return { status: 503 };
  if (writerReview === "changes-then-approve" && writerReviewRequests === 1) {
    return {
      status: 200,
      content: {
        decision: "REQUEST_CHANGES",
        reasons: ["the fix is right but nothing prevents the defect from coming back"],
        requestedChanges: [
          { field: "src/x/sum.regression.test.mjs", reason: "add a regression test for values[0]" },
        ],
        confidence: 0.8,
      },
    };
  }
  return { status: 200, content: { decision: "APPROVE", reasons: ["defect fixed, covered by tests"], confidence: 0.9 } };
}

// ------------------------------------------------------------------ harness

let temporal: TemporalRuntime | undefined;
let tmp: string | undefined;
let repo: string;
let worktreeRoot: string;
const containers: Container[] = [];
const started: ProductionServices[] = [];

beforeAll(async () => {
  vi.stubEnv(
    "ICOS_WORKER_PROBE_COMMANDS",
    JSON.stringify({ binary: { command: process.execPath, args: ["-e", ""], timeoutMs: 10_000 } }),
  );
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      reviewerAuth.add(String(req.headers.authorization ?? ""));
      const reply = reviewerReply(body);
      if (reply.status !== 200) {
        res.writeHead(reply.status, { "content-type": "application/json" }).end('{"error":"unavailable"}');
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          model: "test/reviewer",
          choices: [{ message: { role: "assistant", content: JSON.stringify(reply.content) } }],
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  reviewerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /* Before the harness: the executable policy freezes on import (see core3). */
  Object.assign(process.env, {
    ICOS_WORKER_EXECUTABLE_ALLOWLIST: JSON.stringify([process.execPath, "node"]),
    ICOS_EXECUTION_CALLBACK_SECRET: CALLBACK_SECRET,
    ICOS_P0_E2E_CANARY: CANARY_VALUE,
  });
  temporal = await startTemporalRuntime(TASK_QUEUE);
});

afterAll(async () => {
  await temporal?.stop();
  vi.unstubAllEnvs();
  delete process.env.ICOS_P0_E2E_CANARY;
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(started.splice(0).map((s) => s.stop()));
  await Promise.all(
    containers.splice(0).map(async (c) => {
      await c.workspaceExecutionCoordinator?.shutdown();
      await c.close();
    }),
  );
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  writerReview = "changes-then-approve";
  writerReviewRequests = 0;
  readerReviewRequests = 0;
  reviewerAuth.clear();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
const targetHead = () => git(repo, "rev-parse", TARGET);

function envOverrides(mode: WorkerMode, extra: Record<string, string> = {}) {
  return {
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: reviewerUrl,
    OMNIROUTE_API_KEY: OMNIROUTE_KEY,
    ICOS_REVIEWER_MODEL: "p0e2e-reviewer-model",
    ICOS_GOAL_MAX_TOTAL_TOKENS: "5000000",
    ICOS_PLANNER_COMMAND: JSON.stringify({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(PLAN)})`, "{{prompt}}"],
    }),
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: { command: process.execPath, args: ["-e", workerScript(mode)], timeoutMs: 30_000 },
    }),
    ICOS_REPO_PATH: repo,
    ICOS_WORKER_WORKSPACE_ROOT: worktreeRoot,
    ICOS_WORKSPACE_ROOT: repo,
    TEMPORAL_TASK_QUEUE: TASK_QUEUE,
    ...(process.env.TEMPORAL_ADDRESS ? { TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS } : {}),
    ...(process.env.TEMPORAL_NAMESPACE ? { TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE } : {}),
    ICOS_EXECUTION_CALLBACK_SECRET: CALLBACK_SECRET,
    ICOS_WORKER_EXECUTABLE_ALLOWLIST: JSON.stringify([process.execPath, "node"]),
    /*
     * THE UNIT STEP RUNS THE FIXTURE'S REAL TESTS, under the real SandboxedCommandRunner.
     * Everything else is trivial because the fixture has no typecheck, lint, build or DB.
     */
    ICOS_GATE_COMMANDS: JSON.stringify({
      install: [process.execPath, "-e", ""],
      typecheck: [process.execPath, "-e", ""],
      lint: [process.execPath, "-e", ""],
      unit: [process.execPath, "--test", "src/x/*.test.mjs"],
      build: [process.execPath, "-e", ""],
      postgres: [[process.execPath, "-e", ""]],
    }),
    ...extra,
  };
}

function makeRepo(mode: WorkerMode) {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "p0-e2e-")));
  repo = path.join(tmp, "master");
  worktreeRoot = path.join(tmp, "trees");
  mkdirSync(path.join(repo, "src", "x"), { recursive: true });
  mkdirSync(worktreeRoot);
  git(repo, "init", "-q", "--initial-branch=main", ".");
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  writeFileSync(path.join(repo, "src/x/sum.mjs"), SUM_DEFECTIVE);
  writeFileSync(path.join(repo, "src/x/sum.test.mjs"), SUM_TEST);
  writeFileSync(path.join(repo, "src/x/env.test.mjs"), ENV_TEST);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base: module X with a defect");
  git(repo, "branch", TARGET);
  /* The activity and the callbacks read the deployment from process.env at call time. */
  Object.assign(process.env, envOverrides(mode));
}

/** `node --test <file>` in a given env; true when it passes. */
function nodeTestPasses(cwd: string, file: string, env: Record<string, string | undefined>): boolean {
  return (
    spawnSync(process.execPath, ["--test", file], { cwd, env: env as NodeJS.ProcessEnv, encoding: "utf8" }).status === 0
  );
}

async function seed(mode: WorkerMode): Promise<void> {
  const c = await buildPostgresContainer(DATABASE_URL, undefined, loadEnv(envOverrides(mode)));
  containers.push(c);
  await c.db!.execute(
    sql.raw(
      "TRUNCATE TABLE workforce_assignments, missions, tasks, mission_tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry, goals, goal_previews, scheduled_jobs RESTART IDENTITY CASCADE",
    ),
  );
  for (const id of WORKER_IDS) {
    await c.workerRegistration.register({
      id,
      workerKind: "agent",
      displayName: `p0e2e-${id.slice(0, 4)}`,
      capabilities: ["code_editing", "documentation", "analysis"],
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: 2,
    } as never);
    await c.workerRegistration.probe(id, { health: "healthy", availability: "available" });
  }
}
const WORKER_IDS = ["a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2"];

async function boot(mode: WorkerMode): Promise<ProductionServices> {
  const services = await startProductionServices({
    env: loadEnv(envOverrides(mode, { NODE_ENV: "production", AUTONOMY_RECOVERY_INTERVAL_MS: "250" })),
    registerSignals: false,
    signals: { onSignal: () => {}, removeSignal: () => {}, exit: () => {} },
  });
  started.push(services);
  return services;
}

const GOAL = {
  title: "Fix module X",
  objective:
    "Audit module X, identify the defect, fix it in an isolated worktree, run its tests, get it reviewed, correct if needed, prepare it for integration.",
  successCriteria: ["node --test src/x/*.test.mjs passes", "an independent review approves the fix"],
  constraints: ["only src/x may change"],
  riskLevel: "reversible" as const,
  capabilities: ["research", "code_write"],
};

async function launchGoal(c: Container, refId: string) {
  /*
   * The policy approval is only legitimate for AUTO_ALLOWED work (GoalLaunchRequest.approval):
   * asserted here with the production classifier, on the goal's own declaration.
   */
  expect(
    classifyMissionAutonomy({
      capabilities: GOAL.capabilities,
      assertedRisk: GOAL.riskLevel,
      humanApprovalPolicy: "if_risky",
    }).policyClass,
  ).toBe("AUTO_ALLOWED");
  const launched = await new CanonicalGoalLauncher(c).launch(GOAL, {
    refId,
    conversationId: `conv-${refId}`,
    turnId: `turn-${refId}`,
    approvedBy: POLICY_DECIDER,
    approval: "policy",
    clientId: CLIENT_ID,
    projectId: PROJECT_ID,
    tenantId: "default",
  });
  if (launched.status !== "launched") throw new Error(`launch ${launched.status}: ${launched.reason}`);
  return launched;
}

let diagnose: (() => Promise<string>) | undefined;
async function until<T>(what: string, probe: () => Promise<T | undefined | false | null>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) {
      const state = diagnose ? await diagnose().catch((e) => `diagnose failed: ${e}`) : "";
      throw new Error(`timed out waiting for: ${what}\n${state}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = Record<string, unknown>;
const rows = async (c: Container, query: ReturnType<typeof sql>) =>
  (await c.db!.execute(query)) as unknown as Row[];

async function writerTaskId(c: Container, missionId: string): Promise<string | undefined> {
  const tasks = await c.mission.listTasks(missionId);
  return tasks.find((t) => t.title === WRITER_TITLE)?.taskId;
}

/** Durable state, printed only when a wait times out. */
function diagnoseWith(c: Container) {
  diagnose = async () => {
    const q = async (text: string) => JSON.stringify(await c.db!.execute(sql.raw(text)), null, 0);
    return [
      `missions=${await q("select id, status from missions")}`,
      `mission_tasks=${await q("select title, status, task_id from mission_tasks")}`,
      `attempts=${await q("select task_id, attempt, state, worker_id, last_error, failure_class from dispatch_attempts order by created_at")}`,
      `results=${await q("select workflow_id, outcome, error_code, left(error_message, 300) as err, left(result, 300) as result from task_execution_results")}`,
      `reviews=${await q('select "workflowId", decision from decisions')}`,
      `qc=${await q("select workflow_id, state, action, last_error from quality_control_jobs")}`,
      `workspaces=${await q("select workflow_id, status, source_commit, released_at from icos_workspace_registry")}`,
      `jobs=${await q("select kind, state, left(last_error, 300) as err from scheduled_jobs where kind = 'start_mission'")}`,
    ].join("\n");
  };
}

/** Evidence lines; also appended to P0E2E_EVIDENCE_FILE when set (the reporter drops console on pass). */
function evidence(line: string): void {
  console.log(line);
  if (process.env.P0E2E_EVIDENCE_FILE) appendFileSync(process.env.P0E2E_EVIDENCE_FILE, `${line}\n`);
}

function parseObserved(result: unknown): { clientId: string | null; projectId: string | null; leaked: string[]; attempt: number; wrote: string[]; finding?: string } {
  const text = String(result ?? "");
  const at = text.indexOf("P0E2E_WORKER ");
  if (at < 0) throw new Error(`no worker observation in recorded result: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(at + "P0E2E_WORKER ".length));
}

function captureGateReports(c: Container): IntegrationReport[] {
  const reports: IntegrationReport[] = [];
  const original = c.integrationGate!.integrate.bind(c.integrationGate!);
  vi.spyOn(c.integrationGate!, "integrate").mockImplementation(async (...args) => {
    const report = await original(...args);
    reports.push(report);
    evidence(`P0E2E gate report: ${JSON.stringify({ decision: report.decision, unitTests: report.unitTests, fileScopeStatus: report.fileScopeStatus, secretCheck: report.secretCheck, conflictStatus: report.conflictStatus, reasons: report.reasons })}`);
    return report;
  });
  return reports;
}

// ------------------------------------------------------------------ proofs

describe("P0 AUTONOMY E2E — goal → plan → worker → tests → review → correction → integration", () => {
  it("one goal sentence integrates exactly one tested, reviewed, corrected fix — every hop durable", async () => {
    makeRepo("correct");
    const t0 = Date.now();

    /* POSITIVE CONTROLS: the fixture's tests really fail on the defect, and the env test really detects a canary. */
    expect(nodeTestPasses(repo, "src/x/sum.test.mjs", { PATH: process.env.PATH })).toBe(false);
    expect(nodeTestPasses(repo, "src/x/env.test.mjs", { PATH: process.env.PATH })).toBe(true);
    expect(nodeTestPasses(repo, "src/x/env.test.mjs", process.env)).toBe(false);

    await seed("correct");
    const before = targetHead();
    const services = await boot("correct");
    const c = services.container;
    diagnoseWith(c);
    const gateReports = captureGateReports(c);
    const applySpy = vi.spyOn(c.integrationApplier!, "apply");

    /* ---- THE ONLY INPUT ---- */
    const launched = await launchGoal(c, `p0e2e-${Date.now().toString(36)}`);

    const after = await until(
      "the runtime integrated the fix",
      async () => (targetHead() !== before ? targetHead() : undefined),
      240_000,
    );
    await until(
      "the mission settled",
      async () => (await c.mission.findById(launched.missionId))?.status === "succeeded",
    );

    /* (1) GOAL accepted, durable, scoped, converted to THIS mission. */
    const [goal] = await rows(c, sql`select status, metadata, "resultingMissionId" from goals where id = ${launched.goalId}`);
    expect(goal!.metadata).toMatchObject({ clientId: CLIENT_ID, projectId: PROJECT_ID, tenantId: "default", approvedBy: POLICY_DECIDER });
    expect(goal!.resultingMissionId).toBe(launched.missionId);
    const jobs = await rows(c, sql`select state, payload from scheduled_jobs where kind = 'start_mission'`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({ goalId: launched.goalId, clientId: CLIENT_ID, projectId: PROJECT_ID });

    /* (2) PLAN persisted: the mission's two tasks, reader then writer, writer scoped. */
    const mission = await c.mission.findById(launched.missionId);
    expect(mission?.goalId).toBe(launched.goalId);
    const missionTasks = await c.mission.listTasks(launched.missionId);
    expect(Object.fromEntries(missionTasks.map((t) => [t.title, t.status]))).toEqual({
      [READER_TITLE]: "succeeded",
      [WRITER_TITLE]: "succeeded",
    });
    const writerId = (await writerTaskId(c, launched.missionId))!;
    const readerId = missionTasks.find((t) => t.title === READER_TITLE)!.taskId;
    const writerTask = await c.tasks.getById(writerId);
    expect(writerTask?.allowedFileScope).toEqual([SCOPE]);
    expect(writerTask?.goalId).toBe(launched.goalId);

    /* (3) WORKER SELECTED: every attempt names a registered worker and carries its routing decision. */
    const attempts = await rows(
      c,
      sql`select task_id, attempt, workflow_id, worker_id, state, routing_decision from dispatch_attempts where mission_id = ${launched.missionId} order by task_id, attempt`,
    );
    const writerAttempts = attempts.filter((a) => a.task_id === writerId);
    const readerAttempts = attempts.filter((a) => a.task_id === readerId);
    expect(readerAttempts.map((a) => a.attempt)).toEqual([1]);
    /* (13) NO DUPLICATE EXECUTION: one dispatch per attempt — the original and ONE correction. */
    expect(writerAttempts.map((a) => a.attempt)).toEqual([1, 2]);
    expect(new Set(attempts.map((a) => a.workflow_id)).size).toBe(attempts.length);
    for (const a of attempts) {
      expect(WORKER_IDS).toContain(a.worker_id);
      expect(a.routing_decision, `attempt ${a.workflow_id} has no routing decision`).toBeTruthy();
    }
    const wf1 = workflowIdForAttempt(writerId, 1);
    const wf2 = workflowIdForAttempt(writerId, 2);
    expect(writerAttempts.map((a) => a.workflow_id)).toEqual([wf1, wf2]);

    /* (4) WORKSPACES: one isolated worktree per writer attempt, under the configured root, both released. */
    const workspaces = await rows(
      c,
      sql`select workflow_id, worktree_path, branch, status, base_commit, source_commit, released_at, file_scope_owns from icos_workspace_registry where task_id = ${writerId} order by created_at`,
    );
    expect(workspaces.map((w) => w.workflow_id)).toEqual([wf1, wf2]);
    for (const w of workspaces) {
      expect(String(w.worktree_path).startsWith(worktreeRoot)).toBe(true);
      expect(w.file_scope_owns).toEqual([SCOPE]);
      expect(w.base_commit).toBe(before);
      expect(w.released_at).not.toBeNull();
    }
    expect(workspaces[0]!.branch).not.toBe(workspaces[1]!.branch);
    /* The reader got none: it mutates nothing. */
    expect(await rows(c, sql`select 1 from icos_workspace_registry where task_id = ${readerId}`)).toHaveLength(0);

    /* (5) EXECUTION started + completed callbacks, durably, once per attempt. */
    const results = await rows(
      c,
      sql`select workflow_id, outcome, started_at, completed_at, result from task_execution_results where task_id in (${writerId}, ${readerId}) order by recorded_at`,
    );
    expect(results.map((r) => r.workflow_id).sort()).toEqual([`icos-task-${readerId}`, wf1, wf2].sort());
    for (const r of results) {
      expect(r.outcome).toBe("success");
      expect(r.completed_at).not.toBeNull();
    }
    const started_ = await rows(
      c,
      sql`select details from audit_entries where event_type = 'task.transitioned' and task_id = ${writerId} order by occurred_at, created_at`,
    );
    expect(started_.some((a) => JSON.stringify(a.details).includes("running"))).toBe(true);

    /* (10) WORKER ENV: told whose work it is, from the grant; NO canary reached it (by name or value). */
    for (const r of results) {
      const seen = parseObserved(r.result);
      expect(seen.clientId).toBe(CLIENT_ID);
      expect(seen.projectId).toBe(PROJECT_ID);
      expect(seen.leaked).toEqual([]);
    }
    const audit = parseObserved(results.find((r) => r.workflow_id === `icos-task-${readerId}`)!.result);
    expect(audit.finding).toMatch(/DEFECT: sum\(\) skips values\[0\]/);
    /* …while the canaries were live in the parent: the reviewer authenticated with one. */
    expect(process.env.ICOS_P0_E2E_CANARY).toBe(CANARY_VALUE);
    expect([...reviewerAuth]).toEqual([`Bearer ${OMNIROUTE_KEY}`]);

    /* (6) CODE CHANGED: ICOS materialized the commit; the integrated diff IS the reviewed correction. */
    expect(git(repo, "log", "--format=%s", `${before}..${TARGET}`).split("\n")).toEqual([
      `icos: record governed work of ${wf2}`,
    ]);
    expect(git(repo, "diff", "--name-only", `${before}..${TARGET}`).split("\n").sort()).toEqual([
      "src/x/sum.mjs",
      "src/x/sum.regression.test.mjs",
    ]);
    const diff = git(repo, "diff", `${before}..${TARGET}`, "--", "src/x/sum.mjs");
    expect(diff).toContain("-  for (let i = 1; i < values.length; i += 1) total += values[i];");
    expect(diff).toContain("+  for (let i = 0; i < values.length; i += 1) total += values[i];");
    expect(after).toBe(workspaces[1]!.source_commit);

    /* (7) TESTS RUN: the gate ran the fixture suite under the sandbox and it PASSED; and it really passes on the target. */
    expect(gateReports).toHaveLength(1);
    expect(gateReports[0]).toMatchObject({ decision: "ACCEPT", unitTests: "PASS", fileScopeStatus: "PASS", secretCheck: "PASS" });
    expect(gateReports[0]!.commitSha).toBe(after);
    const check = realpathSync(mkdtempSync(path.join(tmp!, "check-")));
    git(repo, "worktree", "add", "-q", "--detach", check, TARGET);
    expect(nodeTestPasses(check, "src/x/*.test.mjs", { PATH: process.env.PATH })).toBe(true);
    git(repo, "worktree", "remove", "--force", check);

    /* (8) REVIEW + CORRECTION: REQUEST_CHANGES on attempt 1, APPROVE on the correction, both persisted by QC. */
    const reviews = await rows(
      c,
      sql`select "workflowId", decision, "reviewerKind", "requestedChanges" from decisions where "taskId" = ${writerId} order by "createdAt"`,
    );
    expect(reviews.map((r) => [r.workflowId, r.decision, r.reviewerKind])).toEqual([
      [wf1, "REQUEST_CHANGES", "llm"],
      [wf2, "APPROVE", "llm"],
    ]);
    expect(writerReviewRequests).toBe(2);
    expect(readerReviewRequests).toBe(1);
    expect((await c.reviewDecisions.listByTaskId(readerId)).map((r) => r.decision)).toEqual(["APPROVE"]);
    const qc = await rows(c, sql`select workflow_id, state from quality_control_jobs where task_id = ${writerId} order by created_at`);
    expect(qc.map((q) => q.workflow_id)).toEqual([wf1, wf2]);
    expect(qc[1]!.state).toBe("action_applied");
    const correction = writerAttempts.find((a) => a.attempt === 2)!;
    expect(correction.workflow_id).toBe(wf2);
    const [correctionPrompt] = await rows(c, sql`select prompt from dispatch_attempts where workflow_id = ${wf2}`);
    expect(String(correctionPrompt!.prompt)).toMatch(/regression test/);

    /* (9) INTEGRATED EXACTLY ONCE: one gate, one apply, the target advanced by one commit, no orphan branch. */
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect((await applySpy.mock.results[0]!.value).status).toBe("INTEGRATED");
    expect(git(repo, "rev-list", "--count", `${before}..${TARGET}`)).toBe("1");
    /*
     * The integrated attempt's branch is reaped. The REFUSED attempt's branch is kept, by design
     * ("conserver, jamais détruire", manager.cleanup): it still names attempt 1's commit, which
     * never reached the target.
     */
    const leftBranches = git(repo, "branch", "--list", "ws/*").split("\n").map((b) => b.replace("*", "").trim()).filter(Boolean);
    expect(leftBranches).toEqual([workspaces[0]!.branch]);
    expect(git(repo, "rev-parse", String(workspaces[0]!.branch))).toBe(workspaces[0]!.source_commit);
    expect(spawnSync("git", ["merge-base", "--is-ancestor", String(workspaces[0]!.source_commit), TARGET], { cwd: repo }).status).toBe(1);

    /* (11) AUDIT TRAIL, persisted and ordered: goal → tasks → execution → settlement, with the client on every task row. */
    const trail = await rows(
      c,
      sql`select event_type, task_id, details from audit_entries
          where task_id in (${writerId}, ${readerId}) or details->>'goalId' = ${launched.goalId}
          order by occurred_at, created_at`,
    );
    const types = trail.map((a) => a.event_type as string);
    const first = (t: string) => types.indexOf(t);
    expect(first("task.created")).toBeGreaterThanOrEqual(0);
    expect(first("task.execution.completed")).toBeGreaterThan(first("task.created"));
    const writerCompletions = trail.filter((a) => a.event_type === "task.execution.completed" && a.task_id === writerId);
    expect(writerCompletions).toHaveLength(2);
    for (const a of trail.filter((x) => x.event_type === "task.created" || x.event_type === "task.execution.completed")) {
      expect(a.details).toMatchObject({ clientId: CLIENT_ID });
    }
    evidence(`P0E2E audit trail: ${JSON.stringify(trail.map((a) => [a.event_type, a.task_id === writerId ? "writer" : a.task_id === readerId ? "reader" : "-", a.details]))}`);

    /* (12) DUPLICATE DELIVERY: the completion callback re-posted, the sweeps re-run — no second commit, no second integration. */
    /* The EXACT body the activity posted, rebuilt from the durable row (byte-identical replay). */
    const [original] = await rows(
      c,
      sql`select worker_kind, actual_executor, actual_provider, actual_model, result, started_at, completed_at from task_execution_results where workflow_id = ${wf2}`,
    );
    const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
    const replayPayload = Object.fromEntries(
      Object.entries({
        taskId: writerId,
        workflowId: wf2,
        outcome: "success",
        workerKind: original!.worker_kind ?? undefined,
        actualExecutor: original!.actual_executor ?? undefined,
        actualProvider: original!.actual_provider ?? undefined,
        actualModel: original!.actual_model ?? undefined,
        result: original!.result ?? undefined,
        startedAt: iso(original!.started_at),
        completedAt: iso(original!.completed_at),
      }).filter(([, v]) => v !== undefined),
    );
    const replay = await fetch(`${temporal!.baseUrl}/api/internal/executions/completed`, {
      method: "POST",
      headers: { "content-type": "application/json", [EXECUTION_CALLBACK_HEADER]: CALLBACK_SECRET },
      body: JSON.stringify(replayPayload),
    });
    const replayBody = await replay.text();
    /*
     * An identical redelivery is a DUPLICATE, answered as one — even after the workspace was
     * integrated and reaped. (It used to re-run the trusted capture, find no live workspace,
     * convert the replay into a FAILURE and answer 400 "résultat conflictuel".)
     */
    expect(replay.status, replayBody).toBe(200);
    expect(JSON.parse(replayBody)).toMatchObject({ duplicate: true });
    const runtime = composeAutonomyRuntime(c);
    for (let i = 0; i < 3; i += 1) {
      await runtime.recovery.sweep();
      await runtime.pendingReviewGate?.sweep();
    }
    await pause(1_500);
    expect(targetHead()).toBe(after);
    expect(git(repo, "rev-list", "--count", `${before}..${TARGET}`)).toBe("1");
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(gateReports).toHaveLength(1);
    const [{ n: resultRows }] = (await rows(c, sql`select count(*)::int n from task_execution_results where workflow_id = ${wf2}`)) as Array<{ n: number }>;
    expect(resultRows).toBe(1);
    const [stillSuccess] = await rows(c, sql`select outcome from task_execution_results where workflow_id = ${wf2}`);
    expect(stillSuccess!.outcome).toBe("success");
    expect((await rows(c, sql`select 1 from dispatch_attempts where task_id = ${writerId}`))).toHaveLength(2);
    expect((await c.mission.findById(launched.missionId))?.status).toBe("succeeded");

    evidence(
      `P0E2E evidence: runtime=${Date.now() - t0}ms goal=${launched.goalId} mission=${launched.missionId} ` +
        `integrated=${after} gate=${JSON.stringify({ decision: gateReports[0]!.decision, unitTests: gateReports[0]!.unitTests })} ` +
        `replay=${replay.status} ${replayBody.slice(0, 200)}`,
    );
  }, 360_000);

  it("THE GATE REALLY RUNS THE TESTS: a reviewed-and-approved BROKEN fix is REJECTED and never integrates", async () => {
    makeRepo("broken");
    writerReview = "approve";
    await seed("broken");
    const before = targetHead();
    const services = await boot("broken");
    const c = services.container;
    diagnoseWith(c);
    const gateReports = captureGateReports(c);
    const applySpy = vi.spyOn(c.integrationApplier!, "apply");

    const launched = await launchGoal(c, `p0e2e-broken-${Date.now().toString(36)}`);
    await until("the gate judged the approved writer", async () => gateReports.length > 0, 240_000);
    const writerId = (await writerTaskId(c, launched.missionId))!;

    /* The reviewer said yes. The tests said no — and the tests win. */
    expect((await c.reviewDecisions.listByTaskId(writerId)).map((r) => r.decision)[0]).toBe("APPROVE");
    expect(gateReports[0]).toMatchObject({ decision: "REJECT", unitTests: "FAIL" });
    const [ws] = await rows(c, sql`select status from icos_workspace_registry where workflow_id = ${workflowIdForAttempt(writerId, 1)}`);
    expect(ws!.status).toBe("rejected");

    await pause(3_000);
    expect(targetHead()).toBe(before);
    const applied = await Promise.all(applySpy.mock.results.map((r) => r.value));
    expect(applied.filter((o) => o?.status === "INTEGRATED")).toEqual([]);
    expect(gateReports.every((r) => r.decision !== "ACCEPT")).toBe(true);
  }, 360_000);

  it("RESTART MID-MISSION (after dispatch, before review): a fresh process resumes and integrates exactly once", async () => {
    makeRepo("correct");
    writerReview = "fail";
    await seed("correct");
    const before = targetHead();
    const a = await boot("correct");
    diagnoseWith(a.container);
    const launched = await launchGoal(a.container, `p0e2e-restart-${Date.now().toString(36)}`);

    /* After dispatch: the writer's attempt 1 was dispatched and its execution recorded. Before review: none exists. */
    const writerId = await until("the writer task was planned", async () => writerTaskId(a.container, launched.missionId));
    const wf1 = workflowIdForAttempt(writerId, 1);
    await until("the writer executed", async () => {
      const [r] = await rows(a.container, sql`select outcome from task_execution_results where workflow_id = ${wf1}`);
      return r?.outcome;
    });
    await until("QC tried the (unavailable) reviewer", async () => writerReviewRequests > 0);
    expect(await c_reviews(a.container, writerId)).toEqual([]);
    expect(targetHead()).toBe(before);

    /*
     * KILL: the coordinator stops renewing its leases (a dead process renews nothing), the
     * scheduler stops and the container closes. Then time passes: the dead owner's lease runs
     * out — written through the SEED container, the dead one's pool being closed.
     */
    await a.container.workspaceExecutionCoordinator?.shutdown();
    await a.stop();
    started.splice(started.indexOf(a), 1);
    await containers[0]!.db!.execute(
      sql.raw("UPDATE icos_workspace_registry SET lease_expires_at = now() - interval '1 second'"),
    );

    /* A FRESH process. The reviewer is back; QC's outage cooldown elapses. */
    writerReview = "approve";
    const b = await boot("correct");
    diagnoseWith(b.container);
    const applySpy = vi.spyOn(b.container.integrationApplier!, "apply");
    await b.container.db!.execute(
      sql.raw("UPDATE quality_control_jobs SET claim_until = now() - interval '1 second' WHERE state = 'review_unavailable'"),
    );
    const after = await until(
      "the restarted runtime integrated",
      async () => {
        await b.container.db!.execute(
          sql.raw("UPDATE quality_control_jobs SET claim_until = now() - interval '1 second' WHERE state = 'review_unavailable'"),
        );
        return targetHead() !== before ? targetHead() : undefined;
      },
      240_000,
    );
    await until("the mission settled", async () => (await b.container.mission.findById(launched.missionId))?.status === "succeeded");
    await pause(2_000);

    expect(targetHead()).toBe(after);
    expect(git(repo, "rev-list", "--count", `${before}..${TARGET}`)).toBe("1");
    expect(applySpy).toHaveBeenCalledTimes(1);
    const attempts = await rows(b.container, sql`select attempt from dispatch_attempts where task_id = ${writerId} order by attempt`);
    expect(attempts.map((x) => x.attempt)).toEqual([1]);
    expect(await c_reviews(b.container, writerId)).toEqual(["APPROVE"]);
    const [ws] = await rows(b.container, sql`select source_commit, released_at from icos_workspace_registry where workflow_id = ${wf1}`);
    expect(ws!.source_commit).toBe(after);
    expect(ws!.released_at).not.toBeNull();
  }, 420_000);
});

async function c_reviews(c: Container, taskId: string): Promise<string[]> {
  return (await c.reviewDecisions.listByTaskId(taskId)).map((r) => r.decision);
}
