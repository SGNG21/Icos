import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { spawn } from "node:child_process";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { PostgresRecoveryScanner } from "./postgres-recovery-scanner";
import { PostgresRecoveryUnitRepository } from "./postgres-recovery-unit-repository";
import { createRecoveryActions } from "./recovery-actions";
import { RuntimeRecoverySweeper } from "./runtime-recovery-sweeper";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";

/*
 * M7 — AUTOMATIC RECOVERY OF A DEAD EXTERNAL WORKER, on real PostgreSQL.
 *
 * DEFECT 17, stated precisely: a worker that died MID-EXECUTION was detected (its probe
 * evidence expired, so routing stopped choosing it) but the task it was holding was
 * never reassigned. The dispatch attempt stayed `dispatched` for ever and, because
 * durable load is DERIVED by counting non-terminal attempts, that worker's capacity slot
 * was consumed permanently. Detection without reassignment.
 *
 * M6.3 built the lease that makes the death observable. M7 is the caller that acts on it.
 *
 * THE CHAOS HERE IS REAL: an actual OS process is spawned and SIGKILLed, and the lease
 * expires by WALL CLOCK, not by an UPDATE that pretends it did.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "m7-mission";
const MISSION_TASK_ID = "m7-mt-1";
const TASK_ID = "m7-task-1";
const WORKER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];

/** A restart: new connection, new services, zero shared memory. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const executionResults = new PostgresTaskExecutionResultRepository(handle.db);

  const sweeper = (graceMs = 0) =>
    new RuntimeRecoverySweeper(
      new PostgresRecoveryScanner(handle.db),
      new PostgresRecoveryUnitRepository(handle.db),
      createRecoveryActions({
        wakeup: { wake: vi.fn(async () => null) },
        supervisor: { reconcilePreparedDispatches: vi.fn(async () => undefined) } as never,
        dispatcher: { dispatch: vi.fn(async () => ({ workflowId: "x" })) } as TaskExecutionDispatcher,
        missions: missionRepo,
        executionResults,
        dispatchAttempts: ledger,
      }),
      /* NO WorkflowProbe: an external process worker has no Temporal workflow to ask about. */
      undefined,
      {
        abandonedExecutionGraceMs: graceMs,
        /* Keep the OTHER scans quiet so this proves the new path, not a neighbour. */
        graceMs: 3_600_000,
        orphanAfterMs: 3_600_000,
      },
    );

  return { handle, taskRepo, missionRepo, ledger, store, executionResults, sweeper,
    registration: new WorkerRegistrationService(store) };
}

const seed = restart();

async function seedWorld() {
  const now = new Date();
  await seed.handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "M7",
    objective: "Prove worker-death recovery",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(tasks).values({
    id: TASK_ID,
    title: "T",
    description: "do work",
    status: "running",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "T",
    description: "do work",
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
      /* One slot each, so a leaked slot means the worker is unusable. */
      maxConcurrency: 1,
    });
  }
}

async function makeAttempt(
  attempt: number,
  workerId: string,
  state = "dispatched",
): Promise<{ id: string; workflowId: string }> {
  const id = `m7-att-${attempt}`;
  const workflowId = `m7-wf-${attempt}`;
  const now = new Date();
  await seed.handle.db.insert(dispatchAttempts).values({
    id,
    missionId: MISSION_ID,
    missionTaskId: MISSION_TASK_ID,
    taskId: TASK_ID,
    attempt,
    workflowId,
    prompt: "do work",
    workerKind: "agent",
    workerId,
    capability: CAPABILITY,
    state,
    createdAt: now,
    updatedAt: now,
    dispatchedAt: now,
  });
  return { id, workflowId };
}

/**
 * Kills a REAL worker process mid-execution.
 *
 * A genuine spawn and a genuine SIGKILL: the runner is gone and can never release its
 * lease, which is exactly the state defect 17 describes. Simulating it with an UPDATE
 * would prove the query, not the scenario.
 */
async function killWorkerMidExecution(): Promise<{ pid: number; killed: boolean }> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
  const pid = child.pid!;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
  return { pid, killed: child.killed };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("M7 abandoned external worker execution recovery (PostgreSQL)", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, recovery_units RESTART IDENTITY CASCADE",
      ),
    );
    await seedWorld();
  });

  it("DEFECT 17 — a worker killed mid-execution has its task RECLAIMED and its capacity FREED", async () => {
    const { id, workflowId } = await makeAttempt(1, WORKER_A);
    const runner = restart();

    /* Runner A takes the attempt with a SHORT lease and then really dies. */
    expect(await runner.ledger.acquireExecutionLease(id, "runner-A", 250)).toBe(true);
    const death = await killWorkerMidExecution();
    expect(death.killed).toBe(true);

    /* Before recovery: the slot is consumed and the worker is unusable. */
    expect(await runner.ledger.listActiveWorkerAssignments()).toEqual([WORKER_A]);

    /* The lease lapses by WALL CLOCK — nothing pretends for it. */
    await sleep(400);

    const result = await restart().sweeper(0).sweep();
    expect(result.discovered).toBe(1);
    expect(result.succeeded).toBe(1);

    const after = restart();
    const attempt = await after.ledger.getByWorkflowId(workflowId);

    /* The attempt is TERMINAL and classified. */
    expect(attempt?.state).toBe("failed");
    expect(attempt?.failureClass).toBe("LEASE_EXPIRED");

    /*
     * THE FIX. Durable load is derived from non-terminal attempts, so settling the
     * attempt is what returns the slot. This assertion is defect 17.
     */
    expect(await after.ledger.listActiveWorkerAssignments()).toEqual([]);

    /* And the loss is recorded fail-closed: we do not know what the dead worker wrote. */
    const record = await after.executionResults.getByWorkflowId(workflowId);
    expect(record?.outcome).toBe("failure");
    expect(record?.error?.code).toBe("UNKNOWN_EFFECT");
  });

  it("REASSIGNMENT: after recovery the SAME logical task runs on ANOTHER worker, exactly once", async () => {
    const first = await makeAttempt(1, WORKER_A);
    const runner = restart();
    await runner.ledger.acquireExecutionLease(first.id, "runner-A", 250);
    await killWorkerMidExecution();
    await sleep(400);
    await restart().sweeper(0).sweep();

    /*
     * The freed capacity is what lets routing choose a worker at all. Attempt 2 is a NEW
     * row for the SAME missionTaskId — the existing ledger model — and `prepare` enforces
     * the target worker's concurrency INSIDE its transaction, so this succeeding is proof
     * that the slot really came back.
     */
    const ctx = restart();
    const prepared = await ctx.ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: MISSION_TASK_ID,
      taskId: TASK_ID,
      attempt: 2,
      workflowId: "m7-wf-2",
      prompt: "do work",
      workerKind: "agent",
      workerId: WORKER_B,
      capability: CAPABILITY,
    });

    expect(prepared.acquired).toBe(true);
    expect(prepared.attempt.workerId).toBe(WORKER_B);

    /* EXACTLY ONCE: one live attempt for this task, on the new worker only. */
    const active = await restart().ledger.listNonTerminalByMissionTaskId(MISSION_TASK_ID);
    expect(active).toHaveLength(1);
    expect(active[0]?.attempt).toBe(2);
    expect(await restart().ledger.listActiveWorkerAssignments()).toEqual([WORKER_B]);
  });

  it("A LIVE RUNNER IS NEVER RECLAIMED out from under itself", async () => {
    const { id, workflowId } = await makeAttempt(1, WORKER_A);
    const runner = restart();
    /* A long lease: this runner is working, and renewal is what proves liveness. */
    expect(await runner.ledger.acquireExecutionLease(id, "runner-alive", 600_000)).toBe(true);

    const result = await restart().sweeper(0).sweep();

    expect(result.discovered).toBe(0);
    expect((await restart().ledger.getByWorkflowId(workflowId))?.state).toBe("dispatched");
  });

  it("THE GRACE PERIOD protects a runner that is only just late", async () => {
    const { id } = await makeAttempt(1, WORKER_A);
    await restart().ledger.acquireExecutionLease(id, "runner-A", 250);
    await sleep(400);

    /* Expired, but inside the grace window: a long commit must not be reclaimed. */
    expect(await restart().sweeper(60_000).sweep()).toMatchObject({ discovered: 0 });
    /* Past the grace window, it is genuinely abandoned. */
    expect(await restart().sweeper(0).sweep()).toMatchObject({ discovered: 1 });
  });

  it("AN ATTEMPT NOBODY EVER LEASED is NOT reclaimed by this path", async () => {
    /*
     * No lease means no external worker ever picked it up, so there is no death to infer;
     * it belongs to the prepared/orphan scans.
     *
     * MUTATION NOTE: removing the scanner's two `is not null` guards does NOT fail this
     * test, because a NULL `execution_lease_until` already fails the age comparison under
     * SQL's three-valued logic. The behaviour is real and worth pinning; the guards
     * themselves are legibility, and this test does not prove them. Said plainly here so
     * nobody later reads it as stronger evidence than it is.
     */
    await makeAttempt(1, WORKER_A);
    expect(await restart().sweeper(0).sweep()).toMatchObject({ discovered: 0 });
  });

  it("A LATE REAL RESULT WINS: an attempt whose work landed is never reclaimed", async () => {
    const { id, workflowId } = await makeAttempt(1, WORKER_A);
    const ctx = restart();
    await ctx.ledger.acquireExecutionLease(id, "runner-A", 250);
    await sleep(400);

    /* The worker finished after all, just slowly. */
    await ctx.executionResults.record({
      taskId: TASK_ID,
      workflowId,
      outcome: "success",
      workerKind: "agent",
      result: "did the work",
      completedAt: new Date().toISOString(),
    });

    /* Overwriting a real success with UNKNOWN_EFFECT would destroy a genuine result. */
    expect(await restart().sweeper(0).sweep()).toMatchObject({ discovered: 0 });
    expect((await restart().executionResults.getByWorkflowId(workflowId))?.outcome).toBe("success");
  });

  it("RECOVERY IS IDEMPOTENT ACROSS PROCESSES: two sweepers reclaim ONE attempt once", async () => {
    const { id, workflowId } = await makeAttempt(1, WORKER_A);
    await restart().ledger.acquireExecutionLease(id, "runner-A", 250);
    await sleep(400);

    /*
     * Two independent processes race. The durable recovery-unit claim serialises them, so
     * one logical abandonment produces one settlement — not two results for one attempt.
     */
    const [a, b] = await Promise.all([
      restart().sweeper(0).sweep(),
      restart().sweeper(0).sweep(),
    ]);

    expect(a.succeeded + b.succeeded).toBe(1);
    expect((await restart().ledger.getByWorkflowId(workflowId))?.failureClass).toBe("LEASE_EXPIRED");
  });

  it("A TERMINAL MISSION IS LEFT ALONE", async () => {
    const { id } = await makeAttempt(1, WORKER_A);
    await restart().ledger.acquireExecutionLease(id, "runner-A", 250);
    await sleep(400);
    await seed.handle.db.execute(
      sql.raw(`UPDATE missions SET status = 'cancelled' WHERE id = '${MISSION_ID}'`),
    );

    /* Reviving work for a cancelled mission would resurrect abandoned intent. */
    expect(await restart().sweeper(0).sweep()).toMatchObject({ discovered: 0 });
  });
});
