import { sql } from "drizzle-orm";

import type {
  RecoveryDispatchRef,
  RecoveryScanner,
  RecoveryScanOptions,
  WaitingSettledCandidate,
} from "@/core/contracts/recovery";
import type { Database } from "@/server/database/client";

const TERMINAL_MISSION = sql`('succeeded','failed','blocked','cancelled')`;
const ACTIVE_TASK = sql`('queued','running','review_pending','awaiting_approval')`;
const ACTIVE_ATTEMPT = sql`('prepared','dispatched')`;
const TERMINAL_TASK = sql`('succeeded','failed','blocked','cancelled','superseded')`;

/**
 * When this mission's work last moved. Falls back to the runtime's start so a mission
 * that never planned a task still ages, instead of being excluded for ever by a null.
 */
const SETTLED_SINCE = sql`coalesce(
        (select max(t.updated_at) from mission_tasks t where t.mission_id = r.mission_id),
        r.started_at
      )`;

function positiveInt(value: number, code: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(code);
  return value;
}

type DispatchRow = {
  id: string;
  mission_id: string;
  mission_task_id: string;
  task_id: string;
  workflow_id: string;
  attempt: number;
};

const toRef = (row: DispatchRow): RecoveryDispatchRef => ({
  id: row.id,
  missionId: row.mission_id,
  missionTaskId: row.mission_task_id,
  taskId: row.task_id,
  workflowId: row.workflow_id,
  attempt: row.attempt,
});

/**
 * Détection des orphelins (ADR-0027 §5). Requêtes bornées, en lecture seule, calculées à chaque appel :
 * aucun état en mémoire. Horloge unique : `now()` PostgreSQL. Aucun prompt ni résultat n'est sélectionné.
 */
export class PostgresRecoveryScanner implements RecoveryScanner {
  constructor(private readonly db: Database) {}

  async listSettledWaiting({
    limit,
    olderThanMs,
  }: RecoveryScanOptions): Promise<WaitingSettledCandidate[]> {
    const grace = sql`(${positiveInt(olderThanMs, "RECOVERY_INVALID_AGE")} * interval '1 millisecond')`;
    const rows = await this.db.execute(sql`
      select r.mission_id, ${SETTLED_SINCE} as settled_since
      from autonomous_mission_runtime r
      join missions m on m.id = r.mission_id
      /*
       * A SEMANTIC trigger: this asks whether the WORK is over, never whether a row looks
       * stale.
       *
       * It used to require that the runtime row had not been touched for the grace
       * period. That could not work, because the sweep's own wake-up writes exactly that
       * column: the age it measured was the age of the last sweep, so it reset on every
       * pass and the key derived from it made a fresh recovery unit each time, whose
       * attempt budget therefore never ran down.
       *
       * NOT just 'waiting' either. Keyed on the runtime state alone this missed the case
       * that actually leaks: a runtime that ESCALATED or FAILED while the mission row was
       * still draft and no task was active. Nothing re-ran the supervisor, the mission
       * never reached a terminal state, releaseDelegation never fired, and its brains
       * stayed occupied -- five live missions sat exactly that way, one for sixteen days.
       */
      where r.state in ('waiting', 'escalated', 'failed')
        and m.status not in ${TERMINAL_MISSION}
        /* No live runner owns it: an owner reconciles the mission itself. */
        and (r.owner_token is null or r.lease_until is null or r.lease_until <= now())
        /* Nothing is still being worked on, reviewed, or waiting on a human. */
        and not exists (
          select 1 from mission_tasks t
          where t.mission_id = r.mission_id and t.status in ${ACTIVE_TASK}
        )
        /*
         * And no execution is still in flight ON WORK THAT IS NOT FINISHED. A leftover
         * intent against an already-terminal task is bookkeeping for the reaper, not a
         * running worker: a single pre-invariant dispatched row with no lease -- which
         * nothing can reclaim -- would otherwise hold its mission out of reconciliation
         * for ever, trading one stranded mission for another.
         */
        and not exists (
          select 1 from dispatch_attempts d
          join mission_tasks dt on dt.id = d.mission_task_id
          where d.mission_id = r.mission_id
            and d.state in ${ACTIVE_ATTEMPT}
            and dt.status not in ${TERMINAL_TASK}
        )
        /* Quiet since the work itself last moved -- a clock the sweep does not touch. */
        and ${SETTLED_SINCE} <= now() - ${grace}
      order by ${SETTLED_SINCE} asc
      limit ${positiveInt(limit, "RECOVERY_INVALID_LIMIT")}
    `);
    return (rows as unknown as Array<{ mission_id: string; settled_since: Date }>).map((row) => ({
      missionId: row.mission_id,
      settledSince: new Date(row.settled_since),
    }));
  }

  async listStalePrepared({
    limit,
    olderThanMs,
  }: RecoveryScanOptions): Promise<RecoveryDispatchRef[]> {
    const rows = await this.db.execute(sql`
      select d.id, d.mission_id, d.mission_task_id, d.task_id, d.workflow_id, d.attempt
      from dispatch_attempts d
      join missions m on m.id = d.mission_id
      where d.state = 'prepared'
        and m.status not in ${TERMINAL_MISSION}
        and (d.claim_until is null or d.claim_until <= now())
        -- A live runtime owner reconciles prepared dispatches itself on every cycle.
        and not exists (
          select 1 from autonomous_mission_runtime r
          where r.mission_id = d.mission_id and r.owner_token is not null and r.lease_until > now()
        )
        and d.updated_at <= now() - (${positiveInt(olderThanMs, "RECOVERY_INVALID_AGE")} * interval '1 millisecond')
      order by d.created_at asc, d.id asc
      limit ${positiveInt(limit, "RECOVERY_INVALID_LIMIT")}
    `);
    return (rows as unknown as DispatchRow[]).map(toRef);
  }

  async listOrphanedDispatched({
    limit,
    olderThanMs,
  }: RecoveryScanOptions): Promise<RecoveryDispatchRef[]> {
    // Only the authoritative (latest) attempt of a still in-flight task, with no persisted worker result.
    const rows = await this.db.execute(sql`
      select d.id, d.mission_id, d.mission_task_id, d.task_id, d.workflow_id, d.attempt
      from dispatch_attempts d
      join missions m on m.id = d.mission_id
      join mission_tasks t on t.id = d.mission_task_id
      where d.state = 'dispatched'
        and m.status not in ${TERMINAL_MISSION}
        and t.status in ('queued','running')
        and coalesce(d.dispatched_at, d.updated_at) <= now() - (${positiveInt(olderThanMs, "RECOVERY_INVALID_AGE")} * interval '1 millisecond')
        and not exists (select 1 from task_execution_results r where r.workflow_id = d.workflow_id)
        and d.attempt = (select max(x.attempt) from dispatch_attempts x where x.mission_task_id = d.mission_task_id)
      order by d.created_at asc, d.id asc
      limit ${positiveInt(limit, "RECOVERY_INVALID_LIMIT")}
    `);
    return (rows as unknown as DispatchRow[]).map(toRef);
  }

  /**
   * M7 — abandoned EXTERNAL WORKER executions (decision 0039).
   *
   * The signal is the EXECUTION LEASE, not a workflow probe. A live runner renews its
   * lease; a runner that died cannot, so an expired lease on a still-`dispatched`
   * attempt is positive evidence that nobody is executing it any more. That is what
   * makes this recoverable where `listOrphanedDispatched` could only defer: a
   * process-based worker has no Temporal workflow to ask about.
   *
   * An attempt nobody ever leased was never picked up by an external worker, so there is
   * no death to infer; it belongs to the prepared/orphan scans instead. NOTE, honestly:
   * the two `is not null` guards below are LEGIBILITY, not enforcement — a NULL
   * `execution_lease_until` already fails the comparison under SQL's three-valued logic,
   * and removing both guards changes no test. They are kept so the intent survives a
   * future refactor that might wrap that comparison in a `coalesce` and silently start
   * admitting never-leased attempts.
   *
   * `olderThanMs` is applied ON TOP of lease expiry, so a lease that has only just
   * lapsed gets a grace period before being declared abandoned. A runner finishing a
   * long commit must not be reclaimed out from under itself.
   */
  async listAbandonedExecutions({
    limit,
    olderThanMs,
  }: RecoveryScanOptions): Promise<RecoveryDispatchRef[]> {
    const rows = await this.db.execute(sql`
      select d.id, d.mission_id, d.mission_task_id, d.task_id, d.workflow_id, d.attempt
      from dispatch_attempts d
      join missions m on m.id = d.mission_id
      join mission_tasks t on t.id = d.mission_task_id
      where d.state = 'dispatched'
        and m.status not in ${TERMINAL_MISSION}
        and t.status in ('queued','running')
        -- An external worker really did take this attempt (redundant with the
        -- comparison below under three-valued logic; kept as intent — see the doc).
        and d.execution_lease_owner is not null
        -- ...and its runner can no longer be alive, plus a grace period.
        and d.execution_lease_until is not null
        and d.execution_lease_until <= now() - (${positiveInt(olderThanMs, "RECOVERY_INVALID_AGE")} * interval '1 millisecond')
        -- A real result already landed: nothing was lost, nothing to reclaim.
        and not exists (select 1 from task_execution_results r where r.workflow_id = d.workflow_id)
        -- Only the authoritative (latest) attempt of the task.
        and d.attempt = (select max(x.attempt) from dispatch_attempts x where x.mission_task_id = d.mission_task_id)
      order by d.execution_lease_until asc, d.id asc
      limit ${positiveInt(limit, "RECOVERY_INVALID_LIMIT")}
    `);
    return (rows as unknown as DispatchRow[]).map(toRef);
  }
}
