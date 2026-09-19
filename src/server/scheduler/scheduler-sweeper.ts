import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";

type Sweeper = { sweep(): Promise<AutonomyRecoverySweepResult> };

/**
 * One lifecycle-managed timer drives both the existing recovery sweeps and the Durable
 * Scheduler. Each side is isolated: a failure of one never hides or blocks the other.
 */
export function sweepWithScheduler(recovery: Sweeper, scheduler: Sweeper): Sweeper {
  return {
    async sweep() {
      const parts: AutonomyRecoverySweepResult[] = [];
      const failures: AutonomyRecoverySweepResult["failures"] = [];
      for (const [name, sweeper] of [
        ["autonomy-recovery", recovery],
        ["durable-scheduler", scheduler],
      ] as const) {
        try {
          parts.push(await sweeper.sweep());
        } catch (error) {
          failures.push({ missionId: name, error });
        }
      }
      return {
        discovered: parts.reduce((n, p) => n + p.discovered, 0),
        attempted: parts.reduce((n, p) => n + p.attempted, 0),
        succeeded: parts.reduce((n, p) => n + p.succeeded, 0),
        failed: parts.reduce((n, p) => n + p.failed, 0) + failures.length,
        failures: [...parts.flatMap((p) => p.failures), ...failures],
      };
    },
  };
}
