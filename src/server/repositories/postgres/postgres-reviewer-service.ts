import { Database } from "@/server/database/client";
import { DeterministicReviewer } from "@/server/review/deterministic-reviewer";
import { ReviewerServiceImpl } from "@/server/review/reviewer-service";
import type {
  ReviewerPort,
  ReviewInput,
  ReviewDecisionRecord,
  ReviewerService,
} from "@/server/review/ports";
import { PostgresReviewDecisionRepository } from "./review-decision-repository";

/**
 * PostgreSQL-backed ReviewerService implementation.
 * Uses ReviewerServiceImpl with a PostgresReviewDecisionRepository for persistence,
 * a deterministic reviewer, and an OmniRoute LLM reviewer.
 */
export class PostgresReviewerService implements ReviewerService {
  private readonly impl: ReviewerServiceImpl;

  constructor(
    private readonly db: Database,
    llmReviewer: ReviewerPort,
    reviewBrain?: (missionId: string) => Promise<string | null>,
  ) {
    const reviewDecisionRepository = new PostgresReviewDecisionRepository(db);
    const deterministicReviewer = new DeterministicReviewer();
    this.impl = new ReviewerServiceImpl(
      llmReviewer,
      deterministicReviewer,
      reviewDecisionRepository,
      reviewBrain,
    );
  }

  async review(input: ReviewInput): Promise<ReviewDecisionRecord> {
    return this.impl.review(input);
  }
}
