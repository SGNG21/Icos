import { describe, expect, it, vi } from "vitest";

import { QualityControlRecoverySweeper } from "@/server/autonomy/quality-control-recovery-sweeper";
import type { QualityControlService } from "@/server/usecases/quality-control-service";

const build = (recover: () => Promise<void>, wake = vi.fn().mockResolvedValue(null)) => ({
  wake,
  sweeper: new QualityControlRecoverySweeper(
    { recover } as unknown as QualityControlService,
    { listRecoverableMissionIds: async () => ["m1"] },
    wake,
  ),
});

describe("QualityControlRecoverySweeper wake-up", () => {
  it("wakes the mission after its quality jobs are processed", async () => {
    const { sweeper, wake } = build(async () => undefined);
    const result = await sweeper.sweep();
    expect(wake).toHaveBeenCalledWith("m1");
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("treats QUALITY_CONTROL_REPLAN_READY as a wake-up, not a failure", async () => {
    const { sweeper, wake } = build(async () => {
      throw new Error("QUALITY_CONTROL_REPLAN_READY");
    });
    const result = await sweeper.sweep();
    expect(wake).toHaveBeenCalledWith("m1");
    expect(result).toMatchObject({ succeeded: 1, failed: 0 });
  });

  it("does not wake and reports failure on a real review error", async () => {
    const { sweeper, wake } = build(async () => {
      throw new Error("QUALITY_CONTROL_REVIEW_FAILED");
    });
    const result = await sweeper.sweep();
    expect(wake).not.toHaveBeenCalled();
    expect(result).toMatchObject({ succeeded: 0, failed: 1 });
  });
});
