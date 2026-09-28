import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import {
  WorkerCapacityExceededError,
  type AuthorizeDispatchStartResult,
  type DispatchAttempt,
  type DispatchAttemptRepository,
  type PrepareDispatchAttemptInput,
  type PrepareDispatchAttemptResult,
  type RecordExecutionFailureInput,
  type ResumableAttemptState,
} from "@/core/contracts/dispatch-attempt";
import type { AuditEntry } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import {
  actions,
  auditEntries,
  dispatchAttempts,
  missionTasks,
  tasks,
  workers,
} from "@/server/database/schema";
import { transitionTask } from "@/core/tasks/lifecycle";
import { auditToRow, rowToTask } from "@/server/database/mappers";

/** The two non-terminal states. An active execution is exactly one of these. */
const ACTIVE_ATTEMPT_STATES = ["prepared", "dispatched"] as const;

function mapRow(row: typeof dispatchAttempts.$inferSelect): DispatchAttempt {
  return {
    id: row.id,
    missionId: row.missionId,
    missionTaskId: row.missionTaskId,
    taskId: row.taskId,
    attempt: row.attempt,
    workflowId: row.workflowId,
    prompt: row.prompt,
    workerKind: row.workerKind ?? undefined,
    workerId: row.workerId ?? undefined,
    capability: row.capability ?? undefined,
    state: row.state as DispatchAttempt["state"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dispatchedAt: row.dispatchedAt ?? undefined,
    lastError: row.lastError ?? undefined,
    failureClass: (row.failureClass as DispatchAttempt["failureClass"]) ?? undefined,
    resumeToken: row.resumeToken ?? undefined,
    handoff: (row.handoff as Record<string, unknown> | null) ?? undefined,
  };
}

export class PostgresDispatchAttemptRepository implements DispatchAttemptRepository {
  private startAuthorizationHookForTest?: () => Promise<void>;

  constructor(private readonly db: Database) {}

  /** Worker ids on non-terminal attempts: one entry per active execution. */
  async listActiveWorkerAssignments(): Promise<string[]> {
    const rows = await this.db
      .select({ workerId: dispatchAttempts.workerId })
      .from(dispatchAttempts)
      .where(
        and(
          isNotNull(dispatchAttempts.workerId),
          inArray(dispatchAttempts.state, ACTIVE_ATTEMPT_STATES),
        ),
      );

    return rows.map((row) => row.workerId as string).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Fails closed when the assigned worker, or its shared capacity pool, is
   * already fully committed. Must run inside the prepare transaction, after the
   * worker rows have been locked.
   *
   * An UNREGISTERED worker id is rejected: assigning work to a worker that is
   * not in the registry means the decision was made against state that no longer
   * exists, and letting it through would create an attempt whose load nothing
   * bounds.
   */
  private async assertWorkerCapacity(
    tx: Database,
    workerId: string,
    missionTaskId: string,
  ): Promise<void> {
    const assigned = await tx
      .select()
      .from(workers)
      .where(eq(workers.id, workerId))
      .limit(1)
      .for("update");
    const worker = assigned[0];

    if (!worker) {
      throw new WorkerCapacityExceededError(workerId, "is not registered");
    }

    // Lock every peer in the pool, ordered by id: same order for everyone, so
    // no deadlock, and no peer can commit an attempt while we are counting.
    const poolMembers = worker.capacityPool
      ? await tx
          .select({ id: workers.id, limit: workers.capacityPoolLimit })
          .from(workers)
          .where(eq(workers.capacityPool, worker.capacityPool))
          .orderBy(asc(workers.id))
          .for("update")
      : [];

    const active = await tx
      .select({ workerId: dispatchAttempts.workerId })
      .from(dispatchAttempts)
      .where(
        and(
          isNotNull(dispatchAttempts.workerId),
          inArray(dispatchAttempts.state, ACTIVE_ATTEMPT_STATES),
        ),
      );

    // This task's own live attempt is not competing demand: a retry of the same
    // logical work must not be blocked by the attempt it is superseding.
    const ownAttempts = await tx
      .select({ id: dispatchAttempts.id })
      .from(dispatchAttempts)
      .where(
        and(
          eq(dispatchAttempts.missionTaskId, missionTaskId),
          inArray(dispatchAttempts.state, ACTIVE_ATTEMPT_STATES),
        ),
      );
    const ownActive = ownAttempts.length;

    const mine = active.filter((row) => row.workerId === workerId).length;
    if (mine - Math.min(mine, ownActive) >= worker.maxConcurrency) {
      throw new WorkerCapacityExceededError(
        workerId,
        `already holds ${mine} of ${worker.maxConcurrency} concurrent executions`,
      );
    }

    if (worker.capacityPool && poolMembers.length > 0) {
      const declared = poolMembers
        .map((member) => member.limit)
        .filter((limit): limit is number => limit !== null);

      if (declared.length > 0) {
        // A quota is a ceiling: when members disagree, the SMALLEST wins.
        const limit = Math.min(...declared);
        const memberIds = new Set(poolMembers.map((member) => member.id));
        const poolActive = active.filter(
          (row) => row.workerId !== null && memberIds.has(row.workerId),
        ).length;

        if (poolActive - Math.min(poolActive, ownActive) >= limit) {
          throw new WorkerCapacityExceededError(
            workerId,
            `capacity pool ${worker.capacityPool} holds ${poolActive} of ${limit}`,
          );
        }
      }
    }
  }

  async prepare(input: PrepareDispatchAttemptInput): Promise<PrepareDispatchAttemptResult> {
    return this.db.transaction(async (tx) => {
      const now = new Date();

      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.missionTaskId}, 0))`,
      );

      const missionTaskRows = await tx
        .select()
        .from(missionTasks)
        .where(eq(missionTasks.id, input.missionTaskId))
        .limit(1)
        .for("update");
      const missionTask = missionTaskRows[0];
      if (
        !missionTask ||
        missionTask.missionId !== input.missionId ||
        missionTask.taskId !== input.taskId
      ) {
        throw new Error("DISPATCH_ATTEMPT_MISSION_TASK_CORRELATION_FAILED");
      }

      const taskRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
        .for("update");
      const task = taskRows[0];
      if (!task) throw new Error(`Task not found: ${input.taskId}`);

      /*
       * ATOMIC CAPACITY GUARD (M5.3).
       *
       * Routing chose this worker from a load snapshot read OUTSIDE any
       * transaction, so two supervisors can both see "worker W is free" and both
       * pick it. Re-checking here, after taking a row lock on the worker (and on
       * every peer sharing its capacity pool), serialises those deciders: the
       * second one sees the first one's committed intent and is rejected instead
       * of oversubscribing.
       *
       * Locks are taken in worker-id order so two transactions touching the same
       * pool can never deadlock by acquiring the same rows in opposite orders.
       */
      if (input.workerId) {
        await this.assertWorkerCapacity(tx, input.workerId, input.missionTaskId);
      }

      const currentAttempts = await tx
        .select()
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.missionTaskId, input.missionTaskId))
        .orderBy(desc(dispatchAttempts.attempt));
      if (currentAttempts[0] && input.attempt < currentAttempts[0].attempt) {
        throw new Error(`DISPATCH_ATTEMPT_STALE: ${input.missionTaskId}/${input.attempt}`);
      }

      const inserted = await tx
        .insert(dispatchAttempts)
        .values({
          id: randomUUID(),
          missionId: input.missionId,
          missionTaskId: input.missionTaskId,
          taskId: input.taskId,
          attempt: input.attempt,
          workflowId: input.workflowId,
          prompt: input.prompt,
          workerKind: input.workerKind ?? null,
          workerId: input.workerId ?? null,
          capability: input.capability ?? null,
          state: "prepared",
          createdAt: now,
          updatedAt: now,
        })
        // Intentionally no conflict target:
        // both unique constraints identify the same logical dispatch intent:
        // - (mission_task_id, attempt)
        // - workflow_id
        .onConflictDoNothing()
        .returning();

      const acquired = inserted.length === 1;

      const rows = acquired
        ? inserted
        : await tx
            .select()
            .from(dispatchAttempts)
            .where(
              and(
                eq(dispatchAttempts.missionTaskId, input.missionTaskId),
                eq(dispatchAttempts.attempt, input.attempt),
              ),
            )
            .limit(1);

      const attempt = rows[0];

      if (!attempt) {
        throw new Error(
          `DispatchAttempt introuvable après prepare: ${input.missionTaskId}/${input.attempt}`,
        );
      }

      if (attempt.taskId !== input.taskId || attempt.workflowId !== input.workflowId) {
        throw new Error(`DISPATCH_ATTEMPT_CONFLICT: ${input.missionTaskId}/${input.attempt}`);
      }

      // A concurrent Supervisor already progressed this exact logical dispatch
      // (same task and workflowId): converge on it idempotently. It owns nothing
      // (acquired=false) and must not reassert queued state over a running task.
      if (!acquired && (attempt.state === "dispatched" || attempt.state === "completed")) {
        return { attempt: mapRow(attempt), acquired: false };
      }

      if (attempt.state !== "prepared") {
        throw new Error(`DISPATCH_ATTEMPT_CONFLICT: ${input.missionTaskId}/${input.attempt}`);
      }

      if (acquired) {
        await tx
          .update(dispatchAttempts)
          .set({
            state: "failed",
            lastError: "DISPATCH_ATTEMPT_SUPERSEDED",
            updatedAt: now,
            claimToken: null,
            claimUntil: null,
          })
          .where(
            and(
              eq(dispatchAttempts.missionTaskId, input.missionTaskId),
              lt(dispatchAttempts.attempt, input.attempt),
              or(
                eq(dispatchAttempts.state, "prepared"),
                eq(dispatchAttempts.state, "dispatched"),
              ),
            ),
          );
      }

      await tx
        .update(missionTasks)
        .set({
          status: "queued",
          updatedAt: now,
        })
        .where(
          and(
            eq(missionTasks.id, input.missionTaskId),
            eq(missionTasks.missionId, input.missionId),
          ),
        );

      if (task.status !== "queued") {
              if (task.status === "draft" || (task.status === "review_pending" && input.attempt > 1) || task.status === "running" || task.status === "succeeded") {
                await tx
                  .update(tasks)
                  .set({ status: "queued", updatedAt: now })
                  .where(eq(tasks.id, input.taskId));
              } else {
                throw new Error(`Task ${input.taskId} cannot transition from ${task.status} to queued`);
              }
            }

      return {
        attempt: mapRow(attempt),
        acquired,
      };
    });
  }

  setStartAuthorizationHookForTest(hook?: () => Promise<void>): void {
    this.startAuthorizationHookForTest = hook;
  }

  async authorizeStart(
    taskId: string,
    workflowId: string,
  ): Promise<AuthorizeDispatchStartResult> {
    const initial = await this.db
      .select({ missionTaskId: dispatchAttempts.missionTaskId })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.workflowId, workflowId))
      .limit(1);
    if (!initial[0]) {
      return {
        ok: false,
        reason: "workflow_not_found",
        message: "workflow d'exécution non corrélé",
      };
    }

    await this.startAuthorizationHookForTest?.();

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${initial[0].missionTaskId}, 0))`,
      );

      const attemptRows = await tx
        .select()
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.workflowId, workflowId))
        .limit(1);
      const attempt = attemptRows[0];
      if (!attempt) {
        return {
          ok: false as const,
          reason: "workflow_not_found" as const,
          message: "workflow d'exécution non corrélé",
        };
      }
      if (attempt.taskId !== taskId) {
        return {
          ok: false as const,
          reason: "workflow_task_mismatch" as const,
          message: "workflow d'exécution non corrélé",
        };
      }
      if (attempt.state !== "prepared" && attempt.state !== "dispatched") {
        return {
          ok: false as const,
          reason: "attempt_not_eligible" as const,
          message: `dispatch attempt is not eligible to start (state: ${attempt.state})`,
        };
      }

      const authoritative = await tx
        .select({ id: dispatchAttempts.id })
        .from(dispatchAttempts)
        .where(
          and(
            eq(dispatchAttempts.missionTaskId, attempt.missionTaskId),
            or(
              eq(dispatchAttempts.state, "prepared"),
              eq(dispatchAttempts.state, "dispatched"),
            ),
          ),
        )
        .orderBy(desc(dispatchAttempts.attempt), desc(dispatchAttempts.createdAt))
        .limit(1);
      if (authoritative[0]?.id !== attempt.id) {
        return {
          ok: false as const,
          reason: "stale_attempt" as const,
          message: "stale dispatch attempt: a newer attempt exists for this task",
        };
      }

      const taskRows = await tx
        .select()
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .limit(1)
        .for("update");
      if (!taskRows[0]) {
        return {
          ok: false as const,
          reason: "task_not_found" as const,
          message: `tâche inconnue : ${taskId}`,
        };
      }
      const actionRows = await tx
        .select({ id: actions.id })
        .from(actions)
        .where(eq(actions.taskId, taskId))
        .orderBy(asc(actions.createdAt), asc(actions.id));
      const current = rowToTask(taskRows[0], actionRows.map((row) => row.id));
      if (current.status === "running") {
        return { ok: true as const, task: current, alreadyRunning: true };
      }

      const transition = transitionTask(current, "running");
      if (!transition.ok) {
        return {
          ok: false as const,
          reason: "invalid_transition" as const,
          message: `transition ${current.status} → running interdite`,
        };
      }
      const auditEntry: AuditEntry = {
        id: `audit-${randomUUID()}`,
        occurredAt: transition.task.updatedAt,
        createdAt: transition.task.updatedAt,
        eventType: "task.transitioned",
        actor: current.assignedAgentId
          ? { kind: "agent", id: current.assignedAgentId }
          : { kind: "system", id: "icos" },
        taskId,
        details: { from: current.status, to: "running" },
      };
      await tx
        .update(tasks)
        .set({ status: "running", updatedAt: new Date(transition.task.updatedAt) })
        .where(eq(tasks.id, taskId));
      await tx.insert(auditEntries).values(auditToRow(auditEntry));
      return { ok: true as const, task: transition.task, alreadyRunning: false };
    });
  }

  async claimPrepared(id: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("RECOVERY_CLAIM_INVALID_LEASE");
    }

    const now = new Date();
    const claimUntil = new Date(now.getTime() + leaseMs);

    const claimed = await this.db
      .update(dispatchAttempts)
      .set({
        claimToken: ownerToken,
        claimUntil,
        updatedAt: now,
      })
      .where(
        and(
          eq(dispatchAttempts.id, id),
          eq(dispatchAttempts.state, "prepared"),
          or(isNull(dispatchAttempts.claimUntil), lt(dispatchAttempts.claimUntil, now)),
        ),
      )
      .returning({
        id: dispatchAttempts.id,
      });

    return claimed.length === 1;
  }

  async markDispatched(id: string): Promise<void> {
    const now = new Date();

    const updated = await this.db
      .update(dispatchAttempts)
      .set({
        state: "dispatched",
        dispatchedAt: now,
        updatedAt: now,
        lastError: null,
        claimToken: null,
        claimUntil: null,
      })
      .where(and(eq(dispatchAttempts.id, id), eq(dispatchAttempts.state, "prepared")))
      .returning({ id: dispatchAttempts.id });

    if (updated.length === 1) {
      return;
    }

    const current = await this.db
      .select({ state: dispatchAttempts.state })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.id, id))
      .limit(1);

    if (current[0]?.state !== "dispatched") {
      throw new Error("DISPATCH_ATTEMPT_INVALID_ACKNOWLEDGEMENT");
    }
  }

  async markFailed(id: string, message: string): Promise<void> {
    const stableMessage = message.startsWith("DISPATCH_") ? message : "DISPATCH_PROVIDER_REJECTED";

    await this.db
      .update(dispatchAttempts)
      .set({
        state: "failed",
        updatedAt: new Date(),
        lastError: stableMessage,
        claimToken: null,
        claimUntil: null,
      })
      .where(eq(dispatchAttempts.id, id));
  }

  /**
   * Settles a failed attempt WITH its classification and resume state (M6.3).
   *
   * The execution lease is RELEASED here: the attempt is terminal, so holding a
   * fence on it would only block the recovery that should now happen.
   */
  async recordExecutionFailure(id: string, input: RecordExecutionFailureInput): Promise<void> {
    await this.db
      .update(dispatchAttempts)
      .set({
        state: "failed",
        updatedAt: new Date(),
        /* Bounded: last_error is a diagnostic summary, never a transcript. */
        lastError: input.message.slice(0, 2_000),
        failureClass: input.failureClass,
        resumeToken: input.resumeToken ?? null,
        handoff: input.handoff ?? null,
        executionLeaseOwner: null,
        executionLeaseUntil: null,
      })
      .where(eq(dispatchAttempts.id, id));
  }

  async acquireExecutionLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("EXECUTION_LEASE_INVALID_LEASE");
    }

    const now = new Date();
    const until = new Date(now.getTime() + leaseMs);

    /*
     * One atomic UPDATE is the whole mutual exclusion: only a row whose lease is
     * absent, expired, or already ours can be taken. Reading then writing would
     * leave a window in which two runners both see "free".
     */
    const claimed = await this.db
      .update(dispatchAttempts)
      .set({ executionLeaseOwner: owner, executionLeaseUntil: until, updatedAt: now })
      .where(
        and(
          eq(dispatchAttempts.id, id),
          /* Only a live execution may be leased; terminal attempts are done. */
          inArray(dispatchAttempts.state, [...ACTIVE_ATTEMPT_STATES]),
          or(
            isNull(dispatchAttempts.executionLeaseUntil),
            lt(dispatchAttempts.executionLeaseUntil, now),
            eq(dispatchAttempts.executionLeaseOwner, owner),
          ),
        ),
      )
      .returning({ id: dispatchAttempts.id });

    return claimed.length > 0;
  }

  async holdsExecutionLease(id: string, owner: string): Promise<boolean> {
    const now = new Date();
    const rows = await this.db
      .select({ id: dispatchAttempts.id })
      .from(dispatchAttempts)
      .where(
        and(
          eq(dispatchAttempts.id, id),
          eq(dispatchAttempts.executionLeaseOwner, owner),
          /* An expired lease is NOT held: time alone revokes it. */
          gte(dispatchAttempts.executionLeaseUntil, now),
        ),
      )
      .limit(1);

    return rows.length > 0;
  }

  async latestResumableState(missionTaskId: string): Promise<ResumableAttemptState | null> {
    const rows = await this.db
      .select({
        attempt: dispatchAttempts.attempt,
        resumeToken: dispatchAttempts.resumeToken,
        handoff: dispatchAttempts.handoff,
        failureClass: dispatchAttempts.failureClass,
      })
      .from(dispatchAttempts)
      .where(
        and(
          eq(dispatchAttempts.missionTaskId, missionTaskId),
          isNotNull(dispatchAttempts.resumeToken),
        ),
      )
      /* Newest attempt wins: resume continues the most recent work, not the first. */
      .orderBy(desc(dispatchAttempts.attempt))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      attempt: row.attempt,
      resumeToken: row.resumeToken ?? undefined,
      handoff: (row.handoff as Record<string, unknown> | null) ?? undefined,
      failureClass: (row.failureClass as ResumableAttemptState["failureClass"]) ?? undefined,
    };
  }

  async markCompletedByWorkflowId(workflowId: string): Promise<void> {
    const updated = await this.db
      .update(dispatchAttempts)
      .set({
        state: "completed",
        updatedAt: new Date(),
        claimToken: null,
        claimUntil: null,
      })
      .where(
        and(
          eq(dispatchAttempts.workflowId, workflowId),
          or(eq(dispatchAttempts.state, "prepared"), eq(dispatchAttempts.state, "dispatched")),
        ),
      )
      .returning({ id: dispatchAttempts.id });

    if (updated.length === 1) {
      return;
    }

    const current = await this.getByWorkflowId(workflowId);
    if (current?.state !== "completed") {
      throw new Error("DISPATCH_ATTEMPT_UNKNOWN_WORKFLOW");
    }
  }

  async getByWorkflowId(workflowId: string): Promise<DispatchAttempt | null> {
    const rows = await this.db
      .select()
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.workflowId, workflowId))
      .limit(1);

    return rows[0] ? mapRow(rows[0]) : null;
  }

  async listPrepared(missionId?: string): Promise<DispatchAttempt[]> {
    const rows = missionId
      ? await this.db
          .select()
          .from(dispatchAttempts)
          .where(
            and(eq(dispatchAttempts.state, "prepared"), eq(dispatchAttempts.missionId, missionId)),
          )
          .orderBy(asc(dispatchAttempts.createdAt), asc(dispatchAttempts.id))
      : await this.db
          .select()
          .from(dispatchAttempts)
          .where(eq(dispatchAttempts.state, "prepared"))
          .orderBy(asc(dispatchAttempts.createdAt), asc(dispatchAttempts.id));

    return rows.map(mapRow);
  }

  async listNonTerminalByMissionTaskId(missionTaskId: string): Promise<DispatchAttempt[]> {
    const rows = await this.db
      .select()
      .from(dispatchAttempts)
      .where(
        and(
          eq(dispatchAttempts.missionTaskId, missionTaskId),
          or(eq(dispatchAttempts.state, "prepared"), eq(dispatchAttempts.state, "dispatched")),
        ),
      )
      .orderBy(
        desc(dispatchAttempts.attempt),
        desc(dispatchAttempts.createdAt),
      );

    return rows.map(mapRow);
  }
}
