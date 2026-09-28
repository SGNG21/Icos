import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresQualityControlRepository } from "./quality-control-repository";
import { PostgresWorkerRegistryStore } from "./worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import type { ReviewDecisionRecord } from "@/core/contracts/review";

/*
 * M7.1 — A QC RETRY CANNOT OVERSUBSCRIBE A WORKER.
 *
 * The PostgreSQL retry path INSERTs the next attempt directly, bypassing `prepare()`.
 * Before M7.1 it bypassed the capacity guard with it, so a retry could hand work to a
 * worker already at its declared limit — something `prepare()` would have refused.
 *
 * WHY THIS NEEDS ITS OWN TEST: the router never *chooses* a full worker, so the guard
 * only fires on the race it exists for — the routing decision is made OUTSIDE the
 * transaction and is therefore advisory, and capacity can be consumed between the
 * decision and the INSERT. The chaos certification cannot reach it (its retry always
 * finds a free slot), which is exactly why removing the guard left that suite green.
 * "Wired" is not "proven".
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "qcc-mission";
const MISSION_TASK_ID = "qcc-mt-1";
const TASK_ID = "qcc-task-1";
/** A second task, so the "own attempts do not compete" exemption cannot apply. */
const OTHER_MISSION_TASK_ID = "qcc-mt-2";
const OTHER_TASK_ID = "qcc-task-2";
const WORKER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];

function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  return {
    handle,
    store,
    registration: new WorkerRegistrationService(store),
    qualityJobs: new PostgresQualityControlRepository(handle.db),
  };
}

const seed = restart();

async function insertTask(taskId: string, missionTaskId: string) {
  const now = new Date();
  await seed.handle.db.insert(tasks).values({
    id: taskId,
    title: taskId,
    description: "work",
    status: "running",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: missionTaskId,
    missionId: MISSION_ID,
    title: taskId,
    description: "work",
    dependsOn: [],
    status: "running",
    workerKind: null,
    capability: CAPABILITY,
    taskId,
    createdAt: now,
    updatedAt: now,
  });
}

async function insertAttempt(
  id: string,
  missionTaskId: string,
  taskId: string,
  attempt: number,
  state: string,
  workerId: string | null,
) {
  const now = new Date();
  await seed.handle.db.insert(dispatchAttempts).values({
    id,
    missionId: MISSION_ID,
    missionTaskId,
    taskId,
    attempt,
    workflowId: workflowIdForAttempt(taskId, attempt),
    prompt: "work",
    workerKind: "agent",
    workerId,
    capability: CAPABILITY,
    state,
    createdAt: now,
    updatedAt: now,
  });
}

const review = (workflowId: string, taskId: string): ReviewDecisionRecord => ({
  id: `review-${taskId}`,
  taskId,
  workflowId,
  missionId: MISSION_ID,
  decision: "RETRY",
  reviewerKind: "deterministic",
  severity: "warning",
  reasons: ["worker died"],
  humanOverridden: false,
  createdAt: new Date().toISOString(),
});

/** Drives a QC job to `decision_ready` so `applyAction` can be reached. */
async function readyJob(ctx: ReturnType<typeof restart>, workflowId: string) {
  const resultRows = (await seed.handle.db.execute(
    sql.raw(`select id from task_execution_results where workflow_id = '${workflowId}'`),
  )) as unknown as Array<{ id: string }>;

  await ctx.qualityJobs.register({
    missionId: MISSION_ID,
    missionTaskId: MISSION_TASK_ID,
    taskId: TASK_ID,
    workflowId,
    executionResultId: resultRows[0]!.id,
    executionAttempt: 1,
  });

  const owner = "qcc-owner";
  const job = await ctx.qualityJobs.claimNext(MISSION_ID, owner, 60_000);
  if (!job) throw new Error("no job claimed");
  await ctx.qualityJobs.saveDecision(workflowId, owner, {
    review: review(workflowId, TASK_ID),
    action: "RETRY",
  });
  return owner;
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("M7.1 QC retry capacity guard (PostgreSQL)", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items, quality_control_jobs RESTART IDENTITY CASCADE",
      ),
    );
    const now = new Date();
    await seed.handle.db.insert(missions).values({
      id: MISSION_ID,
      title: "QC capacity",
      objective: "Prove a retry cannot oversubscribe",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    await insertTask(TASK_ID, MISSION_TASK_ID);
    await insertTask(OTHER_TASK_ID, OTHER_MISSION_TASK_ID);

    await seed.registration.register({
      id: WORKER,
      workerKind: "agent",
      displayName: WORKER,
      capabilities: [CAPABILITY],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
      /* One slot. A second concurrent assignment is oversubscription by definition. */
      maxConcurrency: 1,
    });

    /* The failed attempt this retry follows. */
    await insertAttempt("qcc-a1", MISSION_TASK_ID, TASK_ID, 1, "failed", WORKER);
    await seed.handle.db.execute(
      sql.raw(
        `insert into task_execution_results (id, task_id, workflow_id, outcome, error_code, error_message, completed_at, recorded_at)
         values ('qcc-res-1', '${TASK_ID}', '${workflowIdForAttempt(TASK_ID, 1)}', 'failure', 'UNKNOWN_EFFECT', 'lease expired', now(), now())`,
      ),
    );
  });

  it("REFUSES a retry routed to a worker whose slot was taken since routing", async () => {
    const ctx = restart();
    const owner = await readyJob(ctx, workflowIdForAttempt(TASK_ID, 1));

    /*
     * THE RACE. Routing said this worker was free; between that decision and this INSERT
     * a DIFFERENT mission task consumed its only slot. `prepare()` refuses exactly this,
     * and the retry path must refuse it too.
     */
    await insertAttempt("qcc-a2", OTHER_MISSION_TASK_ID, OTHER_TASK_ID, 1, "dispatched", WORKER);

    await expect(
      ctx.qualityJobs.applyAction(workflowIdForAttempt(TASK_ID, 1), owner, {
        nextAttempt: 2,
        nextWorkflowId: workflowIdForAttempt(TASK_ID, 2),
        prompt: "retry",
        workerId: WORKER,
      }),
    ).rejects.toThrow(/WORKER_CAPACITY_EXCEEDED/);

    /* Nothing was created: back-pressure, not a half-applied action. */
    const rows = (await seed.handle.db.execute(
      sql.raw(
        `select count(*)::int as n from dispatch_attempts where mission_task_id = '${MISSION_TASK_ID}'`,
      ),
    )) as unknown as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });

  it("ALLOWS the retry when the worker genuinely has a free slot", async () => {
    const ctx = restart();
    const owner = await readyJob(ctx, workflowIdForAttempt(TASK_ID, 1));

    /* The predecessor is terminal, so its slot is already back (M7's whole point). */
    const applied = await ctx.qualityJobs.applyAction(workflowIdForAttempt(TASK_ID, 1), owner, {
      nextAttempt: 2,
      nextWorkflowId: workflowIdForAttempt(TASK_ID, 2),
      prompt: "retry",
      workerId: WORKER,
    });

    expect(applied.dispatchAcquired).toBe(true);
    const created = (await seed.handle.db.execute(
      sql.raw(
        `select worker_id from dispatch_attempts where workflow_id = '${workflowIdForAttempt(TASK_ID, 2)}'`,
      ),
    )) as unknown as Array<{ worker_id: string }>;
    /* And it carries the routed worker — the M7.1 gap closure, on the real path. */
    expect(created[0]?.worker_id).toBe(WORKER);
  });

  it("AN UNREGISTERED worker is refused: a decision against state that no longer exists", async () => {
    const ctx = restart();
    const owner = await readyJob(ctx, workflowIdForAttempt(TASK_ID, 1));
    await seed.handle.db.execute(sql.raw(`DELETE FROM workers WHERE id = '${WORKER}'`));

    await expect(
      ctx.qualityJobs.applyAction(workflowIdForAttempt(TASK_ID, 1), owner, {
        nextAttempt: 2,
        nextWorkflowId: workflowIdForAttempt(TASK_ID, 2),
        prompt: "retry",
        workerId: WORKER,
      }),
    ).rejects.toThrow(/WORKER_CAPACITY_EXCEEDED/);
  });
});
