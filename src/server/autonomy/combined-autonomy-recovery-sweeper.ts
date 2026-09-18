import type {
  AutonomyRecoverySweepResult,
  AutonomyRecoverySweeper,
} from "@/server/autonomy/autonomy-recovery-sweeper";
import type {
  QualityControlRecoveryResult,
  QualityControlRecoverySweeper,
} from "@/server/autonomy/quality-control-recovery-sweeper";

export interface CombinedAutonomyRecoveryResult extends AutonomyRecoverySweepResult {
  quality: QualityControlRecoveryResult;
}

/** Keeps one lifecycle timer while recovering both mission runtimes and quality jobs. */
export class CombinedAutonomyRecoverySweeper {
  constructor(
    private readonly autonomy: Pick<AutonomyRecoverySweeper, "sweep">,
    private readonly quality: Pick<QualityControlRecoverySweeper, "sweep">,
  ) {}

  async sweep(limit = 100): Promise<CombinedAutonomyRecoveryResult> {
    const quality = await this.quality.sweep(limit);
    const autonomy = await this.autonomy.sweep(limit);
    return { ...autonomy, quality };
  }
}
