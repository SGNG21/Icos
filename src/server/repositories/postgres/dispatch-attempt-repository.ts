import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import type {
  AuthorizeDispatchStartResult,
  DispatchAttempt,
  DispatchAttemptRepository,
  PrepareDispatchAttemptInput,
  PrepareDispatchAttemptResult,
} from "@/core/contracts/dispatch-attempt";
import type { AuditEntry } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import { actions, auditEntries, dispatchAttempts, missionTasks, tasks } from "@/server/database/schema";
import { transitionTask } from "@/core/tasks/lifecycle";
import { auditToRow, rowToTask } from "@/server/database/mappers";

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
    capability: row.capability ?? undefined,
    state: row.state as DispatchAttempt["state"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dispatchedAt: row.dispatchedAt ?? undefined,
    lastError: row.lastError ?? undefined,
  };
}

export class PostgresDispatchAttemptRepository implements DispatchAttemptRepository {
  private startAuthorizationHookForTest?: () => Promise<void>;

  constructor(private readonly db: Database) {}

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
