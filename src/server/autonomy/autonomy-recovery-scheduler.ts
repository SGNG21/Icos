import type {
  AutonomyRecoverySweeper,
  AutonomyRecoverySweepResult,
} from "@/server/autonomy/autonomy-recovery-sweeper";

export interface AutonomyRecoverySchedulerTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutonomyRecoverySchedulerOptions {
  intervalMs: number;
  timer?: AutonomyRecoverySchedulerTimer;
  onSweepError?: (error: unknown) => void;
  onSweepFailures?: (result: AutonomyRecoverySweepResult) => void;
}

const SYSTEM_TIMER: AutonomyRecoverySchedulerTimer = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Lifecycle-managed trigger for the canonical recovery sweeper.
 *
 * The scheduler only discovers and requests recovery. Runtime claim/lease
 * arbitration remains exclusively inside AutonomousMissionRunner.
 */
export class AutonomyRecoveryScheduler {
  private readonly intervalMs: number;
  private readonly timer: AutonomyRecoverySchedulerTimer;
  private readonly onSweepError: (error: unknown) => void;
  private readonly onSweepFailures: (result: AutonomyRecoverySweepResult) => void;

  private running = false;
  private stopped = false;
  private scheduled: unknown;
  private activeSweep: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly sweeper: Pick<AutonomyRecoverySweeper, "sweep">,
    options: AutonomyRecoverySchedulerOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("AUTONOMY_RECOVERY_SCHEDULER_INVALID_INTERVAL");
    }

    this.intervalMs = options.intervalMs;
    this.timer = options.timer ?? SYSTEM_TIMER;
    this.onSweepError =
      options.onSweepError ?? ((error) => console.error("Autonomy recovery sweep failed", error));
    this.onSweepFailures =
      options.onSweepFailures ??
      ((result) =>
        console.error("Autonomy recovery sweep completed with mission failures", result.failures));
  }

  start(): void {
    if (this.running) {
      return;
    }

    if (this.stopped) {
      throw new Error("AUTONOMY_RECOVERY_SCHEDULER_STOPPING");
    }

    this.running = true;
    this.scheduleNext();
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopped = true;
    this.running = false;

    if (this.scheduled !== undefined) {
      this.timer.clearTimeout(this.scheduled);
      this.scheduled = undefined;
    }

    const activeSweep = this.activeSweep;
    this.stopPromise = activeSweep ? activeSweep.then(() => undefined) : Promise.resolve();

    return this.stopPromise;
  }

  private scheduleNext(): void {
    if (!this.running || this.scheduled !== undefined || this.activeSweep) {
      return;
    }

    this.scheduled = this.timer.setTimeout(() => {
      this.scheduled = undefined;

      if (!this.running) {
        return;
      }

      this.runSweep();
    }, this.intervalMs);
  }

  private runSweep(): void {
    let sweepPromise: Promise<AutonomyRecoverySweepResult>;

    try {
      sweepPromise = Promise.resolve(this.sweeper.sweep());
    } catch (error) {
      sweepPromise = Promise.reject(error);
    }

    this.activeSweep = sweepPromise
      .then((result) => {
        if (result.failures.length === 0) {
          return;
        }

        try {
          this.onSweepFailures(result);
        } catch (observerError) {
          console.error("Autonomy recovery sweep failure observer failed", observerError);
        }
      })
      .catch((error: unknown) => {
        try {
          this.onSweepError(error);
        } catch (observerError) {
          console.error("Autonomy recovery sweep error observer failed", observerError);
        }
      })
      .finally(() => {
        this.activeSweep = null;
        this.scheduleNext();
      });
  }
}
