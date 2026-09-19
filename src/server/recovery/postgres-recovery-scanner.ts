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
    const rows = await this.db.execute(sql`
      select r.mission_id, r.updated_at
      from autonomous_mission_runtime r
      join missions m on m.id = r.mission_id
      where r.state = 'waiting'
        and m.status not in ${TERMINAL_MISSION}
        and (r.owner_token is null or r.lease_until is null or r.lease_until <= now())
        and r.updated_at <= now() - (${positiveInt(olderThanMs, "RECOVERY_INVALID_AGE")} * interval '1 millisecond')
        and not exists (
          select 1 from mission_tasks t
          where t.mission_id = r.mission_id and t.status in ${ACTIVE_TASK}
        )
      order by r.updated_at asc
      limit ${positiveInt(limit, "RECOVERY_INVALID_LIMIT")}
    `);
    return (rows as unknown as Array<{ mission_id: string; updated_at: Date }>).map((row) => ({
      missionId: row.mission_id,
      runtimeUpdatedAt: new Date(row.updated_at),
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
}
