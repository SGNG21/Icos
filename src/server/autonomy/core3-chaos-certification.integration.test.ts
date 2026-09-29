import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresQualityControlRepository } from "@/server/repositories/postgres/quality-control-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import type { ReviewerPort } from "@/server/review/ports";
import { QualityControlService } from "@/server/usecases/quality-control-service";
import { ExternalWorkerTaskExecutionDispatcher } from "@/server/execution/external-worker-task-execution-dispatcher";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { CommandWorkerExecutor } from "@/server/workers/execution/command-worker-executor";
import {
  createWorkerExecResolver,
  parseWorkerExecCommands,
} from "@/server/workers/execution/exec-command-config";
import { WorkerExecutor } from "@/server/workers/execution/worker-executor";
import { runNonInteractive } from "@/server/workers/process/run-process";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";

/*
 * CORE3 CHAOS CERTIFICATION.
 *
 * Every mechanism below is already proven in isolation (M4 routing, M5 orchestration and
 * capacity, M6.1/M6.2 real probing, M6.3 external execution, M7 abandoned-execution
 * recovery, M7.1 routed QC retries). This is the COMPOSITION, and compositions are where
 * the surprises live: M6.3's classifier defect passed every unit test and only appeared
 * when a real worker produced two signals at once.
 *
 * WHAT IS REAL HERE: real PostgreSQL, real OS processes, real git worktrees and commits,
 * the real `DeterministicReviewer` hard rules, the real routing/capacity/QC/recovery
 * services, and restarts that are new connections with new service instances.
 *
 * WHAT IS STUBBED, and why: the LLM half of the reviewer (a network model — the rule
 * that matters, UNKNOWN_EFFECT -> RETRY, is the REAL deterministic one) and the probe
 * sweep's observation that the hung worker is unhealthy (certified separately in M6.2;
 * running it here would add noise, not proof).
 *
 * THE FAULT IS REAL: a worker process hangs and is KILLED by its own execution timeout.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "chaos-mission";
const MISSION_TASK_ID = "chaos-mt-1";
const TASK_ID = "chaos-task-1";
const WORKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];
let root: string;
let repo: string;

const git = async (cwd: string, args: string[]) => {
  const result = await runNonInteractive({ command: "git", args, cwd, timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/**
 * THE WORKER. One command for the `node` runtime, as a deployment would configure it.
 *
 * Attempt 1 HANGS — the fault. Its own execution timeout kills it, which is a real
 * process death, not a simulated one. Any later attempt does the work for real: writes a
 * file, commits it, and reports a structured verdict.
 */
const CHAOS_WORKER = `
  if (process.env.ICOS_ATTEMPT === '1') {
    setTimeout(() => {}, 60000);
  } else {
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    fs.writeFileSync('proof.txt', 'done by attempt ' + process.env.ICOS_ATTEMPT + '\\n');
    execFileSync('git', ['add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'chaos attempt ' + process.env.ICOS_ATTEMPT], { stdio: 'ignore' });
    process.stdout.write(process.env.ICOS_RESULT_SENTINEL_START + JSON.stringify({
      status: 'succeeded',
      summary: 'wrote proof.txt on attempt ' + process.env.ICOS_ATTEMPT,
      testsRun: ['proof-check'],
    }) + process.env.ICOS_RESULT_SENTINEL_END);
  }
`;

/** A restart: new connection, new services, zero shared memory. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const executionResults = new PostgresTaskExecutionResultRepository(handle.db);
  const durableMemory = new PostgresDurableMemory(handle.db);
  const reviewDecisions = new PostgresReviewDecisionRepository(handle.db);
  const qualityJobs = new PostgresQualityControlRepository(handle.db);

  const router = new CapabilityRouter(store, {
    activeAssignments: () => ledger.listActiveWorkerAssignments(),
    /* Composed as the container composes it (decision 0054). */
    computeHistory: (since) => ledger.listRecentComputeOutcomes(since),
    executionLeaseMs: 20 * 60_000,
    defaultBudgetMs: () => 1_500,
  });

  const supervisor = new SupervisorService(
    missionRepo,
    taskRepo,
    { dispatch: vi.fn(async () => ({ workflowId: "x" })) } as unknown as TaskExecutionDispatcher,
    durableMemory,
    ledger,
    undefined,
    router,
  );

  /* The REAL external worker execution boundary (0038), on the real `node` runtime. */
  const executor = new WorkerExecutor({
    node: new CommandWorkerExecutor(
      createWorkerExecResolver(
        parseWorkerExecCommands(
          JSON.stringify({
            node: {
              command: process.execPath,
              args: ["-e", CHAOS_WORKER],
              /* Short on purpose: the hang must be killed, and quickly. */
              timeoutMs: 1_500,
            },
          }),
        ),
      ),
    ),
  });

  const dispatcher = new ExternalWorkerTaskExecutionDispatcher({
    executor,
    workers: store,
    dispatchAttempts: ledger,
    executionResults,
    missions: missionRepo,
    tasks: taskRepo,
    supervisor,
    durableMemory,
    repoPath: repo,
    workspaceRoot: root,
  });

  /* Real deterministic hard rules; only the LLM half is stubbed. */
  const llm: ReviewerPort = {
    review: async () => ({ decision: "APPROVE", reasons: ["work verified by evidence"] }),
  };
  const reviewer = new ReviewerServiceImpl(llm, new DeterministicReviewer(), reviewDecisions);

  const qualityControl = new QualityControlService({
    missions: missionRepo,
    tasks: taskRepo,
    executionResults,
    reviewer,
    reviewDecisions,
    dispatchAttempts: ledger,
    qualityJobs,
    /* M7.1 — QC routes its retries through the one canonical router. */
    capabilityRouter: router,
    dispatchPrepared: async (prepared) => {
      const result = await dispatcher.dispatch({
        missionId: prepared.missionId,
        taskId: prepared.taskId,
        prompt: prepared.prompt,
        workflowId: prepared.workflowId,
        workerKind: prepared.workerKind,
        capability: prepared.capability,
      });
      if (result.workflowId !== prepared.workflowId) {
        throw new Error("DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH");
      }
      await ledger.markDispatched(prepared.id);
    },
  });

  return {
    handle,
    taskRepo,
    missionRepo,
    ledger,
    store,
    executionResults,
    dispatcher,
    qualityControl,
    router,
    registration: new WorkerRegistrationService(store),
  };
}

const seed = restart();

async function seedWorld() {
  const now = new Date();
  await seed.handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "CORE3 chaos",
    objective: "Survive a worker dying mid-execution",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(tasks).values({
    id: TASK_ID,
    title: "Write proof.txt",
    description: "Write proof.txt and commit it",
    status: "running",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "Write proof.txt",
    description: "Write proof.txt and commit it",
    dependsOn: [],
    status: "running",
    workerKind: null,
    capability: CAPABILITY,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });

  for (const id of [WORKER_A, WORKER_B]) {
    await seed.registration.register({
      id,
      workerKind: "agent",
      displayName: id,
      capabilities: [CAPABILITY],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
      maxConcurrency: 1,
    });
    /* Dated health evidence: routing refuses a worker it has never seen work (0033). */
    await seed.registration.probe(id, { health: "healthy", availability: "available" });
  }
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
  if (root) await rm(root, { recursive: true, force: true });
});

describe("CORE3 CHAOS CERTIFICATION", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, recovery_units, quality_control_jobs RESTART IDENTITY CASCADE",
      ),
    );

    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "icos-chaos-"));
    repo = join(root, "canonical");
    await git(root, ["init", "--initial-branch=main", "canonical"]);
    await git(repo, ["config", "user.email", "test@icos.local"]);
    await git(repo, ["config", "user.name", "ICOS Test"]);
    await writeFile(join(repo, "README.md"), "canonical\n", "utf8");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-m", "base"]);

    await seedWorld();
  });

  it("A WORKER DIES MID-EXECUTION AND THE MISSION TASK STILL COMPLETES, EXACTLY ONCE", async () => {
    const canonicalHead = await git(repo, ["rev-parse", "HEAD"]);

    /* ---- 1. ROUTE and dispatch attempt 1, through the real router. ---- */
    const boot = restart();
    const routed = await boot.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(routed.decision).toBe("ROUTED");
    const firstWorker = routed.worker!.id;

    const attempt1 = await boot.ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: MISSION_TASK_ID,
      taskId: TASK_ID,
      attempt: 1,
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      prompt: "Write proof.txt and commit it",
      workerKind: "agent",
      workerId: firstWorker,
      capability: CAPABILITY,
    });
    await boot.ledger.markDispatched(attempt1.attempt.id);

    /* ---- 2. THE FAULT: the worker hangs and is really killed. ---- */
    await boot.dispatcher.dispatch({
      missionId: MISSION_ID,
      taskId: TASK_ID,
      prompt: "Write proof.txt and commit it",
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      capability: CAPABILITY,
    });

    const afterFault = restart();
    const failed = await afterFault.ledger.getByWorkflowId(workflowIdForAttempt(TASK_ID, 1));
    expect(failed?.state).toBe("failed");
    /* Killed for its budget (decision 0054); the effect is still UNKNOWN — never "the task failed". */
    expect(failed?.failureClass).toBe("EXECUTION_TIMEOUT");
    expect(
      (await afterFault.executionResults.getByWorkflowId(workflowIdForAttempt(TASK_ID, 1)))?.error
        ?.code,
    ).toBe("UNKNOWN_EFFECT");
    /* The slot came back the moment the attempt was settled. */
    expect(await afterFault.ledger.listActiveWorkerAssignments()).toEqual([]);

    /*
     * ---- 3. The probe sweep observes that the hung worker is not healthy. ----
     * Stands in for M6.2's certified autonomous sweep; running it here would add noise,
     * not proof. Without it the router would legitimately choose the same worker again.
     */
    await afterFault.registration.probe(firstWorker, {
      health: "unhealthy",
      availability: "unavailable",
    });

    /* ---- 4. RECOVERY drives the retry — the production path, not the test. ---- */
    /*
     * SUCCESSIVE SWEEP TICKS, because the recovery sweeper is PERIODIC in production.
     * One tick cannot both create the retry and review its result: `recoverUnregistered`
     * runs at the start of a pass, so attempt 2's result does not exist yet when the
     * pass that CREATES attempt 2 begins. The second tick reviews it. Modelling that
     * honestly is the point — a single all-in-one call would prove a system that does
     * not exist.
     *
     * Nothing here decides anything: the test only advances the clock.
     */
    for (let tick = 0; tick < 3; tick += 1) {
      await restart().qualityControl.recover(MISSION_ID);
      if ((await restart().taskRepo.getById(TASK_ID))?.status === "succeeded") break;
    }

    /* ---- 5. THE ASSERTIONS, all on durable rows read from a NEW connection. ---- */
    const verify = restart();

    const attempts = await verify.handle.db.execute(
      sql.raw(
        `select attempt, state, worker_id, failure_class from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}' order by attempt`,
      ),
    );
    const rows = attempts as unknown as Array<{
      attempt: number;
      state: string;
      worker_id: string;
      failure_class: string | null;
    }>;

    /* EXACTLY TWO attempts: the fault and its retry. No third, no fork. */
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      attempt: 1,
      state: "failed",
      failure_class: "EXECUTION_TIMEOUT",
    });

    /* REASSIGNED: the retry went to the OTHER worker, chosen by the real router. */
    const otherWorker = firstWorker === WORKER_A ? WORKER_B : WORKER_A;
    expect(rows[1]!.attempt).toBe(2);
    expect(rows[1]!.worker_id).toBe(otherWorker);

    /*
     * DECISION 0054 — WHY the retry went elsewhere is durable, on the retry's own row, read
     * from a NEW connection: the ledger's EXECUTION_TIMEOUT on attempt 1 penalised the model
     * that timed out. Both executions carry their observed duration. Attempt 1's row is the
     * fault exactly as it happened — the retry added a row and changed none.
     */
    const evidence = (await verify.handle.db.execute(
      sql.raw(
        `select attempt, routing_decision, execution_duration_ms from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}' order by attempt`,
      ),
    )) as unknown as Array<{
      attempt: number;
      routing_decision: Record<string, any> | null;
      execution_duration_ms: number | null;
    }>;
    const retryDecision = evidence[1]!.routing_decision!;
    expect(retryDecision).toMatchObject({
      kind: "ROUTING_DECISION",
      role: "writer",
      previousFailure: { attempt: 1, failureClass: "EXECUTION_TIMEOUT" },
      selected: { workerId: otherWorker },
    });
    const timedOut = (retryDecision.candidateSet as Array<Record<string, any>>).find(
      (c) => c.workerId === firstWorker,
    )!;
    /* The dead worker lost its health evidence, and its timeout is in the history it carries. */
    expect(timedOut.selectable).toBe(false);
    expect(timedOut.excludedBecause).toContain("HEALTH_NOT_HEALTHY");
    expect(timedOut.history).toMatchObject({
      executions: 1,
      timeouts: 1,
      infraFailures: 1,
      reviewed: 0,
    });
    expect(evidence[0]!.execution_duration_ms).toBeGreaterThanOrEqual(1_400);
    expect(evidence[1]!.execution_duration_ms).not.toBeNull();

    /* EXACTLY ONE SUCCESS among exactly two results. */
    const results = (await verify.handle.db.execute(
      sql.raw(
        `select workflow_id, outcome from task_execution_results where task_id = '${TASK_ID}' order by recorded_at`,
      ),
    )) as unknown as Array<{ workflow_id: string; outcome: string }>;
    expect(results).toHaveLength(2);
    expect(results.filter((r) => r.outcome === "success")).toHaveLength(1);
    expect(results.find((r) => r.outcome === "success")?.workflow_id).toBe(
      workflowIdForAttempt(TASK_ID, 2),
    );

    /* THE TASK COMPLETED — reviewed, not self-declared. */
    expect((await verify.taskRepo.getById(TASK_ID))?.status).toBe("succeeded");

    /*
     * THE WORK IS REAL, AND IT LANDED EXACTLY ONCE.
     *
     * TWO branches exist — one per attempt — because a writer gets its own branch and
     * `dispose()` keeps it deliberately: the branch IS the evidence, including for the
     * attempt that died. Only ONE of them carries the work. (That both survive is
     * defect 19: nothing integrates or reaps worker branches yet.)
     */
    const branches = (await git(repo, ["branch", "--list", "icos/worker/*"]))
      .split("\n")
      .map((b) => b.trim())
      .filter(Boolean);
    expect(branches).toHaveLength(2);

    const withWork: string[] = [];
    for (const branch of branches) {
      const files = await git(repo, ["show", "--name-only", "--format=", branch]);
      if (files.trim() === "proof.txt") withWork.push(branch);
    }
    /* The killed attempt committed nothing; the retry committed once. */
    expect(withWork).toHaveLength(1);

    /* AND THE CANONICAL CHECKOUT NEVER MOVED. */
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(canonicalHead);
    expect(await git(repo, ["status", "--porcelain"])).toBe("");
  }, 60_000);

  it("A TOTAL FLEET OUTAGE IS BACK-PRESSURE: the task is not failed, and no retry is spent", async () => {
    const boot = restart();
    const attempt1 = await boot.ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: MISSION_TASK_ID,
      taskId: TASK_ID,
      attempt: 1,
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      prompt: "Write proof.txt and commit it",
      workerKind: "agent",
      workerId: WORKER_A,
      capability: CAPABILITY,
    });
    await boot.ledger.markDispatched(attempt1.attempt.id);
    await boot.dispatcher.dispatch({
      missionId: MISSION_ID,
      taskId: TASK_ID,
      prompt: "Write proof.txt and commit it",
      workflowId: workflowIdForAttempt(TASK_ID, 1),
      capability: CAPABILITY,
    });

    /* The whole fleet goes down between the failure and the retry. */
    const outage = restart();
    for (const id of [WORKER_A, WORKER_B]) {
      await outage.registration.probe(id, { health: "unhealthy", availability: "unavailable" });
    }

    await expect(outage.qualityControl.recover(MISSION_ID)).rejects.toThrow(
      /QUALITY_CONTROL_NO_ELIGIBLE_WORKER/,
    );

    const verify = restart();
    /* No attempt 2: a fleet outage must not spend a bounded retry budget. */
    expect(await verify.ledger.getByWorkflowId(workflowIdForAttempt(TASK_ID, 2))).toBeNull();
    /* And the task is still alive, waiting for capacity — not failed. */
    expect((await verify.taskRepo.getById(TASK_ID))?.status).not.toBe("failed");
  }, 60_000);
});
