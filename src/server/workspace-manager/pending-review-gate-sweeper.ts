import type { AutonomyRecoverySweepResult } from "@/server/autonomy/autonomy-recovery-sweeper";

import type { CoordinationResult, WorkspaceExecutionCoordinator } from "./workspace-execution-coordinator";

/**
 * THE production trigger of the later governed pass (defect 28 closure).
 *
 * Since M13 execution and gating are two moments: a workspace whose execution finished before
 * any review existed is parked `ready_for_integration`. QC reviews it on a LATER recovery sweep
 * (`QualityControlService.recover` registers and reviews every recorded execution). Nothing
 * then revisited the parked workspace in production — `gatePendingReview()` had no caller but
 * tests — so approved work was never integrated by the runtime.
 *
 * This adapter is that caller, registered once in the production recovery sweep, AFTER the QC
 * sweep, so a review persisted on a tick is gated on the same tick. It adds no authority:
 * - the gate is the one canonical `IntegrationGate`, reached through the coordinator;
 * - the review is the one canonical review, read by the coordinator (silence ⇒ nothing);
 * - repeated sweeps are harmless: the coordinator's pass is single-flight in-process, claims
 *   each adopted workspace through the durable lease across processes, and integration is
 *   exactly-once by the applier's git-derived check.
 */
export class PendingReviewGateSweeper {
  constructor(
    private readonly coordinator: Pick<WorkspaceExecutionCoordinator, "gatePendingReview">,
  ) {}

  async sweep(): Promise<AutonomyRecoverySweepResult & { results: CoordinationResult[] }> {
    const results = await this.coordinator.gatePendingReview();
    const failures = results
      .filter((r) => r.decision !== "ACCEPT" && r.decision !== "REJECT")
      .map((r) => ({
        missionId: r.taskId,
        error: new Error(`GATE_${r.decision ?? "NO_DECISION"}`),
      }));
    return {
      discovered: results.length,
      attempted: results.length,
      succeeded: results.filter(
        (r) =>
          r.integration?.status === "INTEGRATED" || r.integration?.status === "ALREADY_INTEGRATED",
      ).length,
      failed: failures.length,
      failures,
      /* Per-workspace verdicts, for a caller that must act on an inconclusive one (0052). */
      results,
    };
  }
}
