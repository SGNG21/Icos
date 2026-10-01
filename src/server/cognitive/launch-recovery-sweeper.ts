import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity";
import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";
import type { Container } from "@/server/container";

import { cognitiveRuntimeFor } from "./index";

const EMPTY: AutonomyRecoverySweepResult = {
  discovered: 0,
  attempted: 0,
  succeeded: 0,
  failed: 0,
  failures: [],
};

/**
 * THE explicit launch-recovery path (no second recovery engine).
 *
 * Approved or interrupted goal proposals are relaunched idempotently by the SAME
 * `CognitiveRuntime.recoverLaunches` authority as before — but from the production
 * recovery timer only. It used to run during `cognitiveRuntimeFor(...)` composition,
 * which made every read surface (GET /api/cognitive/*, a page render, the voice
 * adapter) able to launch a mission. Reads are side-effect free; recovery is explicit.
 */
export function cognitiveLaunchRecoverySweeper(container: Container): {
  sweep(): Promise<AutonomyRecoverySweepResult>;
} {
  return {
    async sweep() {
      const runtime = cognitiveRuntimeFor(container);
      if (!runtime) return { ...EMPTY, failures: [] };
      const { recovered, failed } = await runtime.recoverLaunches(CURRENT_SINGLE_TENANT_ID);
      // `recoverLaunches` settles each pending launch itself and reports counts only;
      // attempted is what it actually touched, so discovered mirrors it rather than
      // claiming a queue depth this adapter never saw.
      const attempted = recovered + failed;
      return {
        discovered: attempted,
        attempted,
        succeeded: recovered,
        failed,
        failures: [],
      };
    },
  };
}
