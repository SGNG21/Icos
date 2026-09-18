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
 * or an expired processing claim, and delivers the durable mission wake-ups
 * (outbox: `wakeup_pending`, set atomically with the applied action). A wake-up
 * is completed only after the mission was effectively woken, so a crash between
 * "action applied" and "mission woken" is resumed by the next sweep.
 * Per-job row locks remain the arbiter; waking is idempotent (runner lease).
 */
export interface QualityControlRecoveryJobs {
  listRecoverableMissionIds(limit?: number): Promise<string[]>;
  listWakeupMissionIds(limit?: number): Promise<string[]>;
  listPendingWakeups(missionId: string): Promise<string[]>;
  completeWakeups(workflowIds: string[]): Promise<void>;
}

export class QualityControlRecoverySweeper {
  constructor(
    private readonly qualityControl: QualityControlService,
    private readonly jobs: QualityControlRecoveryJobs,
    private readonly wakeMission?: (missionId: string) => Promise<unknown>,
  ) {}

  async sweep(limit = 100): Promise<QualityControlRecoveryResult> {
    const missionIds = [
      ...new Set([
        ...(await this.jobs.listRecoverableMissionIds(limit)),
        ...(await this.jobs.listWakeupMissionIds(limit)),
      ]),
    ];
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
        const pending = await this.jobs.listPendingWakeups(missionId);
        if (pending.length > 0) {
          await this.wakeMission?.(missionId);
          await this.jobs.completeWakeups(pending);
        }
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
