import type { ReviewerService, ReviewInput, ReviewDecisionRecord } from "@/server/review/ports";
import type { ReviewerKind } from "@/core/contracts/review";

/**
 * In-memory mock reviewer for testing and development.
 * Always returns APPROVE.
 */
export class InMemoryReviewerService implements ReviewerService {
  async review(input: ReviewInput): Promise<ReviewDecisionRecord> {
    return {
      id: `review-mock-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId: input.executionResult.taskId,
      workflowId: input.executionResult.workflowId,
      missionId: input.mission.id,
      decision: "APPROVE",
      reviewerKind: "deterministic",
      severity: "info",
      reasons: ["Mock reviewer always approves"],
      requestedChanges: [],
      evidenceRefs: input.evidence.map((e) => e.timestamp),
      findingRefs: input.findings.map((f) => f.check),
      policyRefs: ["mock-review"],
      providerMetadata: { provider: "mock", model: "mock" },
      confidence: 1.0,
      createdAt: new Date().toISOString(),
      humanOverridden: false,
      overriddenBy: undefined,
    };
  }
}
