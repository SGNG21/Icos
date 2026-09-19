import { describe, expect, it, vi } from "vitest";

import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";
import { sweepWithScheduler } from "@/server/scheduler/scheduler-sweeper";

const result = (o: Partial<AutonomyRecoverySweepResult> = {}): AutonomyRecoverySweepResult => ({
  discovered: 0,
  attempted: 0,
  succeeded: 0,
  failed: 0,
  failures: [],
  ...o,
});

describe("sweepWithScheduler", () => {
  it("runs the recovery sweep then the scheduler and merges both results", async () => {
    const order: string[] = [];
    const sweeper = sweepWithScheduler(
      { sweep: async () => (order.push("recovery"), result({ discovered: 2, attempted: 2, succeeded: 2 })) },
      { sweep: async () => (order.push("scheduler"), result({ discovered: 1, attempted: 1, succeeded: 1 })) },
    );
    expect(await sweeper.sweep()).toMatchObject({ discovered: 3, attempted: 3, succeeded: 3, failed: 0 });
    expect(order).toEqual(["recovery", "scheduler"]);
  });

  it("a failing scheduler never hides the recovery result", async () => {
    const error = new Error("db blip");
    const merged = await sweepWithScheduler(
      { sweep: async () => result({ discovered: 1, attempted: 1, succeeded: 1 }) },
      { sweep: vi.fn().mockRejectedValue(error) },
    ).sweep();
    expect(merged).toMatchObject({ succeeded: 1, failed: 1 });
    expect(merged.failures).toEqual([{ missionId: "durable-scheduler", error }]);
  });

  it("a failing recovery sweep never prevents the scheduler from running", async () => {
    const scheduler = { sweep: vi.fn().mockResolvedValue(result({ discovered: 1, attempted: 1, succeeded: 1 })) };
    const merged = await sweepWithScheduler(
      { sweep: vi.fn().mockRejectedValue(new Error("recovery down")) },
      scheduler,
    ).sweep();
    expect(scheduler.sweep).toHaveBeenCalledTimes(1);
    expect(merged).toMatchObject({ succeeded: 1, failed: 1 });
    expect(merged.failures[0].missionId).toBe("autonomy-recovery");
  });
});
