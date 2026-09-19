import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";

type Sweeper = { sweep(): Promise<AutonomyRecoverySweepResult> };

/**
 * Enchaîne des sweepers derrière UN seul timer de cycle de vie. Chacun est isolé : l'échec (exception) de
 * l'un n'empêche jamais les autres, et il est rapporté sous son nom.
 */
export function sweepAll(
  entries: ReadonlyArray<readonly [name: string, sweeper: Sweeper]>,
): Sweeper {
  return {
    async sweep() {
      const total: AutonomyRecoverySweepResult = {
        discovered: 0,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        failures: [],
      };
      for (const [name, sweeper] of entries) {
        try {
          const part = await sweeper.sweep();
          total.discovered += part.discovered;
          total.attempted += part.attempted;
          total.succeeded += part.succeeded;
          total.failed += part.failed;
          total.failures.push(...part.failures);
        } catch (error) {
          total.failed += 1;
          total.failures.push({ missionId: name, error });
        }
      }
      return total;
    },
  };
}
