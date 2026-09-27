import type { ScheduledJobRepository } from "@/core/contracts/scheduler";
import { HEALTH_EVIDENCE_MAX_AGE_MS } from "@/core/workers/worker-eligibility";
import type { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { PermanentJobError, type JobHandler } from "@/server/scheduler/durable-scheduler";

/**
 * The autonomous probe sweep (M6, second half of defect 16).
 *
 * M6.1 gave the fleet a REAL probe; nothing called it. A probe nobody runs is a
 * probe that does not exist: without a caller every worker's evidence expires and
 * the whole fleet is permanently ineligible — correct, and useless.
 *
 * WHY THE DURABLE SCHEDULER AND NOT A TIMER
 * A `setInterval` would run once PER PROCESS (so N replicas probe the same fleet N
 * times) and would vanish on restart. The durable scheduler (ADR-0025) already
 * solves both: PostgreSQL holds the next run time, and a claim + lease means
 * exactly one process sweeps at a time. Timers only trigger a consultation of the
 * table; they are never the source of truth.
 *
 * RECURRENCE IS SELF-PERPETUATING AND IDEMPOTENT
 * The handler re-enqueues the NEXT occurrence, keyed by the instant it is due. The
 * scheduler is at-least-once, so a replay must be harmless: probing twice is
 * harmless by construction (a probe is an observation, not a mutation of work), and
 * the re-enqueue is deduplicated by idempotency key. Two sweeps racing produce one
 * next occurrence, not two.
 *
 * IGNITION IS SEPARATE FROM RECURRENCE
 * A self-perpetuating chain still needs a first link. Nothing enqueues the first
 * sweep on its own, so `seedWorkerProbeSweep` is called at process start — the same
 * defect-16 trap one level up: a recurrence nobody ignites never runs at all.
 * Occurrences are snapped to a grid (see `nextOccurrenceAt`) precisely so that
 * seeding is idempotent: every restart and every replica computes the same key, so
 * ignition can be unconditional instead of needing to ask whether a chain is alive.
 */

export const WORKER_PROBE_JOB_KIND = "probe_workers" as const;

/**
 * Default interval, DERIVED from the evidence horizon rather than chosen.
 *
 * Probing must be several times more frequent than expiry or healthy workers
 * flicker out between sweeps. Deriving it means the two can never drift apart
 * when someone tunes the horizon.
 */
export const DEFAULT_WORKER_PROBE_INTERVAL_MS = Math.floor(HEALTH_EVIDENCE_MAX_AGE_MS / 4);

/**
 * Refuses an interval that cannot keep evidence fresh.
 *
 * An interval at or above the horizon means evidence is always stale by the time
 * the next sweep runs, so the fleet is permanently ineligible in a way that looks
 * like a routing bug. The configuration is wrong; say so at composition time
 * instead of quietly running a fleet that can never take work.
 */
export function assertProbeIntervalWithinHorizon(
  intervalMs: number,
  horizonMs: number = HEALTH_EVIDENCE_MAX_AGE_MS,
): void {
  if (intervalMs <= 0 || !Number.isFinite(intervalMs)) {
    throw new Error(`WORKER_PROBE_INTERVAL_INVALID: ${intervalMs}`);
  }
  if (intervalMs >= horizonMs) {
    throw new Error(
      `WORKER_PROBE_INTERVAL_EXCEEDS_HORIZON: ${intervalMs}ms >= ${horizonMs}ms — health evidence would always be stale`,
    );
  }
}

/** The idempotency key of one scheduled occurrence: its exact second. */
function occurrenceKey(at: Date): string {
  return `${WORKER_PROBE_JOB_KIND}:${Math.floor(at.getTime() / 1_000)}`;
}

/** Resolves the effective interval. Seed and handler MUST agree or they build two grids. */
export function resolveProbeIntervalMs(intervalMs?: number): number {
  const resolved = intervalMs ?? DEFAULT_WORKER_PROBE_INTERVAL_MS;
  assertProbeIntervalWithinHorizon(resolved);
  return resolved;
}

/**
 * The next occurrence, SNAPPED TO A GLOBAL GRID of `intervalMs` since the epoch.
 *
 * Alignment is what makes the recurrence self-healing instead of self-duplicating.
 * `now + interval` would be relative to whoever computed it, so a restart or a
 * second replica would mint an occurrence a few seconds off the live chain's, with
 * a different idempotency key — two chains probing forever, and neither able to
 * detect the other. On a shared grid every process computes the SAME instant and
 * therefore the SAME key, so a duplicate is refused by the database instead.
 *
 * ponytail: the grid is derived from the interval, so all replicas must share one
 * ICOS_WORKER_PROBE_INTERVAL_MS. Mismatched config yields one chain per distinct
 * interval; a `kind`-scoped pending query would close that, at the cost of a new
 * repository contract method.
 */
export function nextOccurrenceAt(now: Date, intervalMs: number): Date {
  const bucket = Math.floor(now.getTime() / intervalMs) + 1;
  return new Date(bucket * intervalMs);
}

/**
 * Enqueues one probe sweep occurrence. Idempotent per scheduled second, so
 * calling it twice for the same instant yields one job.
 */
export async function enqueueWorkerProbeSweep(
  jobs: ScheduledJobRepository,
  at: Date,
): Promise<{ created: boolean }> {
  const { created } = await jobs.enqueue({
    kind: WORKER_PROBE_JOB_KIND,
    payload: { scheduledFor: at.toISOString() },
    payloadHash: occurrenceKey(at),
    idempotencyKey: occurrenceKey(at),
    runAt: at,
  });

  return { created };
}

export interface WorkerProbeHandlerDeps {
  prober: WorkerHealthProber;
  jobs: ScheduledJobRepository;
  intervalMs?: number;
  now?: () => Date;
}

/**
 * The `probe_workers` handler: sweep, then schedule the next sweep.
 *
 * The re-enqueue happens AFTER the sweep on purpose. If the sweep throws, the
 * scheduler retries THIS job with its own backoff rather than this handler quietly
 * scheduling a successor and abandoning the failure — one recurrence chain, not
 * two, and a failing fleet stays visible as a failing job.
 */
export function createWorkerProbeHandler(deps: WorkerProbeHandlerDeps): JobHandler {
  const intervalMs = resolveProbeIntervalMs(deps.intervalMs);
  const now = deps.now ?? (() => new Date());

  return async () => {
    const report = await deps.prober.sweep();

    const next = nextOccurrenceAt(now(), intervalMs);
    try {
      await enqueueWorkerProbeSweep(deps.jobs, next);
    } catch (error) {
      /*
       * Losing the recurrence silently would stop all probing until an operator
       * noticed a fleet that refuses every task. Make it a permanent job error so
       * it surfaces as a dead job rather than as mysterious idleness.
       */
      throw new PermanentJobError(
        `WORKER_PROBE_RESCHEDULE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return report;
  };
}

/**
 * Ignites the recurrence: enqueues the next grid occurrence if it does not exist.
 *
 * Safe to call unconditionally on every boot and from every replica. Because the
 * instant is grid-aligned, a live chain already owns that idempotency key and this
 * is a no-op (`created: false`); if the chain was never started, or died, this is
 * the link that restarts it. It targets a FUTURE occurrence, so it can never
 * collide with an already-completed one and mistake it for a live chain.
 */
export async function seedWorkerProbeSweep(
  jobs: ScheduledJobRepository,
  options: { intervalMs?: number; now?: () => Date } = {},
): Promise<{ created: boolean; at: Date }> {
  const intervalMs = resolveProbeIntervalMs(options.intervalMs);
  const at = nextOccurrenceAt((options.now ?? (() => new Date()))(), intervalMs);
  const { created } = await enqueueWorkerProbeSweep(jobs, at);
  return { created, at };
}
