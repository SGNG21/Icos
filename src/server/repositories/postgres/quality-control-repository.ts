import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";

import type {
  QualityAction,
  QualityControlJob,
  QualityControlRepository,
  RegisterQualityControlInput,
  RegisterQualityControlResult,
} from "@/core/contracts/quality-control";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { Database } from "@/server/database/client";
import {
  autonomousMissionRuntime,
  decisions,
  dispatchAttempts,
  missionTasks,
  qualityControlJobs,
  taskExecutionResults,
  tasks,
} from "@/server/database/schema";
import { reviewDecisionToRow } from "@/server/database/mappers";

function mapJob(row: typeof qualityControlJobs.$inferSelect): QualityControlJob {
  return {
    workflowId: row.workflowId,
    executionResultId: row.executionResultId,
    missionId: row.missionId,
    missionTaskId: row.missionTaskId,
    taskId: row.taskId,
    executionAttempt: row.executionAttempt,
    reviewAttemptCount: row.reviewAttemptCount,
    state: row.state as QualityControlJob["state"],
    reviewDecisionId: row.reviewDecisionId ?? undefined,
    action: (row.action as QualityAction | null) ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    claimToken: row.claimToken ?? undefined,
    claimUntil: row.claimUntil ?? undefined,
    lastError: row.lastError ?? undefined,
    wakeupPending: row.wakeupPending,
  };
}

export class PostgresQualityControlRepository implements QualityControlRepository {
  constructor(private readonly db: Database) {}

  async register(input: RegisterQualityControlInput): Promise<RegisterQualityControlResult> {
    return this.db.transaction(async (tx) => {
      const correlated = await tx
        .select({
          resultId: taskExecutionResults.id,
          resultTaskId: taskExecutionResults.taskId,
          attemptMissionId: dispatchAttempts.missionId,
          attemptMissionTaskId: dispatchAttempts.missionTaskId,
          attemptTaskId: dispatchAttempts.taskId,
          attemptNumber: dispatchAttempts.attempt,
          missionTaskMissionId: missionTasks.missionId,
          missionTaskTaskId: missionTasks.taskId,
        })
        .from(taskExecutionResults)
        .innerJoin(
          dispatchAttempts,
          eq(dispatchAttempts.workflowId, taskExecutionResults.workflowId),
        )
        .innerJoin(missionTasks, eq(missionTasks.id, dispatchAttempts.missionTaskId))
        .where(eq(taskExecutionResults.workflowId, input.workflowId))
        .limit(1);
      const row = correlated[0];
      if (
        !row ||
        row.resultId !== input.executionResultId ||
        row.resultTaskId !== input.taskId ||
        row.attemptMissionId !== input.missionId ||
        row.attemptMissionTaskId !== input.missionTaskId ||
        row.attemptTaskId !== input.taskId ||
        row.attemptNumber !== input.executionAttempt ||
        row.missionTaskMissionId !== input.missionId ||
        row.missionTaskTaskId !== input.taskId
      ) {
        throw new Error("QUALITY_CONTROL_EXECUTION_CORRELATION_FAILED");
      }

      const now = new Date();
      const inserted = await tx
        .insert(qualityControlJobs)
        .values({
          ...input,
          reviewAttemptCount: 0,
          state: "review_pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const acquired = inserted.length === 1;
      const rows = acquired
        ? inserted
        : await tx
            .select()
            .from(qualityControlJobs)
            .where(eq(qualityControlJobs.workflowId, input.workflowId))
            .limit(1);
      const job = rows[0];
      if (!job) throw new Error("QUALITY_CONTROL_REGISTER_RACE");
      this.assertSameIdentity(mapJob(job), input);

      await tx
        .update(missionTasks)
        .set({ status: "review_pending", updatedAt: now })
        .where(
          and(
            eq(missionTasks.id, input.missionTaskId),
            eq(missionTasks.missionId, input.missionId),
          ),
        );
      return { job: mapJob(job), acquired };
    });
  }

  async claimNext(
    missionId: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<QualityControlJob | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("QUALITY_CONTROL_INVALID_LEASE");
    }
    const rows = await this.db.transaction(async (tx) => {
      const candidates = await tx
        .select({ workflowId: qualityControlJobs.workflowId })
        .from(qualityControlJobs)
        .where(
          and(
            eq(qualityControlJobs.missionId, missionId),
            inArray(qualityControlJobs.state, [
              "review_pending",
              "review_unavailable",
              "decision_ready",
            ]),
            or(
              isNull(qualityControlJobs.claimUntil),
              lte(qualityControlJobs.claimUntil, sql`now()`),
            ),
          ),
        )
        .orderBy(asc(qualityControlJobs.createdAt), asc(qualityControlJobs.workflowId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidates[0]) return [];
      return tx
        .update(qualityControlJobs)
        .set({
          state: sql`case when ${qualityControlJobs.state} in ('review_pending','review_unavailable') then 'reviewing' else ${qualityControlJobs.state} end`,
          // A recovered unavailable review gets a fresh review budget.
          reviewAttemptCount: sql`case when ${qualityControlJobs.state} = 'review_unavailable' then 1 when ${qualityControlJobs.state} = 'review_pending' then ${qualityControlJobs.reviewAttemptCount} + 1 else ${qualityControlJobs.reviewAttemptCount} end`,
          claimToken: ownerToken,
          claimUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
          updatedAt: sql`now()`,
        })
        .where(eq(qualityControlJobs.workflowId, candidates[0].workflowId))
        .returning();
    });
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async saveDecision(
    workflowId: string,
    ownerToken: string,
    input: { review: ReviewDecisionRecord; action: QualityAction },
  ): Promise<QualityControlJob> {
    return this.db.transaction(async (tx) => {
      const job = await this.lockOwned(tx, workflowId, ownerToken);
      if (job.state === "decision_ready") {
        if (job.reviewDecisionId !== input.review.id || job.action !== input.action) {
          throw new Error("QUALITY_CONTROL_DECISION_CONFLICT");
        }
        return job;
      }
      if (job.state !== "reviewing") throw new Error("QUALITY_CONTROL_INVALID_DECISION_STATE");
      if (input.review.workflowId !== workflowId || input.review.taskId !== job.taskId) {
        throw new Error("QUALITY_CONTROL_REVIEW_CORRELATION_FAILED");
      }
      await tx.insert(decisions).values(reviewDecisionToRow(input.review)).onConflictDoNothing();
      const persisted = await tx
        .select({ id: decisions.id, taskId: decisions.taskId })
        .from(decisions)
        .where(eq(decisions.workflowId, workflowId))
        .limit(1);
      if (persisted[0]?.id !== input.review.id || persisted[0].taskId !== job.taskId) {
        throw new Error("QUALITY_CONTROL_DECISION_CONFLICT");
      }
      const updated = await tx
        .update(qualityControlJobs)
        .set({
          state: "decision_ready",
          reviewDecisionId: input.review.id,
          action: input.action,
          updatedAt: sql`now()`,
        })
        .where(eq(qualityControlJobs.workflowId, workflowId))
        .returning();
      return mapJob(updated[0]);
    });
  }

  async applyAction(
    workflowId: string,
    ownerToken: string,
    input: {
      nextAttempt?: number;
      nextWorkflowId?: string;
      prompt?: string;
      replanReason?: string;
      forceEscalate?: boolean;
    },
  ): Promise<{ job: QualityControlJob; dispatchAcquired: boolean }> {
    return this.db.transaction(async (tx) => {
      const job = await this.lockOwned(tx, workflowId, ownerToken);
      if (job.state === "action_applied" || job.state === "escalated") {
        return { job, dispatchAcquired: false };
      }
      if (job.state !== "decision_ready" || !job.action) {
        throw new Error("QUALITY_CONTROL_ACTION_NOT_READY");
      }

      const action = input.forceEscalate ? "ESCALATE" : job.action;
      let dispatchAcquired = false;
      if (action === "ACCEPT" || action === "ESCALATE") {
        const status = action === "ACCEPT" ? "succeeded" : "failed";
        await tx
          .update(missionTasks)
          .set({ status, updatedAt: sql`now()` })
          .where(
            and(eq(missionTasks.id, job.missionTaskId), eq(missionTasks.missionId, job.missionId)),
          );
        await tx
          .update(tasks)
          .set({ status, updatedAt: sql`now()` })
          .where(eq(tasks.id, job.taskId));
      } else if (action === "CORRECT" || action === "RETRY") {
        if (!input.nextAttempt || !input.nextWorkflowId || !input.prompt) {
          throw new Error("QUALITY_CONTROL_ATTEMPT_INPUT_MISSING");
        }
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${job.missionTaskId}, 0))`,
        );
        const previous = await tx
          .select({
            workerKind: dispatchAttempts.workerKind,
            capability: dispatchAttempts.capability,
          })
          .from(dispatchAttempts)
          .where(eq(dispatchAttempts.workflowId, workflowId))
          .limit(1);
        const inserted = await tx
          .insert(dispatchAttempts)
          .values({
            id: input.nextWorkflowId,
            missionId: job.missionId,
            missionTaskId: job.missionTaskId,
            taskId: job.taskId,
            attempt: input.nextAttempt,
            workflowId: input.nextWorkflowId,
            prompt: input.prompt,
            workerKind: previous[0]?.workerKind ?? null,
            capability: previous[0]?.capability ?? null,
            state: "prepared",
            createdAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .onConflictDoNothing()
          .returning({ id: dispatchAttempts.id });
        dispatchAcquired = inserted.length === 1;
        const attempt = await tx
          .select()
          .from(dispatchAttempts)
          .where(eq(dispatchAttempts.workflowId, input.nextWorkflowId))
          .limit(1);
        if (
          attempt[0]?.missionTaskId !== job.missionTaskId ||
          attempt[0]?.taskId !== job.taskId ||
          attempt[0]?.attempt !== input.nextAttempt ||
          attempt[0]?.prompt !== input.prompt
        ) {
          throw new Error("QUALITY_CONTROL_ATTEMPT_CONFLICT");
        }
        if (inserted.length === 1) {
          await tx
            .update(dispatchAttempts)
            .set({
              state: "failed",
              lastError: "DISPATCH_ATTEMPT_SUPERSEDED",
              updatedAt: sql`now()`,
              claimToken: null,
              claimUntil: null,
            })
            .where(
              and(
                eq(dispatchAttempts.missionTaskId, job.missionTaskId),
                sql`${dispatchAttempts.attempt} < ${input.nextAttempt}`,
                or(
                  eq(dispatchAttempts.state, "prepared"),
                  eq(dispatchAttempts.state, "dispatched"),
                ),
              ),
            );
        }
        await tx
          .update(missionTasks)
          .set({ status: "queued", updatedAt: sql`now()` })
          .where(eq(missionTasks.id, job.missionTaskId));
        await tx
          .update(tasks)
          .set({ status: "queued", updatedAt: sql`now()` })
          .where(eq(tasks.id, job.taskId));
      } else if (action === "REPLAN") {
        if (!input.replanReason) throw new Error("QUALITY_CONTROL_REPLAN_REASON_MISSING");
        const runtime = await tx
          .select()
          .from(autonomousMissionRuntime)
          .where(eq(autonomousMissionRuntime.missionId, job.missionId))
          .limit(1)
          .for("update");
        if (!runtime[0]) throw new Error("QUALITY_CONTROL_REPLAN_RUNTIME_NOT_FOUND");
        if (runtime[0].replanCount >= runtime[0].maxReplans) {
          await tx
            .update(missionTasks)
            .set({ status: "failed", updatedAt: sql`now()` })
            .where(eq(missionTasks.id, job.missionTaskId));
          await tx
            .update(tasks)
            .set({ status: "failed", updatedAt: sql`now()` })
            .where(eq(tasks.id, job.taskId));
          input.forceEscalate = true;
        } else {
          // Phase 6: supersede the reviewed task (obsolete graph) durably
          // before entering replanning so the subsequent atomic replacePlan()
          // does not reject it as active work. Idempotent with replacePlan.
          await tx
            .update(missionTasks)
            .set({ status: "superseded", updatedAt: sql`now()` })
            .where(eq(missionTasks.id, job.missionTaskId));
          await tx
            .update(autonomousMissionRuntime)
            .set({
              state: "replanning",
              lastReason: input.replanReason,
              updatedAt: sql`now()`,
              lastHeartbeatAt: sql`now()`,
            })
            .where(eq(autonomousMissionRuntime.missionId, job.missionId));
        }
      }

      const terminalState =
        action === "ESCALATE" || input.forceEscalate ? "escalated" : "action_applied";
      const updated = await tx
        .update(qualityControlJobs)
        .set({
          state: terminalState,
          action: action === "ESCALATE" || input.forceEscalate ? "ESCALATE" : action,
          claimToken: null,
          claimUntil: null,
          lastError: input.forceEscalate
            ? (input.replanReason ?? "QUALITY_CONTROL_BUDGET_EXHAUSTED")
            : null,
          // Durable outbox: same transaction as the applied action.
          wakeupPending: true,
          updatedAt: sql`now()`,
        })
        .where(eq(qualityControlJobs.workflowId, workflowId))
        .returning();
      return { job: mapJob(updated[0]), dispatchAcquired };
    });
  }

  async releaseForRetry(workflowId: string, ownerToken: string, errorCode: string): Promise<void> {
    const updated = await this.db
      .update(qualityControlJobs)
      .set({
        state: sql`case when ${qualityControlJobs.reviewDecisionId} is null then 'review_pending' else 'decision_ready' end`,
        claimToken: null,
        claimUntil: null,
        lastError: errorCode,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(qualityControlJobs.workflowId, workflowId),
          eq(qualityControlJobs.claimToken, ownerToken),
          sql`${qualityControlJobs.claimUntil} > now()`,
        ),
      )
      .returning({ workflowId: qualityControlJobs.workflowId });
    if (updated.length !== 1) throw new Error("QUALITY_CONTROL_OWNERSHIP_LOST");
  }

  async escalateOwned(workflowId: string, ownerToken: string, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const job = await this.lockOwned(tx, workflowId, ownerToken);
      await tx
        .update(missionTasks)
        .set({ status: "failed", updatedAt: sql`now()` })
        .where(eq(missionTasks.id, job.missionTaskId));
      await tx
        .update(tasks)
        .set({ status: "failed", updatedAt: sql`now()` })
        .where(eq(tasks.id, job.taskId));
      await tx
        .update(qualityControlJobs)
        .set({
          state: "escalated",
          action: "ESCALATE",
          claimToken: null,
          claimUntil: null,
          lastError: reason,
          wakeupPending: true,
          updatedAt: sql`now()`,
        })
        .where(eq(qualityControlJobs.workflowId, workflowId));
    });
  }

  async markReviewUnavailable(
    workflowId: string,
    ownerToken: string,
    reason: string,
    cooldownMs: number,
  ): Promise<void> {
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) {
      throw new Error("QUALITY_CONTROL_INVALID_COOLDOWN");
    }
    await this.db.transaction(async (tx) => {
      await this.lockOwned(tx, workflowId, ownerToken);
      // Only the QC job changes: the worker result and task state stay as is.
      await tx
        .update(qualityControlJobs)
        .set({
          state: "review_unavailable",
          claimToken: null,
          claimUntil: sql`now() + (${cooldownMs} * interval '1 millisecond')`,
          lastError: reason,
          updatedAt: sql`now()`,
        })
        .where(eq(qualityControlJobs.workflowId, workflowId));
    });
  }

  async listWakeupMissionIds(limit = 100): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ missionId: qualityControlJobs.missionId })
      .from(qualityControlJobs)
      .where(eq(qualityControlJobs.wakeupPending, true))
      .orderBy(asc(qualityControlJobs.missionId))
      .limit(limit);
    return rows.map((row) => row.missionId);
  }

  async listPendingWakeups(missionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ workflowId: qualityControlJobs.workflowId })
      .from(qualityControlJobs)
      .where(
        and(eq(qualityControlJobs.missionId, missionId), eq(qualityControlJobs.wakeupPending, true)),
      );
    return rows.map((row) => row.workflowId);
  }

  async completeWakeups(workflowIds: string[]): Promise<void> {
    if (workflowIds.length === 0) return;
    await this.db
      .update(qualityControlJobs)
      .set({ wakeupPending: false })
      .where(inArray(qualityControlJobs.workflowId, workflowIds));
  }

  async recoverUnregistered(missionId?: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO quality_control_jobs (
          workflow_id,
          execution_result_id,
          mission_id,
          mission_task_id,
          task_id,
          execution_attempt,
          review_attempt_count,
          state,
          created_at,
          updated_at
        )
        SELECT
          r.workflow_id,
          r.id,
          d.mission_id,
          d.mission_task_id,
          d.task_id,
          d.attempt,
          0,
          'review_pending',
          r.recorded_at,
          now()
        FROM task_execution_results r
        JOIN dispatch_attempts d ON d.workflow_id = r.workflow_id
        LEFT JOIN quality_control_jobs q ON q.workflow_id = r.workflow_id
        WHERE q.workflow_id IS NULL
          AND (${missionId ?? null}::text IS NULL OR d.mission_id = ${missionId ?? null})
        ON CONFLICT DO NOTHING
        RETURNING workflow_id
      `);
      for (const row of inserted) {
        const workflowId = String((row as { workflow_id: unknown }).workflow_id);
        const registered = await tx
          .select({ missionTaskId: qualityControlJobs.missionTaskId })
          .from(qualityControlJobs)
          .where(eq(qualityControlJobs.workflowId, workflowId))
          .limit(1);
        if (registered[0]) {
          await tx
            .update(missionTasks)
            .set({ status: "review_pending", updatedAt: sql`now()` })
            .where(eq(missionTasks.id, registered[0].missionTaskId));
        }
      }
      return inserted.length;
    });
  }

  async listRecoverableMissionIds(limit = 100): Promise<string[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("QUALITY_CONTROL_INVALID_RECOVERY_LIMIT");
    }
    const rows = await this.db
      .selectDistinct({ missionId: qualityControlJobs.missionId })
      .from(qualityControlJobs)
      .where(
        and(
          inArray(qualityControlJobs.state, [
            "review_pending",
            "reviewing",
            "decision_ready",
            "review_unavailable",
          ]),
          or(isNull(qualityControlJobs.claimUntil), lte(qualityControlJobs.claimUntil, sql`now()`)),
        ),
      )
      .orderBy(asc(qualityControlJobs.missionId))
      .limit(limit);
    return rows.map((row) => row.missionId);
  }

  async getByWorkflowId(workflowId: string): Promise<QualityControlJob | null> {
    const rows = await this.db
      .select()
      .from(qualityControlJobs)
      .where(eq(qualityControlJobs.workflowId, workflowId))
      .limit(1);
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async listPending(missionId?: string): Promise<QualityControlJob[]> {
    const pending = inArray(qualityControlJobs.state, [
      "review_pending",
      "reviewing",
      "decision_ready",
      "review_unavailable",
    ]);
    const rows = await this.db
      .select()
      .from(qualityControlJobs)
      .where(missionId ? and(pending, eq(qualityControlJobs.missionId, missionId)) : pending)
      .orderBy(asc(qualityControlJobs.createdAt), asc(qualityControlJobs.workflowId));
    return rows.map(mapJob);
  }

  private async lockOwned(
    tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
    workflowId: string,
    ownerToken: string,
  ): Promise<QualityControlJob> {
    const rows = await tx
      .select()
      .from(qualityControlJobs)
      .where(
        and(
          eq(qualityControlJobs.workflowId, workflowId),
          eq(qualityControlJobs.claimToken, ownerToken),
          sql`${qualityControlJobs.claimUntil} > now()`,
        ),
      )
      .limit(1)
      .for("update");
    if (!rows[0]) throw new Error("QUALITY_CONTROL_OWNERSHIP_LOST");
    return mapJob(rows[0]);
  }

  private assertSameIdentity(
    existing: QualityControlJob,
    input: RegisterQualityControlInput,
  ): void {
    if (
      existing.executionResultId !== input.executionResultId ||
      existing.missionId !== input.missionId ||
      existing.missionTaskId !== input.missionTaskId ||
      existing.taskId !== input.taskId ||
      existing.executionAttempt !== input.executionAttempt
    ) {
      throw new Error("QUALITY_CONTROL_EXECUTION_CONFLICT");
    }
  }
}
