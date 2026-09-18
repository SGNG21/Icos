import type {
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

export interface AutonomyRecoveryWakeup {
  wake(
    missionId: string,
  ): Promise<unknown>;
}

export interface AutonomyRecoveryFailure {
  missionId: string;
  error: unknown;
}

export interface AutonomyRecoverySweepResult {
  discovered: number;
  attempted: number;
  succeeded: number;
  failed: number;
  failures: AutonomyRecoveryFailure[];
}

/**
 * Detects abandoned autonomous runtimes and asks the canonical
 * wakeup path to resume them.
 *
 * Important:
 * - this sweeper never owns the mission runtime lease;
 * - AutonomousMissionRunner.claim() remains the execution arbiter;
 * - one failed recovery must not prevent later candidates.
 */
export class AutonomyRecoverySweeper {
  constructor(
    private readonly runtimeRepository:
      Pick<
        AutonomousMissionRuntimeRepository,
        "listRecoverable"
      >,
    private readonly wakeup:
      AutonomyRecoveryWakeup,
  ) {}

  async sweep(
    limit = 100,
  ): Promise<
    AutonomyRecoverySweepResult
  > {
    const runtimes =
      await this.runtimeRepository
        .listRecoverable(limit);

    const failures:
      AutonomyRecoveryFailure[] = [];

    let succeeded = 0;

    for (
      const runtime
      of runtimes
    ) {
      try {
        await this.wakeup.wake(
          runtime.missionId,
        );

        succeeded += 1;
      } catch (error) {
        failures.push({
          missionId:
            runtime.missionId,
          error,
        });
      }
    }

    return {
      discovered:
        runtimes.length,
      attempted:
        runtimes.length,
      succeeded,
      failed:
        failures.length,
      failures,
    };
  }
}
