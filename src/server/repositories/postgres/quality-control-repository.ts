import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { assertWorkerCapacity } from "./worker-capacity";

import {
  completionForSettlement,
  type IntegrationSettlementPort,
  type QualityAction,
  type QualityControlJob,
  type QualityControlRepository,
  type RegisterQualityControlInput,
  type RegisterQualityControlResult,
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

/** MissionTask statuses of work still in flight: the only ones a settlement may change. */
const IN_FLIGHT = ["queued", "running", "review_pending"] as const;

export class PostgresQualityControlRepository implements QualityControlRepository {
  constructor(
    private readonly db: Database,
    /**
     * Governed integration state (DEFECT 36, decision 0049). Absent: no governed workspace can
     * exist, and review acceptance remains the canonical completion exactly as before.
     */
    private readonly settlement?: IntegrationSettlementPort,
  ) {}

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

      /* In flight only: registering a result never revives a cancelled or settled task (DEFECT 36). */
      await tx
        .update(missionTasks)
        .set({ status: "review_pending", updatedAt: now })
        .where(
          and(
            eq(missionTasks.id, input.missionTaskId),
            eq(missionTasks.missionId, input.missionId),
            inArray(missionTasks.status, [...IN_FLIGHT]),
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
            // `reviewing` with an expired claim = the reviewer process died mid-review (crash recovery).
            inArray(qualityControlJobs.state, [
              "review_pending",
              "reviewing",
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
          /*
           * A FRESH BUDGET PER CYCLE, and the TOTAL bounded by something a retry cannot move.
           *
           * Within a cycle this is monotonic, so MAX_REVIEW_ATTEMPTS is reachable and a
           * cycle always ends. Reclaiming a PARKED review starts a new cycle and resets it
           * to 1 — that reset is what lets a reviewer which comes back finish work parked
           * during its outage.
           *
           * Resetting used to be wrong because nothing else bounded the repetition: 1,2,3,
           * park, reset, 1,2,3, park … for ever. Making it monotonic instead swapped one
           * unbounded shape for another: the first reclaim was already over budget, so the
           * job re-parked immediately and for ever, and the work was never reviewed, never
           * integrated and never escalated. The bound now lives where a retry cannot touch
           * it — the job's `created_at` age, checked by the service before it parks again
           * (REVIEW_LIFETIME_DEADLINE_MS). A budget that resets is fine; a repetition that
           * nothing ends is not.
           */
          reviewAttemptCount: sql`case
            when ${qualityControlJobs.state} = 'review_unavailable' then 1
            when ${qualityControlJobs.state} in ('review_pending','reviewing') then ${qualityControlJobs.reviewAttemptCount} + 1
            else ${qualityControlJobs.reviewAttemptCount} end`,
          /* The retry cycle is observable: a reclaim from parked says so, in the one free-text column. */
          lastError: sql`case when ${qualityControlJobs.state} = 'review_unavailable' then 'QUALITY_CONTROL_REVIEW_RETRY_CYCLE_STARTED' else ${qualityControlJobs.lastError} end`,
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
      workerId?: string;
      routingDecision?: Record<string, unknown>;
      replanReason?: string;
      forceEscalate?: boolean;
    },
  ): Promise<{ job: QualityControlJob; dispatchAcquired: boolean }> {
    /*
     * DEFECT 36 — an APPROVE is not yet a satisfied dependency. For GOVERNED work the canonical
     * completion is the integration: marking the task `succeeded` here let the readiness
     * authority admit its dependents while the work was still only reviewed, so they were built
     * from the pre-integration target. Asked BEFORE the transaction: it reads git, and nothing
     * it answers can be invalidated by this transaction (the job's action is already decided).
     */
    const pending = await this.getByWorkflowId(workflowId);
    const acceptCompletion =
      this.settlement && pending?.action === "ACCEPT" && !input.forceEscalate
        ? completionForSettlement(await this.settlement.settlementOf(workflowId))
        : "succeeded";

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
      /* `null`: ACCEPT recorded, completion deferred to `settleAccepted` (DEFECT 36). */
      const status = action === "ACCEPT" ? acceptCompletion : "failed";
      if ((action === "ACCEPT" || action === "ESCALATE") && status) {
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

        /*
         * M7.1 — a routed retry must obey the SAME capacity rule as a routed dispatch.
         *
         * This INSERT bypasses `prepare()`, so before M7.1 it also bypassed the capacity
         * guard entirely: a retry could hand work to a worker already at its limit, or
         * blow through a shared pool quota, which `prepare()` would have refused. The
         * guard is the extracted shared authority — not a second copy of the rule.
         */
        if (input.workerId) {
          await assertWorkerCapacity(tx, input.workerId, job.missionTaskId);
        }

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
            /* Routed by the caller through the canonical CapabilityRouter (M7.1). */
            workerId: input.workerId ?? null,
            routingDecision: input.routingDecision ?? null,
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
            .where(
              and(
                eq(missionTasks.id, registered[0].missionTaskId),
                inArray(missionTasks.status, [...IN_FLIGHT]),
              ),
            );
        }
      }
      return inserted.length;
    });
  }

  async settleAccepted(missionId?: string): Promise<number> {
    if (!this.settlement) return 0;
    const candidates = await this.db
      .select({
        workflowId: qualityControlJobs.workflowId,
        missionTaskId: qualityControlJobs.missionTaskId,
        taskId: qualityControlJobs.taskId,
      })
      .from(qualityControlJobs)
      .innerJoin(missionTasks, eq(missionTasks.id, qualityControlJobs.missionTaskId))
      .where(
        and(
          eq(qualityControlJobs.action, "ACCEPT"),
          eq(qualityControlJobs.state, "action_applied"),
          inArray(missionTasks.status, [...IN_FLIGHT]),
          missionId ? eq(qualityControlJobs.missionId, missionId) : undefined,
        ),
      );

    let settled = 0;
    for (const candidate of candidates) {
      const status = completionForSettlement(
        await this.settlement.settlementOf(candidate.workflowId),
      );
      if (!status) continue;
      /*
       * One transaction: the terminal status and the durable wake-up (the QC outbox) commit
       * together, so a crash can never leave a settled task whose dependents nobody wakes.
       * The in-flight guard is the exactly-once: a concurrent or repeated sweep updates no row.
       */
      const changed = await this.db.transaction(async (tx) => {
        const updated = await tx
          .update(missionTasks)
          .set({ status, updatedAt: sql`now()` })
          .where(
            and(
              eq(missionTasks.id, candidate.missionTaskId),
              inArray(missionTasks.status, [...IN_FLIGHT]),
            ),
          )
          .returning({ id: missionTasks.id });
        if (updated.length === 0) return false;
        await tx
          .update(tasks)
          .set({ status, updatedAt: sql`now()` })
          .where(eq(tasks.id, candidate.taskId));
        await tx
          .update(qualityControlJobs)
          .set({ wakeupPending: true, updatedAt: sql`now()` })
          .where(eq(qualityControlJobs.workflowId, candidate.workflowId));
        return true;
      });
      if (changed) settled += 1;
    }
    return settled;
  }

  async listRecoverableMissionIds(limit = 100): Promise<string[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("QUALITY_CONTROL_INVALID_RECOVERY_LIMIT");
    }
    // Pending jobs with a free claim, UNION worker results that never got a QC job (crash between the
    // completion callback and the fire-and-forget registration) while their MissionTask is still in flight.
    // The 30 s guard avoids racing the callback route's own registration; `recoverUnregistered` is idempotent.
    const rows = await this.db.execute(sql`
      select mission_id from (
        select mission_id from quality_control_jobs
        where state in ('review_pending','reviewing','decision_ready','review_unavailable')
          and (claim_until is null or claim_until <= now())
        union
        select d.mission_id
        from task_execution_results r
        join dispatch_attempts d on d.workflow_id = r.workflow_id
        join mission_tasks t on t.id = d.mission_task_id
        left join quality_control_jobs q on q.workflow_id = r.workflow_id
        where q.workflow_id is null
          and t.status in ('queued','running','review_pending')
          and r.recorded_at <= now() - interval '30 seconds'
        union
        -- DEFECT 36: an ACCEPT whose integrated settlement has not been observed yet.
        select q.mission_id
        from quality_control_jobs q
        join mission_tasks t on t.id = q.mission_task_id
        where q.action = 'ACCEPT'
          and q.state = 'action_applied'
          and t.status in ('queued','running','review_pending')
      ) recoverable
      order by mission_id
      limit ${limit}
    `);
    return (rows as unknown as Array<{ mission_id: string }>).map((row) => row.mission_id);
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

  /**
   * Jobs that ICOS handed to a human. A SIBLING of `listPending`, deliberately not folded
   * into it: `listPending` is a RECOVERY input — `InMemoryQualityControlRepository`
   * implements `listRecoverableMissionIds` as `listPending() ∪ unsettledAccepted()` and
   * excludes `escalated` for exactly that reason. Widening `listPending` would make the two
   * implementations of one port answer different questions and would put every escalated
   * mission back into the recovery sweep for good.
   *
   * Read-only, for DISPLAY: escalation must be legible to the human it was handed to, or
   * ICOS escalates into silence.
   */
  async listEscalated(missionId?: string): Promise<QualityControlJob[]> {
    const escalated = eq(qualityControlJobs.state, "escalated");
    const rows = await this.db
      .select()
      .from(qualityControlJobs)
      .where(missionId ? and(escalated, eq(qualityControlJobs.missionId, missionId)) : escalated)
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
