import type { ScheduledJobRepository } from "@/core/contracts/scheduler";
import { PermanentJobError, type JobHandler } from "@/server/scheduler/durable-scheduler";
import { nextOccurrenceAt } from "@/server/workers/probes/worker-probe-schedule";
import type { StartupComputeBootstrapOutcome } from "@/server/workers/startup-compute-bootstrap";

/**
 * PERIODIC COMPUTE FLEET RECONCILIATION (P1 of the ICOS voice diagnosis: « je ne vois pas
 * Claude »).
 *
 * The fleet was reconciled with what OmniRoute serves ONLY AT BOOT. A model the provider began
 * serving after the last restart was therefore invisible to routing until someone restarted the
 * runtime — which reads, from the inside, exactly as "Claude does not exist".
 *
 * WHY THE DURABLE SCHEDULER, NOT A TIMER — same reasoning as `probe_workers` (0045): a
 * `setInterval` runs once PER PROCESS and vanishes on restart. A `scheduled_jobs` occurrence is
 * claimed under a lease, so exactly ONE process reconciles at a time across every replica, and
 * the recurrence survives a restart. The 30 s recovery tick only CONSULTS the table.
 *
 * WHAT IT RUNS — the boot reconciliation, unchanged (`bootstrapComputeFleetAtStartup`):
 * discover → `planComputeBootstrap` → `applyComputeBootstrap`. Every guard therefore applies
 * identically: an unchanged candidate is not rewritten (probe evidence survives), a model that
 * disappears is retired ONLY on its own failing probe evidence, never the last active row nor a
 * mass withdrawal, and an empty or failed discovery retires nothing. A provider outage is an
 * OUTCOME, not an error: the registry is left as it was and the next occurrence tries again.
 *
 * HONORS `ICOS_COMPUTE_BOOTSTRAP`. Off ⇒ never seeded; and an occurrence that fires after the
 * flag was turned off does nothing and schedules no successor, so the chain dies with the flag.
 *
 * BOUNDED FREQUENCY: default 5 min, refused outside [1 min, 1 h].
 */

export const COMPUTE_RECONCILE_JOB_KIND = "reconcile_compute_fleet" as const;

export const DEFAULT_COMPUTE_RECONCILE_INTERVAL_MS = 5 * 60_000;
export const MIN_COMPUTE_RECONCILE_INTERVAL_MS = 60_000;
export const MAX_COMPUTE_RECONCILE_INTERVAL_MS = 60 * 60_000;

/** Resolves the interval. Seed and handler MUST agree, or they build two grids. */
export function resolveComputeReconcileIntervalMs(intervalMs?: number): number {
  const resolved = intervalMs ?? DEFAULT_COMPUTE_RECONCILE_INTERVAL_MS;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_COMPUTE_RECONCILE_INTERVAL_MS ||
    resolved > MAX_COMPUTE_RECONCILE_INTERVAL_MS
  ) {
    throw new Error(
      `COMPUTE_RECONCILE_INTERVAL_INVALID: ${resolved}ms (allowed ${MIN_COMPUTE_RECONCILE_INTERVAL_MS}..${MAX_COMPUTE_RECONCILE_INTERVAL_MS})`,
    );
  }
  return resolved;
}

/** The idempotency key of one occurrence: its exact second on the shared grid. */
function occurrenceKey(at: Date): string {
  return `${COMPUTE_RECONCILE_JOB_KIND}:${Math.floor(at.getTime() / 1_000)}`;
}

/** Enqueues one occurrence. Idempotent per scheduled second: two callers, one job. */
export async function enqueueComputeFleetReconciliation(
  jobs: ScheduledJobRepository,
  at: Date,
): Promise<{ created: boolean }> {
  const { created } = await jobs.enqueue({
    kind: COMPUTE_RECONCILE_JOB_KIND,
    payload: { scheduledFor: at.toISOString() },
    payloadHash: occurrenceKey(at),
    idempotencyKey: occurrenceKey(at),
    runAt: at,
  });
  return { created };
}

/**
 * Ignites the recurrence: the next GRID occurrence, so every replica and every restart computes
 * the same key and a live chain makes this a no-op.
 */
export async function seedComputeFleetReconciliation(
  jobs: ScheduledJobRepository,
  options: { intervalMs?: number; now?: () => Date } = {},
): Promise<{ created: boolean; at: Date }> {
  const intervalMs = resolveComputeReconcileIntervalMs(options.intervalMs);
  const at = nextOccurrenceAt((options.now ?? (() => new Date()))(), intervalMs);
  const { created } = await enqueueComputeFleetReconciliation(jobs, at);
  return { created, at };
}

export interface ComputeFleetReconcileHandlerDeps {
  /** The canonical reconciliation (production: `bootstrapComputeFleetAtStartup`). */
  reconcile: () => Promise<StartupComputeBootstrapOutcome>;
  /** `ICOS_COMPUTE_BOOTSTRAP`, read at run time. */
  enabled: () => boolean;
  jobs: ScheduledJobRepository;
  intervalMs?: number;
  now?: () => Date;
}

/**
 * The `reconcile_compute_fleet` handler: reconcile, then schedule the next occurrence.
 *
 * The successor is enqueued AFTER the work on purpose (as `probe_workers`): if reconciling
 * throws, the scheduler retries THIS job with its backoff rather than a successor quietly
 * abandoning the failure. A lost successor is a PERMANENT error — a dead job is visible, a
 * silently stopped reconciliation is not.
 */
export function createComputeFleetReconcileHandler(
  deps: ComputeFleetReconcileHandlerDeps,
): JobHandler {
  const intervalMs = resolveComputeReconcileIntervalMs(deps.intervalMs);
  const now = deps.now ?? (() => new Date());

  return async () => {
    if (!deps.enabled()) return { status: "DISABLED" } satisfies StartupComputeBootstrapOutcome;

    const outcome = await deps.reconcile();

    try {
      await enqueueComputeFleetReconciliation(deps.jobs, nextOccurrenceAt(now(), intervalMs));
    } catch (error) {
      throw new PermanentJobError(
        `COMPUTE_RECONCILE_RESCHEDULE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return outcome;
  };
}
