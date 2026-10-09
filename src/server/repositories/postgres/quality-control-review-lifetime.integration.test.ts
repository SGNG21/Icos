import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresQualityControlRepository } from "./quality-control-repository";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { identities, type TestIdentity } from "@/test/test-identity";
import { MAX_REVIEW_ATTEMPTS } from "@/server/usecases/quality-control-service";

/**
 * A REVIEW THAT CANNOT BE DONE MUST STOP BEING RETRIED — and one that can must finish.
 *
 * MEASURED DEFECT. A reviewer outage parked the QC job, and the parked job was then
 * reclaimed with a MONOTONIC attempt count: the first reclaim was already past
 * MAX_REVIEW_ATTEMPTS, so it re-parked immediately, and again, for ever. The work was
 * never reviewed, never integrated and never escalated — a result nobody ever gets, which
 * is the defect family this lane exists to remove. Observed as 3 reviewer calls (all 503),
 * a park, and then not one further call after the cooldown lapsed.
 *
 * It was invisible to unit tests because the two implementations of this one port
 * disagreed: the IN-MEMORY repository always reset the budget on reclaim (the documented
 * intent), and only PostgreSQL incremented. A test against the fake proved the behaviour
 * the fake had.
 *
 * THE SHAPE NOW. Two bounds doing different jobs:
 *
 *   per cycle    MAX_REVIEW_ATTEMPTS, monotonic WITHIN a cycle, so a cycle always ends;
 *   in total     the job's `created_at` age against REVIEW_LIFETIME_DEADLINE_MS, checked
 *                before parking again — so repetition ends even though the budget resets.
 *
 * `created_at` is written once at registration and no sweep rewrites it, so the deadline
 * cannot be silently extended by the retrying itself.
 *
 * These proofs drive the REAL PostgreSQL repository, because that is where the defect
 * lived and the fake never had it.
 */
const DATABASE_URL = TEST_DATABASE_URL;
const CAPABILITY = "code-generation";
const OWNER = "qclife-owner";

const FILE_IDENTITIES = identities("qclife");
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
  WORKFLOW_ID = workflowIdForAttempt(TASK_ID, 1);
});

const handles: DatabaseHandle[] = [];
function connect() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  return { handle, qualityJobs: new PostgresQualityControlRepository(handle.db) };
}
const ctx = connect();

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

/** A registered QC job for one execution, as the completion callback would leave it. */
async function registerJob(): Promise<void> {
  const now = new Date();
  await ctx.handle.db
    .insert(missions)
    .values({
      id: MISSION_ID,
      title: "QC review lifetime",
      objective: "Prove a review that cannot be done stops being retried",
      status: "running",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await ctx.handle.db.insert(tasks).values({
    id: TASK_ID,
    title: TASK_ID,
    description: "work",
    status: "running",
    assignedAgentId: null,
    requiredCapabilities: [CAPABILITY],
    createdAt: now,
    updatedAt: now,
  });
  await ctx.handle.db.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: TASK_ID,
    description: "work",
    dependsOn: [],
    status: "running",
    workerKind: null,
    capability: CAPABILITY,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.handle.db.insert(dispatchAttempts).values({
    id: ids.label("att"),
    missionId: MISSION_ID,
    missionTaskId: MISSION_TASK_ID,
    taskId: TASK_ID,
    attempt: 1,
    workflowId: WORKFLOW_ID,
    prompt: "work",
    workerKind: "agent",
    workerId: null,
    capability: CAPABILITY,
    state: "dispatched",
    createdAt: now,
    updatedAt: now,
  });
  const [result] = (await ctx.handle.db.execute(
    sql.raw(
      `insert into task_execution_results
         (id, task_id, workflow_id, outcome, result, completed_at, recorded_at)
       values (gen_random_uuid(), '${TASK_ID}', '${WORKFLOW_ID}', 'success', 'done', now(), now())
       returning id`,
    ),
  )) as unknown as Array<{ id: string }>;
  await ctx.qualityJobs.register({
    missionId: MISSION_ID,
    missionTaskId: MISSION_TASK_ID,
    taskId: TASK_ID,
    workflowId: WORKFLOW_ID,
    executionResultId: result!.id,
    executionAttempt: 1,
  });
}

async function job() {
  return ctx.qualityJobs.getByWorkflowId(WORKFLOW_ID);
}
/** Releases the claim without changing state, as a lease expiry would. */
async function releaseClaim() {
  await ctx.handle.db.execute(
    sql.raw(
      `update quality_control_jobs set claim_until = now() - interval '1 second' where workflow_id = '${WORKFLOW_ID}'`,
    ),
  );
}
/** Ages the job itself, which is what the total bound is measured against. */
async function ageJob(ms: number) {
  await ctx.handle.db.execute(
    sql.raw(
      `update quality_control_jobs set created_at = now() - interval '${ms} milliseconds' where workflow_id = '${WORKFLOW_ID}'`,
    ),
  );
}
/** One failed review cycle: claim until the budget is spent, then park. */
async function burnOneCycle(): Promise<number> {
  let claims = 0;
  for (;;) {
    const claimed = await ctx.qualityJobs.claimNext(MISSION_ID, OWNER, 60_000);
    if (!claimed) throw new Error("no job claimed");
    claims += 1;
    if (claimed.reviewAttemptCount > MAX_REVIEW_ATTEMPTS) {
      await ctx.qualityJobs.markReviewUnavailable(
        WORKFLOW_ID,
        OWNER,
        "QUALITY_CONTROL_REVIEW_UNAVAILABLE",
        0,
      );
      return claims;
    }
    await releaseClaim();
  }
}

describe("review lifetime — a bounded retry, and an end to it (PostgreSQL)", () => {
  /* ── REVIEW_ATTEMPTS_PER_CYCLE_BOUNDED / REVIEW_PARKED_TRANSIENT ──────────────────── */
  it("a cycle spends a BOUNDED budget and then parks, never spinning", async () => {
    await registerJob();
    const claims = await burnOneCycle();

    /* MAX attempts, plus the claim that discovers the budget is spent. */
    expect(claims).toBe(MAX_REVIEW_ATTEMPTS + 1);
    const parked = await job();
    expect(parked?.state).toBe("review_unavailable");
    expect(parked?.lastError).toBe("QUALITY_CONTROL_REVIEW_UNAVAILABLE");
  });

  /* ── PARKED_JOB_CAN_RETRY_AFTER_COOLDOWN / FRESH_ATTEMPT_BUDGET_ON_RECLAIM ───────── */
  it("a parked review is RECLAIMED after its cooldown, with a FRESH budget", async () => {
    await registerJob();
    await burnOneCycle();
    expect((await job())?.reviewAttemptCount).toBeGreaterThan(MAX_REVIEW_ATTEMPTS);

    const reclaimed = await ctx.qualityJobs.claimNext(MISSION_ID, OWNER, 60_000);
    expect(reclaimed).not.toBeNull();
    /*
     * ONE, not four. This is the whole defect: it used to come back over budget, so the
     * service re-parked it without ever calling the reviewer again.
     */
    expect(reclaimed!.reviewAttemptCount).toBe(1);
    expect(reclaimed!.state).toBe("reviewing");
    /* And the new cycle is observable rather than inferred. */
    expect((await job())?.lastError).toBe("QUALITY_CONTROL_REVIEW_RETRY_CYCLE_STARTED");
  });

  /* ── RECOVERING_REVIEWER_CAN_COMPLETE ───────────────────────────────────────────────── */
  it("a reviewer that COMES BACK can finish work parked during its outage", async () => {
    await registerJob();
    await burnOneCycle();

    const reclaimed = await ctx.qualityJobs.claimNext(MISSION_ID, OWNER, 60_000);
    /* Within budget, so the service reviews instead of parking: the work is reachable. */
    expect(reclaimed!.reviewAttemptCount).toBeLessThanOrEqual(MAX_REVIEW_ATTEMPTS);
    await ctx.qualityJobs.saveDecision(WORKFLOW_ID, OWNER, {
      review: {
        id: ids.label("rev"),
        taskId: TASK_ID,
        workflowId: WORKFLOW_ID,
        missionId: MISSION_ID,
        decision: "APPROVE",
        reviewerKind: "llm",
        severity: "info",
        reasons: ["reviewer recovered"],
        humanOverridden: false,
        createdAt: new Date().toISOString(),
      },
      action: "ACCEPT",
    });
    const decided = await job();
    expect(decided?.state).toBe("decision_ready");
    expect(decided?.action).toBe("ACCEPT");
  });

  /* ── PERMANENT_503_DOES_NOT_LOOP_FOREVER / TOTAL_REVIEW_LIFETIME_BOUNDED ─────────── */
  it("a reviewer that NEVER comes back runs out of LIFETIME, not of patience", async () => {
    await registerJob();
    /*
     * Many cycles, as a long outage produces. Each one ends — that is the per-cycle bound —
     * and the budget is fresh each time, so nothing here ends the REPETITION. What ends it
     * is the job's age, which no cycle moves.
     */
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const claims = await burnOneCycle();
      expect(claims).toBe(MAX_REVIEW_ATTEMPTS + 1);
    }
    const stillParked = await job();
    expect(stillParked?.state).toBe("review_unavailable");

    /* The age is what the total bound reads, and it has not been reset by the retrying. */
    await ageJob(60 * 60_000 + 1_000);
    const aged = await job();
    expect(Date.now() - aged!.createdAt.getTime()).toBeGreaterThan(60 * 60_000);
  });

  /* ── PERMANENT_503_EVENTUALLY_ESCALATES / REVIEW_LIFETIME_EXCEEDED ──────────────────── */
  it("past its lifetime the review ESCALATES, and is never parked again", async () => {
    await registerJob();
    await burnOneCycle();
    await ageJob(60 * 60_000 + 1_000);

    /* What the service does once the deadline has passed: escalate, with the stable reason. */
    const reclaimed = await ctx.qualityJobs.claimNext(MISSION_ID, OWNER, 60_000);
    expect(reclaimed).not.toBeNull();
    await ctx.qualityJobs.escalateOwned(
      WORKFLOW_ID,
      OWNER,
      "QUALITY_CONTROL_REVIEW_LIFETIME_EXCEEDED",
    );

    const escalated = await job();
    expect(escalated?.state).toBe("escalated");
    expect(escalated?.action).toBe("ESCALATE");
    expect(escalated?.lastError).toBe("QUALITY_CONTROL_REVIEW_LIFETIME_EXCEEDED");
    /* Terminal: an escalated job is not handed back to the review loop. */
    expect(await ctx.qualityJobs.claimNext(MISSION_ID, OWNER, 60_000)).toBeNull();
    /* And the human-visible outcome is a FAILED task, never a silent success. */
    const [row] = (await ctx.handle.db.execute(
      sql.raw(`select status from mission_tasks where id = '${MISSION_TASK_ID}'`),
    )) as unknown as Array<{ status: string }>;
    expect(row!.status).toBe("failed");
  });
});
