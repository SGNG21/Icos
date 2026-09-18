import type { ReviewerPort } from "@/server/review/ports";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { ReviewInput } from "@/server/review/ports";

/**
 * In-memory mock reviewer port for testing and development.
 * Always returns APPROVE.
 */
export class InMemoryReviewerPort implements ReviewerPort {
  async review(input: ReviewInput): Promise<{
    decision: "APPROVE" | "REQUEST_CHANGES" | "BLOCK" | "ESCALATE_TO_HUMAN";
    reasons: string[];
    requestedChange?: never; // We don't use requestedChange in this mock
    confidence?: number;
    providerMetadata?: {
      provider: string;
      model: string;
      temperature?: number | undefined;
      promptVersion?: string | undefined;
    };
  }> {
    return {
      decision: "APPROVE",
      reasons: ["Mock reviewer port always approves"],
      providerMetadata: { provider: "mock", model: "mock" },
      confidence: 1.0,
    };
  }
}
