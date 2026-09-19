import { eq, sql } from "drizzle-orm";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  type EnqueueScheduledJobInput,
  type ScheduledJob,
  type ScheduledJobKind,
  type ScheduledJobRepository,
  type ScheduledJobState,
} from "@/core/contracts/scheduler";
import type { Database } from "@/server/database/client";
import { scheduledJobs } from "@/server/database/schema";

type Row = typeof scheduledJobs.$inferSelect;

function mapJob(row: Row): ScheduledJob {
  return {
    id: row.id,
    kind: row.kind as ScheduledJobKind,
    payload: row.payload,
    payloadHash: row.payloadHash,
    idempotencyKey: row.idempotencyKey,
    state: row.state as ScheduledJobState,
    priority: row.priority,
    nextRunAt: row.nextRunAt,
    deadlineAt: row.deadlineAt ?? undefined,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    backoffBaseMs: row.backoffBaseMs,
    leaseOwner: row.leaseOwner ?? undefined,
    leaseUntil: row.leaseUntil ?? undefined,
    lastError: row.lastError ?? undefined,
    missionId: row.missionId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  };
}

/**
 * Durable Scheduler sur PostgreSQL (ADR-0025). Toutes les comparaisons de temps
 * utilisent `now()` de la base : une seule horloge, pas de dérive entre processus.
 */
export class PostgresScheduledJobRepository implements ScheduledJobRepository {
  constructor(private readonly db: Database) {}

  async enqueue(input: EnqueueScheduledJobInput): Promise<{ job: ScheduledJob; created: boolean }> {
    const inserted = await this.db
      .insert(scheduledJobs)
      .values({
        id: crypto.randomUUID(),
        kind: input.kind,
        payload: input.payload,
        payloadHash: input.payloadHash,
        idempotencyKey: input.idempotencyKey,
        state: "scheduled",
        priority: input.priority ?? 0,
        nextRunAt: input.runAt ?? sql`now()`,
        deadlineAt: input.deadlineAt ?? null,
        maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        backoffBaseMs: input.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
        missionId: input.missionId ?? null,
      })
      .onConflictDoNothing({ target: scheduledJobs.idempotencyKey })
      .returning();
    if (inserted[0]) return { job: mapJob(inserted[0]), created: true };

    const existing = await this.db
      .select()
      .from(scheduledJobs)
      .where(eq(scheduledJobs.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!existing[0]) throw new Error("SCHEDULER_ENQUEUE_INVARIANT_VIOLATED");
    if (existing[0].kind !== input.kind || existing[0].payloadHash !== input.payloadHash) {
      throw new Error("SCHEDULER_IDEMPOTENCY_CONFLICT");
    }
    return { job: mapJob(existing[0]), created: false };
  }

  async claimDue(owner: string, leaseMs: number): Promise<ScheduledJob | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("SCHEDULER_INVALID_LEASE");
    return this.db.transaction(async (tx) => {
      // Deadline passed: never run it.
      await tx.execute(sql`
        UPDATE scheduled_jobs
        SET state = 'expired', lease_owner = NULL, lease_until = NULL,
            last_error = 'SCHEDULER_DEADLINE_PASSED', completed_at = now(), updated_at = now()
        WHERE deadline_at IS NOT NULL AND deadline_at <= now()
          AND ((state = 'scheduled' AND next_run_at <= now())
            OR (state = 'running' AND lease_until <= now()))`);

      for (;;) {
        const candidates = await tx.execute(sql`
          SELECT id, state, attempt_count, max_attempts
          FROM scheduled_jobs
          WHERE (state = 'scheduled' AND next_run_at <= now())
             OR (state = 'running' AND lease_until <= now())
          ORDER BY priority DESC, next_run_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1`);
        const candidate = candidates[0] as
          | { id: string; state: string; attempt_count: number; max_attempts: number }
          | undefined;
        if (!candidate) return null;

        if (candidate.state === "running" && candidate.attempt_count >= candidate.max_attempts) {
          // Crash loop: every claim consumed an attempt, stop here (no infinite retry).
          await tx.execute(sql`
            UPDATE scheduled_jobs
            SET state = 'dead', lease_owner = NULL, lease_until = NULL, completed_at = now(),
                last_error = 'SCHEDULER_MAX_ATTEMPTS_EXCEEDED: lease expired after the last attempt',
                updated_at = now()
            WHERE id = ${candidate.id}`);
          continue;
        }

        const claimed = await tx
          .update(scheduledJobs)
          .set({
            state: "running",
            attemptCount: sql`${scheduledJobs.attemptCount} + 1`,
            leaseOwner: owner,
            leaseUntil: sql`now() + (${leaseMs} * interval '1 millisecond')`,
            updatedAt: sql`now()`,
          })
          .where(eq(scheduledJobs.id, candidate.id))
          .returning();
        return mapJob(claimed[0]);
      }
    });
  }

  async renewLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const rows = await this.db.execute(sql`
      UPDATE scheduled_jobs
      SET lease_until = now() + (${leaseMs} * interval '1 millisecond'), updated_at = now()
      WHERE id = ${id} AND state = 'running' AND lease_owner = ${owner}
      RETURNING id`);
    return rows.length === 1;
  }

  async complete(id: string, owner: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      UPDATE scheduled_jobs
      SET state = 'succeeded', lease_owner = NULL, lease_until = NULL,
          completed_at = now(), updated_at = now()
      WHERE id = ${id} AND state = 'running' AND lease_owner = ${owner}
      RETURNING id`);
    return rows.length === 1;
  }

  async fail(
    id: string,
    owner: string,
    error: string,
    options: { retryable: boolean },
  ): Promise<{ ok: boolean; state?: ScheduledJobState }> {
    const rows = await this.db.execute(sql`
      UPDATE scheduled_jobs
      SET state = CASE WHEN ${options.retryable} AND attempt_count < max_attempts
                       THEN 'scheduled' ELSE 'dead' END,
          next_run_at = CASE WHEN ${options.retryable} AND attempt_count < max_attempts
                             THEN now() + (least(backoff_base_ms::double precision * power(2, attempt_count - 1),
                                                 ${MAX_BACKOFF_MS}::double precision) * interval '1 millisecond')
                             ELSE next_run_at END,
          completed_at = CASE WHEN ${options.retryable} AND attempt_count < max_attempts
                              THEN NULL ELSE now() END,
          lease_owner = NULL, lease_until = NULL, last_error = ${error}, updated_at = now()
      WHERE id = ${id} AND state = 'running' AND lease_owner = ${owner}
      RETURNING state`);
    const row = rows[0] as { state: ScheduledJobState } | undefined;
    return row ? { ok: true, state: row.state } : { ok: false };
  }

  async getById(id: string): Promise<ScheduledJob | null> {
    const rows = await this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, id)).limit(1);
    return rows[0] ? mapJob(rows[0]) : null;
  }
}
