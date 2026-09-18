import { describe, expect, it, vi } from "vitest";

import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import type { QualityControlService } from "@/server/usecases/quality-control-service";

/** Durable outbox stand-in: survives across sweeper instances (a "restart"). */
class FakeJobs {
  recoverable: string[] = [];
  wakeups = new Map<string, string[]>(); // missionId -> workflowIds
  listRecoverableMissionIds = async () => [...this.recoverable];
  listWakeupMissionIds = async () => [...this.wakeups.keys()];
  listPendingWakeups = async (missionId: string) => [...(this.wakeups.get(missionId) ?? [])];
  completeWakeups = async (ids: string[]) => {
    for (const [m, list] of this.wakeups) {
      const rest = list.filter((id) => !ids.includes(id));
      if (rest.length) this.wakeups.set(m, rest);
      else this.wakeups.delete(m);
    }
  };
}

const sweeperFor = (
  jobs: FakeJobs,
  wake: (missionId: string) => Promise<unknown>,
  recover: () => Promise<void> = async () => undefined,
) =>
  new QualityControlRecoverySweeper({ recover } as unknown as QualityControlService, jobs, wake);

describe("QualityControlRecoverySweeper durable wake-up", () => {
  it("wakes the mission once the applied action left a pending wake-up, then completes it", async () => {
    const jobs = new FakeJobs();
    jobs.recoverable = ["m1"];
    const wake = vi.fn().mockResolvedValue(null);
    const recover = async () => {
      jobs.wakeups.set("m1", ["wf-1"]); // action applied inside recover()
    };
    const result = await sweeperFor(jobs, wake, recover).sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith("m1");
    expect(jobs.wakeups.size).toBe(0);
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("crash-gap: action applied but process died before wake-up -> restart resumes the mission exactly once", async () => {
    const jobs = new FakeJobs();
    jobs.wakeups.set("m1", ["wf-1"]); // durable state left by the crashed process; nothing else pending

    // Restarted process, first sweep, wake-up transiently fails: stays pending (at-least-once).
    const failing = vi.fn().mockRejectedValue(new Error("boom"));
    const first = await sweeperFor(jobs, failing).sweep();
    expect(first).toMatchObject({ succeeded: 0, failed: 1 });
    expect(jobs.wakeups.get("m1")).toEqual(["wf-1"]);

    // Next sweep succeeds and completes the outbox entry.
    const wake = vi.fn().mockResolvedValue(null);
    await sweeperFor(jobs, wake).sweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(jobs.wakeups.size).toBe(0);

    // No duplication afterwards.
    await sweeperFor(jobs, wake).sweep();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("does not wake when nothing was applied (e.g. review unavailable / cooling down)", async () => {
    const jobs = new FakeJobs();
    jobs.recoverable = ["m1"];
    const wake = vi.fn().mockResolvedValue(null);
    const result = await sweeperFor(jobs, wake).sweep();
    expect(wake).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("treats QUALITY_CONTROL_REPLAN_READY as a wake-up, not a failure", async () => {
    const jobs = new FakeJobs();
    jobs.recoverable = ["m1"];
    const wake = vi.fn().mockResolvedValue(null);
    const recover = async () => {
      jobs.wakeups.set("m1", ["wf-1"]);
      throw new Error("QUALITY_CONTROL_REPLAN_READY");
    };
    const result = await sweeperFor(jobs, wake, recover).sweep();
    expect(wake).toHaveBeenCalledWith("m1");
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("reports a real review error without waking or completing the wake-up", async () => {
    const jobs = new FakeJobs();
    jobs.recoverable = ["m1"];
    const wake = vi.fn().mockResolvedValue(null);
    const recover = async () => {
      throw new Error("QUALITY_CONTROL_REVIEW_FAILED");
    };
    const result = await sweeperFor(jobs, wake, recover).sweep();
    expect(wake).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
  });
});
