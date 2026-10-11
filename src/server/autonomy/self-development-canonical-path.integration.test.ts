import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createImprovementCandidate } from "@/core/autonomy/improvement-backlog";
import { loadEnv } from "@/config/env";
import { buildPostgresContainer, type Container } from "@/server/container";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { composeAutonomyRuntime } from "@/server/system/production-services";

/**
 * SELF_DEVELOPMENT_GATE_PATH_DIVERGENCE — closed by decision 0052.
 *
 * Self-development used to review, repair, gate, apply and complete its writer tasks itself.
 * These proofs drive `runtime.selfDevelopment.advance()` — the entry the self-build E2E uses —
 * and assert that everything after planning happens through the ONE canonical authority:
 * QC reviews (and corrects), the supervisor governs every attempt, the pending-review pass
 * gates and applies, and integrated settlement (0049) completes the task.
 *
 * Test doubles: the planner and worker COMMANDS (deterministic scripts instead of an agent)
 * and the OmniRoute network edge for the reviewer. Nothing writes a review, a status, a
 * wake-up or calls the gate.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const TARGET = "integration/phase-7";
const WRITE_SCOPE = "docs/sd/**";

// ------------------------------------------------------------------ OmniRoute network edge

type ReviewerMode = "approve" | "changes-once" | "block";
let reviewerMode: ReviewerMode = "approve";
let reviewerRequests = 0;
let server: Server;
let reviewerUrl: string;

beforeAll(async () => {
  vi.stubEnv(
    "ICOS_WORKER_PROBE_COMMANDS",
    JSON.stringify({ binary: { command: process.execPath, args: ["-e", ""], timeoutMs: 10_000 } }),
  );
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      reviewerRequests += 1;
      const mode =
        reviewerMode === "changes-once"
          ? reviewerRequests === 2
            ? "changes"
            : "approve"
          : reviewerMode;
      const content =
        mode === "approve"
          ? { decision: "APPROVE", reasons: ["inside its declared scope"], confidence: 0.9 }
          : mode === "block"
            ? { decision: "BLOCK", reasons: ["unsafe change"], confidence: 0.9 }
            : {
                decision: "REQUEST_CHANGES",
                reasons: ["the note needs a heading"],
                requestedChanges: [{ field: "note.md", reason: "missing heading" }],
                confidence: 0.8,
              };
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(content) } }],
          /* Fidélité du faux : un fournisseur réel rapporte sa consommation (voir ci-dessus). */
          usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
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

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
const targetHead = () => git(repo, "rev-parse", TARGET);

function makeRepo() {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "sd-canonical-")));
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

/** A reader, then a writer that depends on it: the plan shape that used to block (DEFECT 36). */
const plan = (writerScope: string) =>
  JSON.stringify({
    version: 1,
    tasks: [
      {
        key: "inspect",
        title: "Inspect the docs",
        description: "Read docs/ and report",
        dependsOn: [],
        riskClass: "read_only",
      },
      {
        key: "write",
        title: "Write the note",
        description: "Write the note inside the declared scope and commit it",
        dependsOn: ["inspect"],
        riskClass: "reversible",
        allowedFileScope: [writerScope],
      },
    ],
  });

/* Writes only inside a governed worktree; a read-only task runs elsewhere and changes nothing. */
const workerScript = () => `
  const fs = require('fs');
  if (process.cwd().startsWith(${JSON.stringify(worktreeRoot)})) {
    fs.mkdirSync('docs/sd', { recursive: true });
    fs.writeFileSync('docs/sd/note.md', '# Note\\n' + process.env.ICOS_WORKFLOW_ID + '\\n');
    /* NO git: ICOS materializes what the worker leaves (ADR 0073). */
  }
  process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
    status: 'succeeded', summary: 'done', testsRun: ['unit'],
  }) + process.env.ICOS_RESULT_SENTINEL_END);
`;

async function container(writerScope = WRITE_SCOPE): Promise<Container> {
  const env = loadEnv({
    NODE_ENV: "test",
    PERSISTENCE: "postgres",
    DATABASE_URL,
    OMNIROUTE_BASE_URL: reviewerUrl,
    OMNIROUTE_API_KEY: "sd-key",
    ICOS_REVIEWER_MODEL: "sd-model",
    /*
     * La relecture est du TRAVAIL DE MISSION et passe par le compteur de dépense : sans
     * plafond configuré, le budget du goal n'est pas applicable et la réservation REFUSE
     * avant même d'émettre — le relecteur n'est alors jamais appelé. C'est le comportement
     * voulu, et c'est ce qu'un vrai déploiement doit configurer ; le test le configure donc
     * comme la production, au lieu de dépendre d'une relecture gratuite.
     */
    ICOS_GOAL_MAX_TOTAL_TOKENS: "5000000",
    ICOS_PLANNER_COMMAND: JSON.stringify({
      command: process.execPath,
      args: ["-e", `process.stdout.write(${JSON.stringify(plan(writerScope))})`, "{{prompt}}"],
    }),
    ICOS_WORKER_EXEC_COMMANDS: JSON.stringify({
      binary: { command: process.execPath, args: ["-e", workerScript()], timeoutMs: 30_000 },
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
  });
  const built = await buildPostgresContainer(DATABASE_URL, undefined, env);
  containers.push(built);
  await built.db!.execute(
    sql.raw(
      "TRUNCATE TABLE workforce_assignments, missions, tasks, mission_tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs, recovery_units, icos_workspace_registry, goals RESTART IDENTITY CASCADE",
    ),
  );
  for (const id of [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]) {
    await built.workerRegistration.register({
      id,
      workerKind: "agent",
      displayName: `sd-${id.slice(0, 4)}`,
      capabilities: ["code_editing", "documentation", "analysis"],
      runtime: "binary",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: 2,
    } as never);
    await built.workerRegistration.probe(id, { health: "healthy", availability: "available" });
  }
  return built;
}

async function start(c: Container) {
  const runtime = composeAutonomyRuntime(c);
  const candidate = createImprovementCandidate({
    title: "Document the settlement rule",
    description: "Add a short note under docs/sd describing when a dependency is satisfied.",
    rationale: "The rule is non-obvious.",
    category: "maintainability",
    targetComponent: "docs",
    priority: "medium",
    proposedBy: "icos-self-development",
  });
  await runtime.backlog.add(candidate);
  const gateSpy = vi.spyOn(c.integrationGate!, "integrate");
  const applySpy = vi.spyOn(c.integrationApplier!, "apply");
  const settleSpy = vi.spyOn(c.qualityControlJobs, "settleAccepted");
  return { runtime, candidate, gateSpy, applySpy, settleSpy };
}

const missionTaskStatuses = async (c: Container, missionId: string) =>
  Object.fromEntries((await c.mission.listTasks(missionId)).map((t) => [t.title, t.status]));

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    containers.splice(0).map(async (c) => {
      await c.workspaceExecutionCoordinator?.shutdown();
      await c.close();
    }),
  );
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  reviewerMode = "approve";
  reviewerRequests = 0;
});

// ------------------------------------------------------------------ proofs

describe("0052 — self-development is ordinary governed work", () => {
  it("SELF_DEV_CANONICAL_E2E: reader → writer plan integrates through review → sweep → gate → settlement", async () => {
    makeRepo();
    const c = await container();
    const before = targetHead();
    const { runtime, candidate, gateSpy, applySpy, settleSpy } = await start(c);

    const outcome = await runtime.selfDevelopment.advance();
    if ("status" in outcome) throw new Error(outcome.reason);

    expect(outcome.finalState, outcome.reason).toBe("integrated");
    expect(await missionTaskStatuses(c, outcome.missionId)).toEqual({
      "Inspect the docs": "succeeded",
      "Write the note": "succeeded",
    });

    /* One gate + one apply, driven by the workspace coordinator's pending-review pass. */
    expect(gateSpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect((await applySpy.mock.results[0]!.value).status).toBe("INTEGRATED");
    /* Completion came from integrated settlement (0049), not from the coordinator. */
    expect(settleSpy).toHaveBeenCalled();

    /* The canonical branch advanced exactly once, with the writer's work. */
    expect(git(repo, "log", "--oneline", `${before}..${TARGET}`).split("\n")).toHaveLength(1);
    expect(git(repo, "diff", "--name-only", `${before}..${TARGET}`)).toBe("docs/sd/note.md");

    /* Reviews were persisted by QC for BOTH tasks — the reader too. */
    const tasks = await c.mission.listTasks(outcome.missionId);
    for (const t of tasks) {
      expect((await c.reviewDecisions.listByTaskId(t.taskId)).map((r) => r.decision)).toEqual([
        "APPROVE",
      ]);
    }
    expect((await runtime.backlog.get(candidate.id))?.status).toBe("approved");
    expect(await c.durableMemory.getPatterns({ limit: 50 })).not.toHaveLength(0);
  }, 360_000);

  it("REQUEST_CHANGES on the writer: QC corrects, the correction is governed, integrated, settled", async () => {
    makeRepo();
    const c = await container();
    const before = targetHead();
    /* Review #1 is the reader (approve); review #2 — the writer's first — asks for changes. */
    reviewerMode = "changes-once";
    const { runtime, applySpy } = await start(c);

    const outcome = await runtime.selfDevelopment.advance();
    if ("status" in outcome) throw new Error(outcome.reason);

    expect(outcome.finalState, outcome.reason).toBe("integrated");
    expect(outcome.repairAttemptsUsed).toBe(1);
    expect((await c.reviewDecisions.listByTaskId(outcome.taskId)).map((r) => r.decision)).toEqual([
      "REQUEST_CHANGES",
      "APPROVE",
    ]);
    /* What integrated is the CORRECTION (attempt 2), not the refused attempt. */
    expect(outcome.workflowId).toBe(workflowIdForAttempt(outcome.taskId, 2));
    expect(
      await c.dispatchAttempts.getByWorkflowId(workflowIdForAttempt(outcome.taskId, 2)),
    ).not.toBeNull();
    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(git(repo, "log", "--oneline", `${before}..${TARGET}`).split("\n")).toHaveLength(1);
  }, 480_000);

  it("a review BLOCK: nothing integrates and the candidate is rejected", async () => {
    makeRepo();
    const c = await container();
    const before = targetHead();
    reviewerMode = "block";
    const { runtime, candidate, applySpy } = await start(c);

    const outcome = await runtime.selfDevelopment.advance();
    if ("status" in outcome) throw new Error(outcome.reason);

    expect(outcome.finalState).toBe("human_decision_required");
    expect(applySpy).not.toHaveBeenCalled();
    expect(targetHead()).toBe(before);
    expect((await runtime.backlog.get(candidate.id))?.status).toBe("rejected");
  }, 360_000);

  it("POLICY DENIED on a protected scope: the mission is stopped and never integrates", async () => {
    makeRepo();
    const c = await container("src/core/contracts/task.ts");
    const before = targetHead();
    const { runtime, candidate, applySpy } = await start(c);

    const outcome = await runtime.selfDevelopment.advance();
    if ("status" in outcome) throw new Error(outcome.reason);
    expect(outcome.finalState).toBe("policy_denied");
    expect((await runtime.backlog.get(candidate.id))?.status).toBe("rejected");

    /* Ignition already started the mission. The production passes must not land it anyway. */
    for (let i = 0; i < 5; i += 1) {
      await runtime.recovery.sweep();
      await runtime.pendingReviewGate?.sweep();
      await new Promise((r) => setTimeout(r, 7_000));
    }
    expect(applySpy).not.toHaveBeenCalled();
    expect(targetHead()).toBe(before);
    expect(Object.values(await missionTaskStatuses(c, outcome.missionId))).not.toContain(
      "succeeded",
    );
  }, 360_000);
});
