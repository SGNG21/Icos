import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { InMemoryReviewerService } from "@/server/review/in-memory-reviewer-service";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { recordTaskExecution } from "@/server/usecases/record-task-execution";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import type {
  TaskExecutionDispatchInput,
  TaskExecutionDispatcher,
} from "@/server/execution/ports";

/*
 * M5.4 — REAL MULTI-WORKER ORCHESTRATION against a real PostgreSQL.
 *
 * The shape under test is the smallest one that cannot be faked by a queue:
 *
 *     A ──┐
 *         ├──> C
 *     B ──┘
 *
 * A and B are independent and must run CONCURRENTLY ON DIFFERENT WORKERS; C must
 * become runnable EXACTLY ONCE, and only after both have completed canonically.
 *
 * What is deliberately NOT rebuilt here: exactly-once dispatch per task under
 * concurrent supervisors is already certified by CORE2
 * (postgres-supervisor-dispatch-race, postgres-concurrent-dispatch-recovery,
 * postgres-multiworker-concurrent). This file proves the MULTI-WORKER
 * properties layered on top: per-worker assignment, dependency gating across
 * distinct workers, and that neither leases, fencing nor a restart can advance
 * the DAG twice.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CAPABILITY = "code-generation";
const MISSION_ID = "m54-mission";
const NOW = "2026-09-27T12:00:00.000Z";

/** Canonical task id / missionTask id per DAG node. */
const NODE = {
  A: { task: "m54-task-a", missionTask: "m54-mt-a" },
  B: { task: "m54-task-b", missionTask: "m54-mt-b" },
  C: { task: "m54-task-c", missionTask: "m54-mt-c" },
} as const;

const handles: DatabaseHandle[] = [];

/** A fresh process: new handle, new repositories, new supervisor. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const durableMemory = new PostgresDurableMemory(handle.db);
  const executionResults = new PostgresTaskExecutionResultRepository(handle.db);
  const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));

  const supervisor = new SupervisorService(
    missionRepo,
    taskRepo,
    { dispatch } as TaskExecutionDispatcher,
    durableMemory,
    ledger,
    undefined,
    new CapabilityRouter(store, {
      now: () => new Date(NOW),
      healthEvidenceMaxAgeMs: 60_000,
      activeAssignments: () => ledger.listActiveWorkerAssignments(),
    }),
  );

  return {
    handle,
    store,
    ledger,
    taskRepo,
    missionRepo,
    durableMemory,
    executionResults,
    reviewDecisions: new PostgresReviewDecisionRepository(handle.db),
    dispatch,
    supervisor,
  };
}

type Process = ReturnType<typeof restart>;

function worker(id: string): WorkerRegistryEntry {
  return {
    id,
    workerKind: "agent",
    displayName: id,
    capabilities: [CAPABILITY],
    features: [],
    supportsTools: true,
    supportsStructuredOutput: true,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata: {},
    lastProbeAt: NOW,
    lastProbeOutcome: "ok",
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    updatedAt: NOW,
  };
}

/** Seeds the diamond: A and B independent roots, C depending on both. */
async function seedDiamond(handle: DatabaseHandle): Promise<void> {
  const now = new Date();
  await handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "M5.4 mission",
    objective: "Prove concurrent multi-worker orchestration",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });

  for (const [key, node] of Object.entries(NODE)) {
    await handle.db.insert(tasks).values({
      id: node.task,
      title: `Task ${key}`,
      description: `Task ${key}`,
      status: "draft",
      assignedAgentId: null,
      requiredCapabilities: [CAPABILITY],
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(missionTasks).values({
      id: node.missionTask,
      missionId: MISSION_ID,
      title: `Task ${key}`,
      description: `Task ${key}`,
      // C's edges reference MissionTask ids — the canonical DAG authority.
      dependsOn: key === "C" ? [NODE.A.missionTask, NODE.B.missionTask] : [],
      status: "draft",
      workerKind: null,
      capability: null,
      taskId: node.task,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/**
 * Completes one node through the REAL canonical completion path, review included.
 *
 * `expectAccepted: false` is used to REPLAY a completion: the usecase may
 * legitimately refuse a duplicate, and refusing is as correct as absorbing it.
 * What must hold either way is that the DAG does not advance twice.
 */
async function completeCanonically(
  p: Process,
  node: { task: string },
  expectAccepted = true,
): Promise<void> {
  const workflowId = workflowIdForAttempt(node.task, 1);
  const completedAt = new Date().toISOString();

  const recorded = await recordTaskExecution(
    {
      tasks: p.taskRepo,
      executionResults: p.executionResults,
      supervisor: p.supervisor,
      missions: p.missionRepo,
      durableMemory: p.durableMemory,
      dispatchAttempts: p.ledger,
    },
    {
      taskId: node.task,
      workflowId,
      outcome: "success",
      result: "done",
      completedAt,
    },
  );
  if (expectAccepted) {
    expect(recorded.ok).toBe(true);
  } else if (!recorded.ok) {
    return; // duplicate refused at the execution-result boundary: nothing advanced
  }

  await recordMissionTaskExecution(
    {
      executionResults: p.executionResults,
      supervisor: p.supervisor,
      missions: p.missionRepo,
      tasks: p.taskRepo,
      reviewer: new InMemoryReviewerService(),
      reviewDecisions: p.reviewDecisions,
      durableMemory: p.durableMemory,
      dispatchAttempts: p.ledger,
    },
    {
      missionId: MISSION_ID,
      taskId: node.task,
      workflowId,
      outcome: "success",
      result: "done",
      completedAt,
    },
  );
}

/** Marks a task `running`, as the worker's start callback does. Proves fencing. */
async function startWorkflow(p: Process, node: { task: string }) {
  return p.ledger.authorizeStart(node.task, workflowIdForAttempt(node.task, 1));
}

async function attemptRows(handle: DatabaseHandle) {
  return handle.db
    .select({
      missionTaskId: dispatchAttempts.missionTaskId,
      workerId: dispatchAttempts.workerId,
      attempt: dispatchAttempts.attempt,
      state: dispatchAttempts.state,
      workflowId: dispatchAttempts.workflowId,
    })
    .from(dispatchAttempts)
    .orderBy(asc(dispatchAttempts.missionTaskId), asc(dispatchAttempts.attempt));
}

async function statusOf(handle: DatabaseHandle, missionTaskId: string): Promise<string> {
  const [row] = await handle.db
    .select({ status: missionTasks.status })
    .from(missionTasks)
    .where(eq(missionTasks.id, missionTaskId));
  return row.status;
}

describe("M5.4 real multi-worker orchestration on PostgreSQL", () => {
  const seed = createDatabase(DATABASE_URL);
  handles.push(seed);

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  });

  beforeEach(async () => {
    await seed.db.execute(
      /*
       * checkpoints MUST be truncated too: recover() replays the latest
       * checkpoint, so a checkpoint left by an earlier test would make that
       * test's DAG state authoritative here. Leaving it out cost an hour.
       */
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items RESTART IDENTITY CASCADE",
      ),
    );
  });

  async function twoWorkerFleet(): Promise<Process> {
    const p = restart();
    await p.store.upsert(worker(W1));
    await p.store.upsert(worker(W2));
    await seedDiamond(p.handle);
    return p;
  }

  it("CONCURRENT_MULTIWORKER_DISPATCH: A and B go to DIFFERENT workers in one pass", async () => {
    const p = await twoWorkerFleet();

    await p.supervisor.run(MISSION_ID);

    const rows = await attemptRows(p.handle);
    expect(rows.map((r) => r.missionTaskId)).toEqual([NODE.A.missionTask, NODE.B.missionTask]);

    // The whole point: two workers, two tasks, two DISTINCT assignments.
    const [a, b] = rows;
    expect(a.workerId).not.toBe(b.workerId);
    expect([a.workerId, b.workerId].sort()).toEqual([W1, W2]);

    // C is gated: it was never offered, never dispatched.
    expect(await statusOf(p.handle, NODE.C.missionTask)).toBe("draft");
  });

  it("DEPENDENCY_GATING_PROVEN: C stays gated while only ONE parent has completed", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    await completeCanonically(p, NODE.A);
    expect(await statusOf(p.handle, NODE.A.missionTask)).toBe("succeeded");

    await p.supervisor.run(MISSION_ID);

    // B is still in flight: one completed parent must unlock nothing.
    expect(await statusOf(p.handle, NODE.C.missionTask)).toBe("draft");
    const cAttempts = (await attemptRows(p.handle)).filter(
      (r) => r.missionTaskId === NODE.C.missionTask,
    );
    expect(cAttempts).toHaveLength(0);
  });

  it("EXACTLY_ONCE_DAG_ADVANCEMENT_PROVEN: C is dispatched once after BOTH parents complete", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    await completeCanonically(p, NODE.A);
    await completeCanonically(p, NODE.B);

    // Both parents' attempts left the non-terminal states, so their slots freed.
    const parents = (await attemptRows(p.handle)).filter(
      (r) => r.missionTaskId !== NODE.C.missionTask,
    );
    expect(parents.map((r) => r.state)).toEqual(["completed", "completed"]);

    /*
     * Note: the canonical completion path CONTINUES the mission itself
     * (recordMissionTaskExecution -> continueMission), so C is already dispatched
     * by the time the second parent completes. Running the supervisor three more
     * times on top of that is the real test: unlock is a DERIVATION of persisted
     * state, not an event that can fire twice.
     */
    await p.supervisor.run(MISSION_ID);
    await p.supervisor.run(MISSION_ID);
    await p.supervisor.run(MISSION_ID);

    const cAttempts = (await attemptRows(p.handle)).filter(
      (r) => r.missionTaskId === NODE.C.missionTask,
    );
    expect(cAttempts).toHaveLength(1);
    expect(cAttempts[0].workerId).not.toBeNull();
  });

  it("EXACTLY_ONCE under CONCURRENT supervisors: three processes unlock C once", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);
    await completeCanonically(p, NODE.A);
    await completeCanonically(p, NODE.B);

    const others = [restart(), restart()];
    await Promise.all(
      [p, ...others].map((proc) => proc.supervisor.run(MISSION_ID).catch(() => undefined)),
    );

    const cAttempts = (await attemptRows(p.handle)).filter(
      (r) => r.missionTaskId === NODE.C.missionTask,
    );
    expect(cAttempts).toHaveLength(1);
  });

  it("DURABLE_WORKER_ASSIGNMENT: a different process reads which worker holds which task", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);
    await p.handle.close();

    const cold = restart();
    const rows = await attemptRows(cold.handle);

    expect(rows.map((r) => r.workerId).sort()).toEqual([W1, W2]);
    // Attribution answers "who is doing A?" durably, which defect 12 could not.
    expect(rows.find((r) => r.missionTaskId === NODE.A.missionTask)?.workerId).toBeTruthy();
  });

  it("ATOMIC_CLAIMS: only one process owns the initial dispatch of a given task", async () => {
    const p = await twoWorkerFleet();
    const other = restart();

    const results = await Promise.allSettled([
      p.supervisor.run(MISSION_ID),
      other.supervisor.run(MISSION_ID),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);

    const rows = await attemptRows(p.handle);
    // One attempt per task, never two, whichever process won.
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.missionTaskId)).size).toBe(2);
    expect(p.dispatch.mock.calls.length + other.dispatch.mock.calls.length).toBe(2);
  });

  it("LEASES: exactly one recoverer may hold a live lease on a prepared attempt", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    // run() acknowledges its dispatches, so force one back to `prepared` to model
    // a process that died between persisting the intent and acknowledging it.
    const rows = await attemptRows(p.handle);
    await p.handle.db
      .update(dispatchAttempts)
      .set({ state: "prepared" })
      .where(eq(dispatchAttempts.missionTaskId, rows[0].missionTaskId));

    const [orphan] = await p.ledger.listPrepared(MISSION_ID);
    expect(orphan).toBeDefined();

    const first = await p.ledger.claimPrepared(orphan.id, "owner-1", 60_000);
    const second = await p.ledger.claimPrepared(orphan.id, "owner-2", 60_000);

    expect(first).toBe(true);
    expect(second).toBe(false); // the live lease excludes everyone else
  });

  it("an EXPIRED lease may be reacquired, so a dead recoverer cannot strand work", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);
    const rows = await attemptRows(p.handle);
    await p.handle.db
      .update(dispatchAttempts)
      .set({ state: "prepared" })
      .where(eq(dispatchAttempts.missionTaskId, rows[0].missionTaskId));
    const [orphan] = await p.ledger.listPrepared(MISSION_ID);

    expect(await p.ledger.claimPrepared(orphan.id, "owner-dead", 60_000)).toBe(true);

    // That recoverer dies. Age its lease rather than asking for an invalid one:
    // claimPrepared rejects a non-positive lease by contract.
    await p.handle.db
      .update(dispatchAttempts)
      .set({ claimUntil: new Date(Date.now() - 60_000) })
      .where(eq(dispatchAttempts.id, orphan.id));

    expect(await p.ledger.claimPrepared(orphan.id, "owner-live", 60_000)).toBe(true);
  });

  it("FENCING: a start callback for an unknown or mismatched workflow is refused", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    const authorized = await startWorkflow(p, NODE.A);
    expect(authorized.ok).toBe(true);

    // Same task, a workflow id that was never the authoritative one.
    const forged = await p.ledger.authorizeStart(NODE.A.task, "icos-task-forged-1");
    expect(forged.ok).toBe(false);
    expect(forged.ok === false && forged.reason).toBe("workflow_not_found");

    // A real workflow id, but claimed for the WRONG task.
    const crossed = await p.ledger.authorizeStart(
      NODE.B.task,
      workflowIdForAttempt(NODE.A.task, 1),
    );
    expect(crossed.ok).toBe(false);
  });

  it("FENCING is idempotent: a duplicate start callback reports alreadyRunning, not a second start", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    const first = await startWorkflow(p, NODE.A);
    const duplicate = await startWorkflow(p, NODE.A);

    expect(first.ok && first.alreadyRunning).toBe(false);
    expect(duplicate.ok && duplicate.alreadyRunning).toBe(true);
  });

  it("NO_STALE_MUTATION: an attempt number below the authoritative one is refused", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    // Attempt 2 becomes authoritative...
    await p.ledger.prepare({
      missionId: MISSION_ID,
      missionTaskId: NODE.A.missionTask,
      taskId: NODE.A.task,
      attempt: 2,
      workflowId: workflowIdForAttempt(NODE.A.task, 2),
      prompt: "retry",
      workerId: W1,
    });

    // ...so a late writer still holding attempt 1 cannot reassert itself.
    await expect(
      p.ledger.prepare({
        missionId: MISSION_ID,
        missionTaskId: NODE.A.missionTask,
        taskId: NODE.A.task,
        attempt: 1,
        workflowId: workflowIdForAttempt(NODE.A.task, 1),
        prompt: "stale",
        workerId: W1,
      }),
    ).rejects.toThrow(/DISPATCH_ATTEMPT_STALE/);
  });

  it("NO_DUPLICATE_INTEGRATION: replaying the same completion does not re-advance the DAG", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);

    await completeCanonically(p, NODE.A);
    await completeCanonically(p, NODE.B);
    await p.supervisor.run(MISSION_ID);

    const before = await attemptRows(p.handle);

    // The same callbacks arrive again — a retrying transport, a replayed queue.
    // Either they are absorbed idempotently or refused; neither may advance the DAG.
    await completeCanonically(p, NODE.A, false).catch(() => undefined);
    await completeCanonically(p, NODE.B, false).catch(() => undefined);
    await p.supervisor.run(MISSION_ID);

    const after = await attemptRows(p.handle);
    expect(after).toEqual(before);
    expect(after.filter((r) => r.missionTaskId === NODE.C.missionTask)).toHaveLength(1);
  });

  it("PROCESS_RESTART_PROVEN: a restart mid-execution resumes without duplicating work", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);
    const inFlight = await attemptRows(p.handle);
    expect(inFlight).toHaveLength(2);

    // The process dies with A and B in flight on two different workers.
    await p.handle.close();

    const cold = restart();
    await cold.supervisor.recover(MISSION_ID);
    await cold.supervisor.run(MISSION_ID).catch(() => undefined);

    // No new attempt, no re-dispatch: the durable ledger already owns both.
    expect(await attemptRows(cold.handle)).toEqual(inFlight);

    // And the surviving state still completes the DAG correctly.
    await completeCanonically(cold, NODE.A);
    await completeCanonically(cold, NODE.B);
    await cold.supervisor.run(MISSION_ID);

    const final = await attemptRows(cold.handle);
    expect(final.filter((r) => r.missionTaskId === NODE.C.missionTask)).toHaveLength(1);
  });

  it("a PREPARED attempt orphaned by a crash is replayed with the SAME workflow id", async () => {
    const p = await twoWorkerFleet();
    await p.supervisor.run(MISSION_ID);
    const rows = await attemptRows(p.handle);
    const orphanWorkflowId = rows[0].workflowId;
    await p.handle.db
      .update(dispatchAttempts)
      .set({ state: "prepared" })
      .where(eq(dispatchAttempts.workflowId, orphanWorkflowId));
    await p.handle.close();

    const cold = restart();
    await cold.supervisor.reconcilePreparedDispatches(MISSION_ID);

    // Replayed under the same deterministic identity, so Temporal deduplicates.
    expect(cold.dispatch.mock.calls.map((c) => c[0].workflowId)).toEqual([orphanWorkflowId]);
    const after = await attemptRows(cold.handle);
    expect(after).toHaveLength(2);
    expect(after.find((r) => r.workflowId === orphanWorkflowId)?.state).toBe("dispatched");
  });

  it("SAFE_PARALLELISM_PROVEN: the full diamond completes with A and B on separate workers", async () => {
    const p = await twoWorkerFleet();

    await p.supervisor.run(MISSION_ID);
    const parents = await attemptRows(p.handle);
    expect(new Set(parents.map((r) => r.workerId)).size).toBe(2);

    await completeCanonically(p, NODE.A);
    await completeCanonically(p, NODE.B);
    await p.supervisor.run(MISSION_ID);
    await completeCanonically(p, NODE.C);

    expect(await statusOf(p.handle, NODE.A.missionTask)).toBe("succeeded");
    expect(await statusOf(p.handle, NODE.B.missionTask)).toBe("succeeded");
    expect(await statusOf(p.handle, NODE.C.missionTask)).toBe("succeeded");

    const all = await attemptRows(p.handle);
    expect(all).toHaveLength(3); // exactly one attempt per node
  });
});
