import { randomUUID } from "node:crypto";

import type { ScheduledJob, ScheduledJobKind, ScheduledJobRepository } from "@/core/contracts/scheduler";
import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";

export type JobHandler = (job: ScheduledJob, context: { signal: AbortSignal }) => Promise<unknown>;

/** Throw from a handler when retrying cannot help: the job is marked `dead` immediately. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

export interface DurableSchedulerOptions {
  /** Lease per claim. Default 2 min. */
  leaseMs?: number;
  /** Lease renewal period while a handler runs. Default leaseMs / 3. */
  heartbeatMs?: number;
  /** Upper bound of jobs handled by one sweep. Default 10. */
  maxJobsPerSweep?: number;
}

/**
 * Executor of the Durable Scheduler (ADR-0025). It owns no state: every sweep asks
 * PostgreSQL for the next due job (atomic claim + lease), runs the handler for its
 * kind, then settles the job with the per-claim token (fencing). Timers only trigger
 * `sweep()`; they are never the source of truth. `sweep()` fits the shape expected by
 * `AutonomyRecoveryScheduler`, so the existing lifecycle-managed timer drives it.
 */
export class DurableScheduler {
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly maxJobsPerSweep: number;

  constructor(
    private readonly jobs: ScheduledJobRepository,
    private readonly handlers: Partial<Record<ScheduledJobKind, JobHandler>>,
    options: DurableSchedulerOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 120_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1, Math.floor(this.leaseMs / 3));
    this.maxJobsPerSweep = options.maxJobsPerSweep ?? 10;
  }

  async sweep(): Promise<AutonomyRecoverySweepResult> {
    const failures: AutonomyRecoverySweepResult["failures"] = [];
    let discovered = 0;
    let succeeded = 0;

    for (let i = 0; i < this.maxJobsPerSweep; i++) {
      const owner = `scheduler-${randomUUID()}`; // unique per claim = fencing token
      const job = await this.jobs.claimDue(owner, this.leaseMs);
      if (!job) break;
      discovered += 1;
      try {
        if (await this.execute(job, owner)) succeeded += 1;
      } catch (error) {
        failures.push({ missionId: job.missionId ?? job.id, error });
      }
    }

    return { discovered, attempted: discovered, succeeded, failed: failures.length, failures };
  }

  /** Returns true when the job was settled as succeeded by this claim. */
  private async execute(job: ScheduledJob, owner: string): Promise<boolean> {
    const handler = this.handlers[job.kind];
    if (!handler) {
      await this.jobs.fail(job.id, owner, `SCHEDULER_NO_HANDLER: ${job.kind}`, { retryable: false });
      throw new Error(`SCHEDULER_NO_HANDLER: ${job.kind}`);
    }

    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      this.jobs
        .renewLease(job.id, owner, this.leaseMs)
        .then((stillOwner) => {
          if (!stillOwner) abort.abort(new Error("SCHEDULER_LEASE_LOST"));
        })
        .catch(() => undefined); // transient DB error: the next tick or the lease expiry decides
    }, this.heartbeatMs);

    try {
      await handler(job, { signal: abort.signal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobs.fail(job.id, owner, message.slice(0, 500), {
        retryable: !(error instanceof PermanentJobError),
      });
      throw error;
    } finally {
      clearInterval(heartbeat);
    }

    // false => the lease was reclaimed meanwhile: the new owner settles the job.
    return this.jobs.complete(job.id, owner);
  }
}
