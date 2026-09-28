import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { CommandWorkerExecutor } from "@/server/workers/execution/command-worker-executor";
import {
  createWorkerExecResolver,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import { parseWorkerFailureConfig } from "@/server/workers/execution/failure-classifier";
import { WorkerExecutor } from "@/server/workers/execution/worker-executor";
import { runNonInteractive } from "@/server/workers/process/run-process";
import { ExternalWorkerTaskExecutionDispatcher } from "./external-worker-task-execution-dispatcher";
import type { TaskExecutionDispatcher } from "./ports";

/*
 * M6.3 END TO END, through the CANONICAL dispatcher boundary, on real PostgreSQL.
 *
 * The unit suites prove each piece; this proves they compose through the ONE seam the
 * supervisor already uses (`TaskExecutionDispatcher`). That matters more than it
 * sounds: requirement 9 is that there is no SECOND execution path, and the only way
 * to show it is to drive a real external process, a real isolated worktree and a real
 * attempt ledger through the existing interface.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "e2e-mission";
const MISSION_TASK_ID = "e2e-mt-1";
const TASK_ID = "e2e-task-1";
const WORKER_ID = "77777777-7777-4777-8777-777777777777";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];
let root: string;
let repo: string;

const git = async (cwd: string, args: string[]) => {
  const result = await runNonInteractive({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A restart: new connection, new services, zero shared memory. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const durableMemory = new PostgresDurableMemory(handle.db);
  const executionResults = new PostgresTaskExecutionResultRepository(handle.db);

  return {
    handle,
    taskRepo,
    missionRepo,
    ledger,
    store,
    durableMemory,
    executionResults,
    registration: new WorkerRegistrationService(store),
    supervisor: new SupervisorService(
      missionRepo,
      taskRepo,
      { dispatch: vi.fn(async () => ({ workflowId: "x" })) } as unknown as TaskExecutionDispatcher,
      durableMemory,
      ledger,
    ),
  };
}

const seed = restart();

/**
 * Builds the dispatcher under test with a REAL node worker running `script`.
 *
 * `node` here is this process's own runtime, not a provider: the point is that a real
 * OS process is launched, observed and classified.
 */
function dispatcherWith(
  ctx: ReturnType<typeof restart>,
  script: string,
  over: { owner?: string; leaseMs?: number; failureConfig?: string } = {},
) {
  const executor = new WorkerExecutor({
    node: new CommandWorkerExecutor(
      createWorkerExecResolver(
        parseWorkerExecCommands(
          JSON.stringify({
            node: { command: process.execPath, args: ["-e", script], timeoutMs: 30_000 },
          }),
        ),
      ),
      { failureConfig: parseWorkerFailureConfig(over.failureConfig) },
    ),
  });

  return new ExternalWorkerTaskExecutionDispatcher({
    executor,
    workers: ctx.store,
    dispatchAttempts: ctx.ledger,
    executionResults: ctx.executionResults,
    missions: ctx.missionRepo,
    tasks: ctx.taskRepo,
    supervisor: ctx.supervisor,
    durableMemory: ctx.durableMemory,
    repoPath: repo,
    workspaceRoot: root,
    owner: over.owner,
    leaseMs: over.leaseMs,
  });
}

async function seedWorld() {
  const now = new Date();
  await seed.handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "E2E",
    objective: "Prove external worker execution",
    status: "running",
    goalId: "e2e-goal",
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(tasks).values({
    id: TASK_ID,
    title: "Write a file",
    description: "do work",
    /* `running` so the proof's transition to succeeded/failed is a legal one. */
    status: "running",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "Write a file",
    description: "do work",
    dependsOn: [],
    /* `running`: this attempt is already dispatched, which is where M6.3 begins. */
    status: "running",
    workerKind: null,
    capability: CAPABILITY,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });

  await seed.registration.register({
    id: WORKER_ID,
    workerKind: "agent",
    displayName: "external",
    capabilities: [CAPABILITY],
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    maxConcurrency: 1,
    metadata: { model: "test-model", provider: "test-provider", account: "acct-1" },
  });
}

/** Creates the durable attempt this dispatch will run. */
async function makeAttempt(attempt: number): Promise<{ id: string; workflowId: string }> {
  const workflowId = `e2e-wf-${attempt}`;
  const id = `e2e-att-${attempt}`;
  const now = new Date();
  await seed.handle.db.insert(dispatchAttempts).values({
    id,
    missionId: MISSION_ID,
    missionTaskId: MISSION_TASK_ID,
    taskId: TASK_ID,
    attempt,
    workflowId,
    prompt: "Write proof.txt and commit it",
    workerKind: "agent",
    workerId: WORKER_ID,
    capability: CAPABILITY,
    state: "dispatched",
    createdAt: now,
    updatedAt: now,
  });
  return { id, workflowId };
}

/* A worker that really writes a file and really commits it in its own worktree. */
const COMMITTING_WORKER = `
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const token = process.env.ICOS_RESUME_TOKEN || 'fresh';
  fs.writeFileSync('proof.txt', 'task=' + process.env.ICOS_TASK_ID + ' resume=' + token + '\\n');
  execFileSync('git', ['add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'worker commit ' + token], { stdio: 'ignore' });
  process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
    status: 'succeeded',
    summary: 'wrote proof.txt (resume=' + token + ')',
    testsRun: ['proof-check'],
    resumeToken: 'session-' + process.env.ICOS_ATTEMPT,
  }) + process.env.ICOS_RESULT_SENTINEL_END);
`;

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("M6.3 external worker dispatch end to end (PostgreSQL)", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items RESTART IDENTITY CASCADE",
      ),
    );

    /* A fresh canonical repository per test, so isolation claims are unambiguous. */
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "icos-e2e-"));
    repo = join(root, "canonical");
    await git(root, ["init", "--initial-branch=main", "canonical"]);
    await git(repo, ["config", "user.email", "test@icos.local"]);
    await git(repo, ["config", "user.name", "ICOS Test"]);
    await writeFile(join(repo, "README.md"), "canonical\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);

    await seedWorld();
  });

  it("A REAL WORKER RUNS, COMMITS IN ISOLATION, and its evidence is persisted", async () => {
    const { workflowId } = await makeAttempt(1);
    const ctx = restart();
    const canonicalHeadBefore = await git(repo, ["rev-parse", "HEAD"]);

    await dispatcherWith(ctx, COMMITTING_WORKER).dispatch({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      workflowId,
      prompt: "Write proof.txt and commit it",
      capability: CAPABILITY,
    });

    /* The business proof is durable and readable from a NEW connection. */
    const record = await restart().executionResults.getByWorkflowId(workflowId);
    expect(record?.outcome).toBe("success");
    expect(record?.result).toContain("wrote proof.txt");

    /* COMMIT EVIDENCE: a real commit hash, from git, not from the worker's claim. */
    const branchArtifact = record?.artifacts?.find((a) => a.type === "git-branch");
    expect(branchArtifact?.path).toContain("icos/worker");
    const meta = branchArtifact?.metadata as {
      commitHash: string;
      changedFiles: string[];
      commits: string[];
    };
    expect(meta.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(meta.changedFiles).toContain("proof.txt");
    expect(meta.commits).toHaveLength(1);

    /* The commit is real: reachable by branch from the canonical repository. */
    expect(await git(repo, ["rev-parse", branchArtifact!.path!])).toBe(meta.commitHash);

    /*
     * WRITER ISOLATION under the full pipeline: the worker committed real work and
     * the integration checkout neither moved nor got dirty.
     */
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(canonicalHeadBefore);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");

    /* IDENTITY: all six axes recorded, so a failure can be attributed correctly. */
    const identity = record?.evidence?.find((e) => e.type === "worker-identity");
    expect(identity?.metadata).toMatchObject({
      workerId: WORKER_ID,
      runtime: "node",
      model: "test-model",
      provider: "test-provider",
      account: "acct-1",
    });

    /* stdout/stderr/exit captured as evidence, bounded. */
    const processEvidence = record?.evidence?.find((e) => e.type === "worker-process");
    expect(processEvidence?.metadata).toMatchObject({ exitCode: 0, timedOut: false });

    /* Tests the worker says it ran are carried as evidence, not silently dropped. */
    expect(record?.evidence?.find((e) => e.type === "tests-run")?.metadata).toMatchObject({
      tests: ["proof-check"],
    });

    /*
     * The task advanced to REVIEW, not to succeeded. Worker output does not
     * self-integrate: the mission task stays non-terminal until a review decides
     * (see record-task-execution). An executor that could mark its own work
     * succeeded would be able to land unreviewed changes.
     */
    expect((await restart().taskRepo.getById(TASK_ID))?.status).toBe("review_pending");
  });

  it("SESSION EXHAUSTION is classified, persisted, and leaves RESUME state behind", async () => {
    const { id, workflowId } = await makeAttempt(1);
    const ctx = restart();

    /* A worker that fails the way a real agent runs out of context. */
    const exhausted = `
      process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
        status: 'failed',
        summary: 'ran out of room',
        unresolved: ['step B not done'],
        resumeToken: 'session-abc',
        handoff: { done: ['step A'] },
      }) + process.env.ICOS_RESULT_SENTINEL_END);
      process.stderr.write('context window exceeded');
      process.exit(1);
    `;

    await dispatcherWith(ctx, exhausted, {
      failureConfig: JSON.stringify({
        patterns: { SESSION_EXHAUSTED: ["context window exceeded"] },
      }),
    }).dispatch({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      workflowId,
      prompt: "work",
      capability: CAPABILITY,
    });

    const after = restart();

    /* The FINE class lives on the attempt: it is the retry decision's input. */
    const attempt = await after.ledger.getByWorkflowId(workflowId);
    expect(attempt?.state).toBe("failed");
    expect(attempt?.failureClass).toBe("SESSION_EXHAUSTED");
    expect(attempt?.resumeToken).toBe("session-abc");
    expect(attempt?.handoff).toEqual({ done: ["step A"] });

    /* The COARSE class lives on the business record: nothing ran, task untouched. */
    const record = await after.executionResults.getByWorkflowId(workflowId);
    expect(record?.outcome).toBe("failure");
    expect(record?.error?.code).toBe("WORKER_UNAVAILABLE");

    /* Unresolved work is preserved as evidence rather than discarded. */
    expect(record?.evidence?.find((e) => e.type === "unresolved-issues")?.metadata).toMatchObject({
      unresolved: ["step B not done"],
    });

    /* And the next attempt has something to continue. */
    expect(await after.ledger.latestResumableState(MISSION_TASK_ID)).toMatchObject({
      attempt: 1,
      resumeToken: "session-abc",
    });
    /* The lease is released so recovery is not blocked by the dead runner. */
    expect(await after.ledger.holdsExecutionLease(id, "runner-1")).toBe(false);
  });

  it("RETRYABLE RESUME: the SECOND attempt receives the FIRST attempt's session", async () => {
    /* Attempt 1 fails, leaving resume state. */
    const first = await makeAttempt(1);
    await restart().ledger.recordExecutionFailure(first.id, {
      failureClass: "SESSION_EXHAUSTED",
      message: "out of context",
      resumeToken: "session-from-attempt-1",
      handoff: { done: ["scaffold"] },
    });

    /* Attempt 2 is a NEW row for the SAME mission task — the existing ledger model. */
    const second = await makeAttempt(2);
    const ctx = restart();

    await dispatcherWith(ctx, COMMITTING_WORKER).dispatch({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      workflowId: second.workflowId,
      prompt: "continue",
      capability: CAPABILITY,
    });

    /*
     * THE PROOF that it is a continuation and not a restart: the worker echoed the
     * inherited token into its own commit, so the resume state crossed the process
     * boundary into a real external run.
     */
    const record = await restart().executionResults.getByWorkflowId(second.workflowId);
    expect(record?.outcome).toBe("success");
    expect(record?.result).toContain("resume=session-from-attempt-1");

    const meta = record?.artifacts?.find((a) => a.type === "git-branch")?.metadata as {
      commitHash: string;
    };
    /* Same logical task, so it is attempt 2's branch — not a re-run of attempt 1. */
    expect(meta.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("NO DUPLICATE INTEGRATION: a second runner holding no lease does NOT execute or record", async () => {
    const { id, workflowId } = await makeAttempt(1);
    const holder = restart();

    /* Runner A is running this attempt right now. */
    expect(await holder.ledger.acquireExecutionLease(id, "runner-A", 600_000)).toBe(true);

    const ctx = restart();
    await dispatcherWith(ctx, COMMITTING_WORKER, { owner: "runner-B" }).dispatch({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      workflowId,
      prompt: "work",
      capability: CAPABILITY,
    });

    /*
     * Runner B must have done NOTHING: no result recorded, no branch created, the
     * attempt untouched. Otherwise one logical attempt produces two results.
     */
    const after = restart();
    expect(await after.executionResults.getByWorkflowId(workflowId)).toBeNull();
    expect((await after.ledger.getByWorkflowId(workflowId))?.state).toBe("dispatched");
    expect(await git(repo, ["branch", "--list", "icos/worker/*"])).toBe("");
  });

  it("A RUN THAT LOSES ITS LEASE MID-FLIGHT IS FENCED, even when it SUCCEEDED", async () => {
    const { id, workflowId } = await makeAttempt(1);
    const ctx = restart();

    /*
     * The dangerous case. The worker really did the work, but while it ran another
     * runner took the attempt over. Reporting success now would integrate the same
     * logical task twice.
     */
    const stealer = restart();
    const thief = `
      ${COMMITTING_WORKER}
    `;
    const dispatcher = dispatcherWith(ctx, thief, { owner: "runner-A" });

    /* Expire runner-A's lease and hand it to runner-B while the worker is running. */
    const original = ctx.ledger.holdsExecutionLease.bind(ctx.ledger);
    vi.spyOn(ctx.ledger, "holdsExecutionLease").mockImplementation(async (attemptId, owner) => {
      await seed.handle.db
        .update(dispatchAttempts)
        .set({ executionLeaseOwner: "runner-B", executionLeaseUntil: new Date(Date.now() + 60_000) })
        .where(eq(dispatchAttempts.id, id));
      return original(attemptId, owner);
    });

    await dispatcher.dispatch({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      workflowId,
      prompt: "work",
      capability: CAPABILITY,
    });

    const after = restart();
    const attempt = await after.ledger.getByWorkflowId(workflowId);

    /* Fenced: recorded as LEASE_EXPIRED, NOT as the success the worker achieved. */
    expect(attempt?.failureClass).toBe("LEASE_EXPIRED");

    const record = await after.executionResults.getByWorkflowId(workflowId);
    expect(record?.outcome).toBe("failure");
    /* UNKNOWN_EFFECT, because work MAY have landed — the fail-closed answer. */
    expect(record?.error?.code).toBe("UNKNOWN_EFFECT");

    /* The work itself is not lost: the branch is still there as evidence. */
    expect(await git(repo, ["branch", "--list", "icos/worker/*"])).not.toBe("");
    void stealer;
  });

  it("A DEREGISTERED WORKER fails closed instead of guessing a runtime", async () => {
    const { workflowId } = await makeAttempt(1);
    await seed.handle.db.execute(sql.raw(`DELETE FROM workers WHERE id = '${WORKER_ID}'`));
    const ctx = restart();

    await dispatcherWith(ctx, COMMITTING_WORKER).dispatch({
      taskId: TASK_ID,
      missionId: MISSION_ID,
      workflowId,
      prompt: "work",
      capability: CAPABILITY,
    });

    const after = restart();
    /* Retryable, so re-routing can pick a live worker rather than failing the task. */
    expect((await after.ledger.getByWorkflowId(workflowId))?.failureClass).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect((await after.executionResults.getByWorkflowId(workflowId))?.error?.code).toBe(
      "WORKER_UNAVAILABLE",
    );
  });

  it("A DISPATCH WITH NO WORKFLOW ID IS REFUSED: there is no logical attempt to fence", async () => {
    const ctx = restart();
    await expect(
      dispatcherWith(ctx, COMMITTING_WORKER).dispatch({
        taskId: TASK_ID,
        missionId: MISSION_ID,
        prompt: "work",
      }),
    ).rejects.toThrow(/EXTERNAL_WORKER_DISPATCH_REQUIRES_WORKFLOW_ID/);
  });
});
