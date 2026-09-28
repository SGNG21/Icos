import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";

/*
 * M6.3 — DURABLE RETRY/RESUME AND EXECUTION FENCING, on real PostgreSQL.
 *
 * Every "restart" below is a NEW connection handle with a NEW repository instance,
 * so nothing is carried in process memory. What survives a restart is rows, or
 * nothing — and for autonomy it has to be rows: a runner that forgets how the last
 * attempt failed cannot decide whether to retry, and a runner that forgets what the
 * last attempt DID makes the next one start over.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const MISSION_ID = "m63-mission";
const MISSION_TASK_ID = "m63-mt-1";
const TASK_ID = "m63-task-1";

const handles: DatabaseHandle[] = [];

/** A restart: new connection, new repository, zero shared memory. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  return { handle, ledger: new PostgresDispatchAttemptRepository(handle.db) };
}

const seed = restart();

async function seedMissionAndTask() {
  const now = new Date();
  await seed.handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "M6.3",
    objective: "Prove durable resume",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(tasks).values({
    id: TASK_ID,
    title: "T",
    description: "do work",
    status: "draft",
    assignedAgentId: null,
    requiredCapabilities: ["code-generation"],
    createdAt: now,
    updatedAt: now,
  });
  await seed.handle.db.insert(missionTasks).values({
    id: MISSION_TASK_ID,
    missionId: MISSION_ID,
    title: "T",
    description: "do work",
    dependsOn: [],
    status: "draft",
    workerKind: null,
    capability: null,
    taskId: TASK_ID,
    createdAt: now,
    updatedAt: now,
  });
}

/** Creates one attempt row directly: these tests are about the attempt, not routing. */
async function makeAttempt(attempt: number, state = "dispatched"): Promise<string> {
  const id = `m63-att-${attempt}`;
  const now = new Date();
  await seed.handle.db.insert(dispatchAttempts).values({
    id,
    missionId: MISSION_ID,
    missionTaskId: MISSION_TASK_ID,
    taskId: TASK_ID,
    attempt,
    workflowId: `m63-wf-${attempt}`,
    prompt: "do work",
    workerKind: "agent",
    workerId: "11111111-1111-4111-8111-111111111111",
    capability: "code-generation",
    state,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("M6.3 durable execution lease and resume (PostgreSQL)", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items RESTART IDENTITY CASCADE",
      ),
    );
    await seedMissionAndTask();
  });

  it("THE EXECUTION LEASE IS EXCLUSIVE: one owner, and a second process is refused", async () => {
    const id = await makeAttempt(1);

    /* Two independent processes, two connections, one atomic UPDATE decides. */
    const a = restart();
    const b = restart();

    expect(await a.ledger.acquireExecutionLease(id, "runner-a", 60_000)).toBe(true);
    expect(await b.ledger.acquireExecutionLease(id, "runner-b", 60_000)).toBe(false);

    expect(await a.ledger.holdsExecutionLease(id, "runner-a")).toBe(true);
    expect(await b.ledger.holdsExecutionLease(id, "runner-b")).toBe(false);
  });

  it("THE LEASE IS REENTRANT for its own owner, so a retry in-process is not locked out", async () => {
    const id = await makeAttempt(1);
    const ctx = restart();

    expect(await ctx.ledger.acquireExecutionLease(id, "runner-a", 60_000)).toBe(true);
    expect(await ctx.ledger.acquireExecutionLease(id, "runner-a", 60_000)).toBe(true);
  });

  it("AN EXPIRED LEASE CAN BE TAKEN OVER, and the old owner is FENCED OUT", async () => {
    const id = await makeAttempt(1);
    const first = restart();
    expect(await first.ledger.acquireExecutionLease(id, "runner-a", 60_000)).toBe(true);

    /*
     * Expire by clock, not by waiting. This is the abandoned-execution case: the
     * process holding the lease died without settling the attempt.
     */
    await seed.handle.db
      .update(dispatchAttempts)
      .set({ executionLeaseUntil: new Date(Date.now() - 1_000) })
      .where(eq(dispatchAttempts.id, id));

    const second = restart();
    expect(await second.ledger.acquireExecutionLease(id, "runner-b", 60_000)).toBe(true);

    /*
     * THE FENCE. If runner-a wakes up and reports a result now, that result would be
     * a duplicate for one logical attempt — so it must be refused.
     */
    expect(await second.ledger.holdsExecutionLease(id, "runner-a")).toBe(false);
    expect(await second.ledger.holdsExecutionLease(id, "runner-b")).toBe(true);
  });

  it("A TERMINAL ATTEMPT CANNOT BE LEASED", async () => {
    const done = await makeAttempt(1, "completed");
    const failed = await makeAttempt(2, "failed");
    const ctx = restart();

    // Leasing finished work would let a runner re-execute an integrated task.
    expect(await ctx.ledger.acquireExecutionLease(done, "r", 60_000)).toBe(false);
    expect(await ctx.ledger.acquireExecutionLease(failed, "r", 60_000)).toBe(false);
  });

  it("AN INVALID LEASE DURATION IS REFUSED rather than creating a never-expiring fence", async () => {
    const id = await makeAttempt(1);
    const ctx = restart();
    await expect(ctx.ledger.acquireExecutionLease(id, "r", 0)).rejects.toThrow(
      /EXECUTION_LEASE_INVALID_LEASE/,
    );
    await expect(ctx.ledger.acquireExecutionLease(id, "r", -5)).rejects.toThrow(
      /EXECUTION_LEASE_INVALID_LEASE/,
    );
  });

  it("PROCESS_RESTART_CONTINUATION: failure class, resume token and handoff survive a restart", async () => {
    const id = await makeAttempt(1);
    const runner = restart();
    await runner.ledger.acquireExecutionLease(id, "runner-a", 60_000);

    await runner.ledger.recordExecutionFailure(id, {
      failureClass: "SESSION_EXHAUSTED",
      message: "context window exceeded",
      resumeToken: "hermes-session-7",
      handoff: { done: ["step A"], next: "step B" },
    });

    /* A completely new process reads the state. Nothing is in memory. */
    const afterRestart = restart();
    const attempt = await afterRestart.ledger.getByWorkflowId("m63-wf-1");

    expect(attempt?.state).toBe("failed");
    expect(attempt?.failureClass).toBe("SESSION_EXHAUSTED");
    expect(attempt?.resumeToken).toBe("hermes-session-7");
    expect(attempt?.handoff).toEqual({ done: ["step A"], next: "step B" });

    // And the lease is released, so recovery is not blocked by a dead runner's fence.
    expect(await afterRestart.ledger.holdsExecutionLease(id, "runner-a")).toBe(false);
  });

  it("RETRYABLE_RESUME: the next attempt inherits the SAME logical task's resume state", async () => {
    const first = await makeAttempt(1);
    const runner = restart();
    await runner.ledger.recordExecutionFailure(first, {
      failureClass: "SESSION_EXHAUSTED",
      message: "out of context",
      resumeToken: "session-1",
      handoff: { completed: ["scaffold"] },
    });

    /*
     * A retry is a NEW attempt row for the SAME missionTaskId — the existing ledger
     * model, not a parallel concept. What makes it a CONTINUATION is inheriting this.
     */
    const resumable = await restart().ledger.latestResumableState(MISSION_TASK_ID);

    expect(resumable).toEqual({
      attempt: 1,
      resumeToken: "session-1",
      handoff: { completed: ["scaffold"] },
      failureClass: "SESSION_EXHAUSTED",
    });
  });

  it("THE NEWEST ATTEMPT WINS, so a resume continues the most recent work", async () => {
    const a1 = await makeAttempt(1);
    const a2 = await makeAttempt(2);
    const ctx = restart();

    await ctx.ledger.recordExecutionFailure(a1, {
      failureClass: "STREAM_FAILED",
      message: "first",
      resumeToken: "session-old",
    });
    await ctx.ledger.recordExecutionFailure(a2, {
      failureClass: "SESSION_EXHAUSTED",
      message: "second",
      resumeToken: "session-new",
    });

    const resumable = await restart().ledger.latestResumableState(MISSION_TASK_ID);
    expect(resumable?.attempt).toBe(2);
    expect(resumable?.resumeToken).toBe("session-new");
  });

  it("NOTHING TO RESUME IS NULL, not an empty continuation", async () => {
    await makeAttempt(1);
    /* The normal first-attempt case must be distinguishable from "resume with nothing". */
    expect(await restart().ledger.latestResumableState(MISSION_TASK_ID)).toBeNull();
  });

  it("A FAILURE WITH NO RESUME STATE does not become a phantom continuation", async () => {
    const id = await makeAttempt(1);
    await restart().ledger.recordExecutionFailure(id, {
      failureClass: "FAILED_TERMINAL",
      message: "impossible",
    });

    // Terminal and nothing to carry: the next attempt must start clean, not resume.
    expect(await restart().ledger.latestResumableState(MISSION_TASK_ID)).toBeNull();
    expect((await restart().ledger.getByWorkflowId("m63-wf-1"))?.failureClass).toBe(
      "FAILED_TERMINAL",
    );
  });

  it("ALL EIGHT CLASSES ARE STORABLE, and an unknown one is refused by the DATABASE", async () => {
    const classes = [
      "SESSION_EXHAUSTED",
      "PROVIDER_UNAVAILABLE",
      "RATE_LIMITED",
      "STREAM_FAILED",
      "WORKER_CRASHED",
      "LEASE_EXPIRED",
      "FAILED_RETRYABLE",
      "FAILED_TERMINAL",
    ] as const;

    const ctx = restart();
    for (const [index, failureClass] of classes.entries()) {
      const id = await makeAttempt(index + 1);
      await ctx.ledger.recordExecutionFailure(id, { failureClass, message: failureClass });
      expect((await ctx.ledger.getByWorkflowId(`m63-wf-${index + 1}`))?.failureClass).toBe(
        failureClass,
      );
    }

    /*
     * The allow-list is the last gate: a typo'd class must not become an unreadable
     * retry decision, even from a caller that bypasses the Zod contract.
     */
    const error = await seed.handle.db
      .execute(
        sql.raw(
          `UPDATE dispatch_attempts SET failure_class = 'SESSION_EXHAUSTD' WHERE id = 'm63-att-1'`,
        ),
      )
      .then(
        () => null,
        (caught: unknown) => caught as Error,
      );
    expect(`${error?.message} ${String(error?.cause ?? "")}`).toMatch(
      /dispatch_attempts_failure_class_check/,
    );
  });

  it("THE EXECUTION LEASE IS INDEPENDENT of the recovery claim", async () => {
    const id = await makeAttempt(1, "prepared");
    const ctx = restart();

    /*
     * Both fences on one row at once, held by DIFFERENT owners. This is exactly why
     * migration 0046 added separate columns instead of reusing claim_token: sharing
     * them would let a recovery sweeper and a running executor silently overwrite
     * each other's fence.
     */
    expect(await ctx.ledger.claimPrepared(id, "recoverer-1", 60_000)).toBe(true);
    expect(await ctx.ledger.acquireExecutionLease(id, "runner-1", 60_000)).toBe(true);

    expect(await ctx.ledger.holdsExecutionLease(id, "runner-1")).toBe(true);
    // The recovery claim is untouched by the execution lease.
    expect(await ctx.ledger.claimPrepared(id, "recoverer-2", 60_000)).toBe(false);
  });
});
