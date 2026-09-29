import { sql } from "drizzle-orm";

import type { ScheduledJobRepository } from "@/core/contracts/scheduler";
import type { SupervisorEventInput } from "@/core/supervisor/contracts";
import type { Database } from "@/server/database/client";
import { PermanentJobError, type JobHandler } from "@/server/scheduler/durable-scheduler";
import { nextOccurrenceAt } from "@/server/workers/probes/worker-probe-schedule";

import type { ProactiveSupervisor } from "./proactive-supervisor";

/**
 * Recurring observations (decision 0055) on the CANONICAL durable scheduler — no
 * second scheduler, no setInterval. Same recurrence as `probe_workers` (0037):
 * grid-aligned occurrences keyed by their instant, re-enqueued by the handler,
 * ignited idempotently at boot. The next run lives in `scheduled_jobs`, so a restart
 * loses nothing and N replicas observe once.
 */

export const SUPERVISOR_OBSERVE_JOB_KIND = "supervisor_observe" as const;
/** Floor against uncontrolled high-frequency polling. */
export const MIN_OBSERVATION_INTERVAL_MS = 60_000;

/** A poll-derived source. It reads; it never acts. */
export interface ObservationSource {
  observe(window: { tenantId: string; since: Date; until: Date }): Promise<SupervisorEventInput[]>;
}

export interface ObservationSchedule {
  observationKey: string;
  tenantId: string;
  intervalMs: number;
}

function assertInterval(intervalMs: number): void {
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_OBSERVATION_INTERVAL_MS) {
    throw new Error(
      `SUPERVISOR_OBSERVATION_INTERVAL_TOO_SHORT: ${intervalMs}ms < ${MIN_OBSERVATION_INTERVAL_MS}ms`,
    );
  }
}

export async function enqueueObservation(
  jobs: ScheduledJobRepository,
  schedule: ObservationSchedule,
  at: Date,
): Promise<{ created: boolean }> {
  assertInterval(schedule.intervalMs);
  const key = `${SUPERVISOR_OBSERVE_JOB_KIND}:${schedule.observationKey}:${schedule.tenantId}:${Math.floor(at.getTime() / 1_000)}`;
  const { created } = await jobs.enqueue({
    kind: SUPERVISOR_OBSERVE_JOB_KIND,
    payload: { ...schedule, scheduledFor: at.toISOString() },
    payloadHash: `${key}:${schedule.intervalMs}`,
    idempotencyKey: key,
    runAt: at,
  });
  return { created };
}

/** Ignition: safe on every boot and replica (a live chain already owns the key). */
export async function seedObservation(
  jobs: ScheduledJobRepository,
  schedule: ObservationSchedule,
  now: Date = new Date(),
): Promise<{ created: boolean; at: Date }> {
  assertInterval(schedule.intervalMs);
  const at = nextOccurrenceAt(now, schedule.intervalMs);
  return { ...(await enqueueObservation(jobs, schedule, at)), at };
}

/**
 * Schedule the next occurrence FIRST, then observe → ingest → drain.
 *
 * Unlike `probe_workers`, the successor is enqueued before the work: a source that keeps
 * failing then fails only ITS occurrence (scheduler backoff, then dead) instead of
 * killing the whole recurrence. A retried occurrence overlapping its successor is
 * harmless — ingestion is deduplicated. One malformed observation is rejected on its own;
 * a drain failure is reported, never allowed to stop observing.
 */
export function createObservationHandler(deps: {
  supervisor: ProactiveSupervisor;
  sources: Readonly<Record<string, ObservationSource>>;
  jobs: ScheduledJobRepository;
  now?: () => Date;
}): JobHandler {
  const now = deps.now ?? (() => new Date());
  return async (job, { signal }) => {
    const { observationKey, tenantId, intervalMs, scheduledFor } = job.payload as Record<
      string,
      unknown
    >;
    if (
      typeof observationKey !== "string" ||
      typeof tenantId !== "string" ||
      typeof intervalMs !== "number"
    ) {
      throw new PermanentJobError("SUPERVISOR_OBSERVATION_INVALID_PAYLOAD");
    }
    const source = Object.hasOwn(deps.sources, observationKey)
      ? deps.sources[observationKey]
      : undefined;
    if (!source)
      throw new PermanentJobError(`SUPERVISOR_OBSERVATION_SOURCE_UNKNOWN: ${observationKey}`);

    try {
      await enqueueObservation(
        deps.jobs,
        { observationKey, tenantId, intervalMs },
        nextOccurrenceAt(now(), intervalMs),
      );
    } catch (error) {
      throw new PermanentJobError(
        `SUPERVISOR_OBSERVATION_RESCHEDULE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const until = typeof scheduledFor === "string" ? new Date(scheduledFor) : now();
    // Two intervals of overlap: a late run never leaves a gap; dedup absorbs the overlap.
    const since = new Date(until.getTime() - 2 * intervalMs);
    const observations = await source.observe({ tenantId, since, until });
    let recorded = 0;
    let rejected = 0;
    for (const observation of observations) {
      if (signal.aborted) break; // lease lost: the new owner re-runs this occurrence
      if (observation.tenantId !== tenantId) {
        rejected += 1; // a source cannot write into another tenant
        continue;
      }
      try {
        const result = await deps.supervisor.ingest(observation);
        if (result.status === "RECORDED") recorded += 1;
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("SUPERVISOR_INVALID_EVENT"))) {
          throw error; // infrastructure failure: retry this occurrence
        }
        rejected += 1;
      }
    }
    const drained = await deps.supervisor.drain().catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    return { observed: observations.length, recorded, rejected, drained };
  };
}

const COMPUTE_FAILURES: Record<string, string> = {
  RATE_LIMITED: "PROVIDER_RATE_LIMIT",
  WORKER_CRASHED: "WORKER_CRASH",
};

/**
 * Internal ICOS observation: failed dispatch attempts become compute-health events.
 * The supervisor only NOTICES; route adaptation stays with compute routing (0054),
 * which the default rules encode as `owner: "compute-routing"`.
 */
export class ComputeHealthObservation implements ObservationSource {
  constructor(private readonly db: Database) {}

  async observe(window: {
    tenantId: string;
    since: Date;
    until: Date;
  }): Promise<SupervisorEventInput[]> {
    const rows = (await this.db.execute(sql`
      SELECT id, worker_id, failure_class, mission_id, updated_at
      FROM dispatch_attempts
      WHERE state = 'failed' AND failure_class IN ('RATE_LIMITED', 'WORKER_CRASHED')
        AND updated_at > ${window.since.toISOString()}::timestamptz
        AND updated_at <= ${window.until.toISOString()}::timestamptz
      ORDER BY updated_at ASC
      LIMIT 500`)) as unknown as Array<{
      id: string;
      worker_id: string | null;
      failure_class: string;
      mission_id: string;
      updated_at: Date | string;
    }>;
    return rows.map((row) => ({
      tenantId: window.tenantId,
      source: "icos.dispatch",
      origin: "internal" as const,
      type: COMPUTE_FAILURES[row.failure_class],
      subject: `worker:${row.worker_id ?? "unassigned"}`,
      occurredAt: new Date(row.updated_at),
      payloadRef: `dispatch_attempts:${row.id}`,
      summary: { failureClass: row.failure_class, missionId: row.mission_id },
      dedupKey: `dispatch_attempt:${row.id}`,
    }));
  }
}
