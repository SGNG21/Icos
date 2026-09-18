import { describe, expect, it, vi } from "vitest";

import {
  AutonomyRecoveryScheduler,
  type AutonomyRecoverySchedulerTimer,
} from "@/server/autonomy/autonomy-recovery-scheduler";
import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";

const successfulSweepResult: AutonomyRecoverySweepResult = {
  discovered: 0,
  attempted: 0,
  succeeded: 0,
  failed: 0,
  failures: [],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

class ManualSchedulerTimer implements AutonomyRecoverySchedulerTimer {
  private nowMs = 0;

  private nextId = 1;

  private readonly scheduled = new Map<number, { callback: () => void; runAtMs: number }>();

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, {
      callback,
      runAtMs: this.nowMs + delayMs,
    });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.scheduled.delete(handle);
    }
  };

  pendingCount(): number {
    return this.scheduled.size;
  }

  async advanceBy(delayMs: number): Promise<void> {
    const targetMs = this.nowMs + delayMs;

    for (;;) {
      const next = [...this.scheduled.entries()]
        .filter(([, scheduled]) => scheduled.runAtMs <= targetMs)
        .sort((a, b) => a[1].runAtMs - b[1].runAtMs || a[0] - b[0])[0];

      if (!next) {
        break;
      }

      const [id, scheduled] = next;
      this.nowMs = scheduled.runAtMs;
      this.scheduled.delete(id);
      scheduled.callback();
      await Promise.resolve();
    }

    this.nowMs = targetMs;
    await Promise.resolve();
  }
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("AutonomyRecoveryScheduler", () => {
  it("invokes the existing sweeper on the configured schedule", async () => {
    const timer = new ManualSchedulerTimer();
    const sweep = vi.fn().mockResolvedValue(successfulSweepResult);
    const scheduler = new AutonomyRecoveryScheduler({ sweep }, { intervalMs: 1_000, timer });

    scheduler.start();

    expect(sweep).not.toHaveBeenCalled();
    expect(timer.pendingCount()).toBe(1);

    await timer.advanceBy(999);
    expect(sweep).not.toHaveBeenCalled();

    await timer.advanceBy(1);
    expect(sweep).toHaveBeenCalledTimes(1);

    await flushPromises();
    expect(timer.pendingCount()).toBe(1);

    await timer.advanceBy(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("never overlaps sweeps and schedules the next interval after settlement", async () => {
    const timer = new ManualSchedulerTimer();
    const firstSweep = deferred<AutonomyRecoverySweepResult>();
    const sweep = vi
      .fn()
      .mockImplementationOnce(() => firstSweep.promise)
      .mockResolvedValue(successfulSweepResult);
    const scheduler = new AutonomyRecoveryScheduler({ sweep }, { intervalMs: 100, timer });

    scheduler.start();
    await timer.advanceBy(100);

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(timer.pendingCount()).toBe(0);

    await timer.advanceBy(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    firstSweep.resolve(successfulSweepResult);
    await flushPromises();

    expect(timer.pendingCount()).toBe(1);

    await timer.advanceBy(99);
    expect(sweep).toHaveBeenCalledTimes(1);

    await timer.advanceBy(1);
    expect(sweep).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("observes a rejected sweep and continues scheduling", async () => {
    const timer = new ManualSchedulerTimer();
    const failure = new Error("RECOVERY_SWEEP_FAILED");
    const onSweepError = vi.fn();
    const sweep = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(successfulSweepResult);
    const scheduler = new AutonomyRecoveryScheduler(
      { sweep },
      { intervalMs: 50, timer, onSweepError },
    );

    scheduler.start();
    await timer.advanceBy(50);
    await flushPromises();

    expect(onSweepError).toHaveBeenCalledTimes(1);
    expect(onSweepError).toHaveBeenCalledWith(failure);
    expect(timer.pendingCount()).toBe(1);

    await timer.advanceBy(50);

    expect(sweep).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });

  it("observes resolved per-mission failures and continues scheduling", async () => {
    const timer = new ManualSchedulerTimer();
    const failure = {
      missionId: "mission-failed",
      error: new Error("RECOVERY_WAKE_FAILED"),
    };
    const failedResult = {
      discovered: 2,
      attempted: 2,
      succeeded: 1,
      failed: 1,
      failures: [failure],
    };
    const successfulResult = {
      discovered: 1,
      attempted: 1,
      succeeded: 1,
      failed: 0,
      failures: [],
    };
    const onSweepError = vi.fn();
    const onSweepFailures = vi.fn();
    const sweep = vi.fn().mockResolvedValueOnce(failedResult).mockResolvedValue(successfulResult);
    const scheduler = new AutonomyRecoveryScheduler(
      { sweep },
      { intervalMs: 50, timer, onSweepError, onSweepFailures },
    );

    scheduler.start();
    await timer.advanceBy(50);
    await flushPromises();

    expect(onSweepFailures).toHaveBeenCalledTimes(1);
    expect(onSweepFailures).toHaveBeenCalledWith(failedResult);
    expect(onSweepError).not.toHaveBeenCalled();
    expect(timer.pendingCount()).toBe(1);

    await timer.advanceBy(50);
    await flushPromises();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(onSweepFailures).toHaveBeenCalledTimes(1);
    expect(onSweepError).not.toHaveBeenCalled();

    await scheduler.stop();
  });

  it("stops scheduling new work and waits for an active sweep", async () => {
    const timer = new ManualSchedulerTimer();
    const activeSweep = deferred<AutonomyRecoverySweepResult>();
    const sweep = vi.fn().mockImplementation(() => activeSweep.promise);
    const scheduler = new AutonomyRecoveryScheduler({ sweep }, { intervalMs: 100, timer });

    scheduler.start();
    await timer.advanceBy(100);

    const stopPromise = scheduler.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });

    await flushPromises();
    expect(stopped).toBe(false);
    expect(timer.pendingCount()).toBe(0);

    await timer.advanceBy(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);

    activeSweep.resolve(successfulSweepResult);
    await stopPromise;

    expect(stopped).toBe(true);
    expect(timer.pendingCount()).toBe(0);

    await timer.advanceBy(1_000);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("treats duplicate start and stop calls idempotently", async () => {
    const timer = new ManualSchedulerTimer();
    const sweep = vi.fn().mockResolvedValue(successfulSweepResult);
    const scheduler = new AutonomyRecoveryScheduler({ sweep }, { intervalMs: 100, timer });

    scheduler.start();
    scheduler.start();

    expect(timer.pendingCount()).toBe(1);

    await timer.advanceBy(100);
    expect(sweep).toHaveBeenCalledTimes(1);

    await Promise.all([scheduler.stop(), scheduler.stop()]);
    expect(timer.pendingCount()).toBe(0);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "fails closed for invalid interval %s",
    (intervalMs) => {
      expect(() => new AutonomyRecoveryScheduler({ sweep: vi.fn() }, { intervalMs })).toThrow(
        "AUTONOMY_RECOVERY_SCHEDULER_INVALID_INTERVAL",
      );
    },
  );
});
