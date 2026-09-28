import type { ReviewerService } from "@/server/review/ports";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { WorkerRegistryPort } from "@/core/contracts/worker-registry";
import { ReviewerIndependenceChecker } from "./reviewer-independence";
import type {
  GovernedReviewRequest,
  GovernedReviewResult,
  IndependentReviewHandoff,
  IndependentReviewerSelection,
} from "./governed-self-development-coordinator";

/**
 * THE adapter to the canonical reviewer for self-development (M11, defect 25 link 3).
 *
 * Like the execution handoff, `IndependentReviewHandoff` was an injected function, so
 * self-development could have been reviewed by anything a caller supplied — including, in
 * principle, the worker that produced the work.
 *
 * This delegates to `container.reviewer`, the SAME `ReviewerService` that reviews ordinary
 * autonomous work (real deterministic hard rules plus the configured LLM), and uses the
 * existing `ReviewerIndependenceChecker` to choose the reviewer. No second review authority
 * and no second independence rule.
 */

export interface CanonicalIndependentReviewDeps {
  reviewer: ReviewerService;
  workerRegistry: WorkerRegistryPort;
  missions: Pick<MissionRepository, "findById" | "getMissionTaskById">;
  tasks: Pick<TaskRepository, "getById">;
}

export class CanonicalIndependentReview implements IndependentReviewHandoff {
  constructor(private readonly deps: CanonicalIndependentReviewDeps) {}

  /**
   * Picks a reviewer that is provably NOT the producer.
   *
   * Fails closed: if no independent worker exists, self-development stops rather than letting
   * a worker approve its own change. That is the whole point of the rule, and it is exactly
   * the moment it would be tempting to relax it.
   */
  async selectReviewer(input: {
    candidateId: string;
    producerWorkerId: string;
  }): Promise<IndependentReviewerSelection> {
    const candidates = this.deps.workerRegistry
      .listWorkers()
      .filter((worker) => worker.id !== input.producerWorkerId);

    for (const worker of candidates) {
      const check = new ReviewerIndependenceChecker({
        workerRegistry: this.deps.workerRegistry,
        producerWorkerId: input.producerWorkerId,
        reviewerWorkerId: worker.id,
      }).check();

      if (check.isIndependent) {
        return { status: "SELECTED", candidateId: input.candidateId, reviewerWorkerId: worker.id };
      }
    }

    return {
      status: "UNKNOWN",
      candidateId: input.candidateId,
      reason: `NO_INDEPENDENT_REVIEWER: every registered worker shares an identity axis with producer ${input.producerWorkerId}`,
    };
  }

  /** Delegates the decision itself to the canonical reviewer. */
  async review(input: GovernedReviewRequest): Promise<GovernedReviewResult> {
    const [mission, missionTask, task] = await Promise.all([
      this.deps.missions.findById(input.missionId),
      this.deps.missions.getMissionTaskById(input.missionTaskId),
      this.deps.tasks.getById(input.taskId),
    ]);

    if (!mission || !missionTask || !task) {
      /* Reviewing without the canonical context would be reviewing something else. */
      throw new Error(`SELF_DEVELOPMENT_REVIEW_CONTEXT_MISSING:${input.taskId}`);
    }

    const decision = await this.deps.reviewer.review({
      mission,
      missionTask,
      task: { id: task.id, title: task.title, description: task.description },
      executionResult: input.executionResult,
      artifacts: input.executionResult.artifacts ?? [],
      evidence: input.executionResult.evidence ?? [],
      findings: input.executionResult.findings ?? [],
      policyContext: { executionAttempt: 1, priorReviews: [] },
    });

    return {
      candidateId: input.candidateId,
      reviewerWorkerId: input.reviewerWorkerId,
      decision,
    };
  }
}
