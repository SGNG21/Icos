import { QualityControlService } from "@/server/usecases/quality-control-service";

export interface QualityControlRecoveryResult {
  discovered: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: Array<{ missionId: string; error: unknown }>;
}

/**
 * Recovers quality work left at result-before-review, decision-before-action,
 * or an expired processing claim. Per-job row locks remain the arbiter.
 */
export class QualityControlRecoverySweeper {
  constructor(
    private readonly qualityControl: QualityControlService,
    private readonly missionIds: { listRecoverableMissionIds(limit?: number): Promise<string[]> },
    /**
     * Resumes the mission once its quality jobs are settled. A `waiting`
     * runtime is never picked up by the autonomy sweeper, so without this an
     * accepted/corrected/replanned task would never advance the mission.
     */
    private readonly wakeMission?: (missionId: string) => Promise<unknown>,
  ) {}

  async sweep(limit = 100): Promise<QualityControlRecoveryResult> {
    const missionIds = await this.missionIds.listRecoverableMissionIds(limit);
    const failures: Array<{ missionId: string; error: unknown }> = [];
    let succeeded = 0;
    for (const missionId of missionIds) {
      try {
        try {
          await this.qualityControl.recover(missionId);
        } catch (error) {
          // A requested replan is a wake-up signal, not a failure.
          if (!(error instanceof Error && error.message === "QUALITY_CONTROL_REPLAN_READY")) {
            throw error;
          }
        }
        await this.wakeMission?.(missionId);
        succeeded += 1;
      } catch (error) {
        failures.push({ missionId, error });
      }
    }
    return {
      discovered: missionIds.length,
      attempted: missionIds.length,
      succeeded,
      failed: failures.length,
      failures,
    };
  }
}
