import type {
  SelfDevelopmentCandidate,
  SelfDevelopmentState,
  PolicyEvaluation,
  PolicyEvaluationResult,
  RepairRequest,
  RepairResult,
  ReviewOutcome,
  ReviewResult,
  SelfDevelopmentOutcome,
  PolicyEvaluationPort,
  BoundedRepairPort,
  IndependentReviewPort,
  SelfDevelopmentMemoryPort,
  SelfDevelopmentMetricsPort,
} from "@/core/contracts/self-development";
import type { JsonValue } from "@/core/contracts/common";
import { SelfDevelopmentMetrics } from "./self-development-metrics";

export interface SelfDevelopmentControllerOptions {
  maxCycles?: number;
}

export class SelfDevelopmentController {
  constructor(
    private readonly policyEvaluation: PolicyEvaluationPort,
    private readonly boundedRepair: BoundedRepairPort,
    private readonly independentReview: IndependentReviewPort,
    private readonly memory: SelfDevelopmentMemoryPort,
    private readonly metrics: SelfDevelopmentMetricsPort = new SelfDevelopmentMetrics(),
    private readonly options: SelfDevelopmentControllerOptions = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  async processCandidate(candidate: SelfDevelopmentCandidate): Promise<SelfDevelopmentOutcome> {
    this.metrics.recordCycle();

    let policyEvaluation: PolicyEvaluation | null = null;
    let repairAttemptsUsed = 0;
    let maxRepairAttempts = 3;
    let acceptedProposal: Record<string, JsonValue> | undefined;
    let rejectionReason: string | undefined;
    let finalState: SelfDevelopmentState = "human_decision_required";

    try {
      // Policy Evaluation
      policyEvaluation = await this.policyEvaluation.evaluate(candidate);

      // Verify candidateId correlation - fail closed on mismatch
      if (policyEvaluation.candidateId !== candidate.candidateId) {
        this.metrics.recordHumanEscalation();
        finalState = "human_decision_required";
        rejectionReason = `CORRELATION_ERROR:policyEvaluation candidateId mismatch (expected ${candidate.candidateId}, got ${policyEvaluation.candidateId})`;
        return this.buildOutcome(candidate.candidateId, finalState, acceptedProposal, rejectionReason, repairAttemptsUsed);
      }

      // Handle unknown policy result - fail closed
      if (!this.isKnownPolicyResult(policyEvaluation.result)) {
        this.metrics.recordHumanEscalation();
        finalState = "human_decision_required";
        rejectionReason = `UNKNOWN_POLICY_RESULT:${policyEvaluation.result}`;
        return this.buildOutcome(candidate.candidateId, finalState, acceptedProposal, rejectionReason, repairAttemptsUsed);
      }

      maxRepairAttempts = policyEvaluation.maxRepairAttempts;

      // Process based on policy result
      switch (policyEvaluation.result) {
        case "allow":
          const allowResult = await this.handleAllow(candidate, policyEvaluation);
          finalState = allowResult.state;
          acceptedProposal = allowResult.acceptedProposal;
          rejectionReason = allowResult.rejectionReason;
          break;
        case "deny":
          finalState = "exhausted";
          rejectionReason = policyEvaluation.reason;
          break;
        case "repair":
          const repairResult = await this.handleRepair(candidate, policyEvaluation);
          finalState = repairResult.state;
          acceptedProposal = repairResult.acceptedProposal;
          rejectionReason = repairResult.rejectionReason;
          repairAttemptsUsed = repairResult.repairAttemptsUsed;
          break;
        default:
          // Fail closed on unknown
          this.metrics.recordHumanEscalation();
          finalState = "human_decision_required";
          rejectionReason = `UNKNOWN_POLICY_RESULT:${policyEvaluation.result}`;
      }
    } catch (error) {
      // Fail closed on any error
      this.metrics.recordHumanEscalation();
      finalState = "human_decision_required";
      rejectionReason = `DEPENDENCY_ERROR:${error instanceof Error ? error.message : String(error)}`;
    }

    const outcome = this.buildOutcome(candidate.candidateId, finalState, acceptedProposal, rejectionReason, repairAttemptsUsed);

    try {
      await this.memory.saveOutcome(outcome);
    } catch (error) {
      // Fail closed on memory error
      this.metrics.recordHumanEscalation();
      return this.buildOutcome(
        candidate.candidateId,
        "human_decision_required",
        undefined,
        `DEPENDENCY_ERROR:${error instanceof Error ? error.message : String(error)}`,
        repairAttemptsUsed,
      );
    }

    this.metrics.recordCandidateProcessed();

    // Return a defensive copy to ensure immutability
    return { ...outcome, acceptedProposal: outcome.acceptedProposal ? { ...outcome.acceptedProposal } : undefined };
  }

  private async handleAllow(
    candidate: SelfDevelopmentCandidate,
    evaluation: PolicyEvaluation,
  ): Promise<{ state: SelfDevelopmentState; acceptedProposal?: Record<string, JsonValue>; rejectionReason?: string }> {
    // Direct approval path - go to review
    const reviewOutcome = await this.independentReview.review(candidate.candidateId, candidate.proposal.payload);

    // Verify candidateId correlation - fail closed on mismatch
    if (reviewOutcome.candidateId !== candidate.candidateId) {
      this.metrics.recordHumanEscalation();
      return { state: "human_decision_required", rejectionReason: `CORRELATION_ERROR:reviewOutcome candidateId mismatch (expected ${candidate.candidateId}, got ${reviewOutcome.candidateId})` };
    }

    // Handle unknown review result - fail closed
    if (!this.isKnownReviewResult(reviewOutcome.result)) {
      this.metrics.recordHumanEscalation();
      return { state: "human_decision_required", rejectionReason: `UNKNOWN_REVIEW_RESULT:${reviewOutcome.result}` };
    }

    switch (reviewOutcome.result) {
      case "approved":
        this.metrics.recordRepairAccepted();
        return { state: "accepted", acceptedProposal: { ...candidate.proposal.payload } };
      case "rejected":
        this.metrics.recordRepairRejected();
        return { state: "exhausted", rejectionReason: reviewOutcome.reason };
      case "needs_repair":
        this.metrics.recordRepairRejected();
        return { state: "exhausted", rejectionReason: reviewOutcome.reason };
      default:
        this.metrics.recordHumanEscalation();
        return { state: "human_decision_required", rejectionReason: `UNKNOWN_REVIEW_RESULT:${reviewOutcome.result}` };
    }
  }

  private async handleRepair(
    candidate: SelfDevelopmentCandidate,
    evaluation: PolicyEvaluation,
  ): Promise<{
    state: SelfDevelopmentState;
    acceptedProposal?: Record<string, JsonValue>;
    rejectionReason?: string;
    repairAttemptsUsed: number;
  }> {
    let currentProposal = candidate.proposal.payload;
    let lastFeedback = evaluation.reason;
    let attemptNumber = 0;

    for (attemptNumber = 1; attemptNumber <= evaluation.maxRepairAttempts; attemptNumber++) {
      this.metrics.recordRepairAttempted();

      const repairRequest: RepairRequest = {
        candidateId: candidate.candidateId,
        attemptNumber,
        previousFeedback: lastFeedback,
        requestedAt: this.now().toISOString(),
      };

      const repairResult = await this.boundedRepair.requestRepair(repairRequest);

      // Verify candidateId correlation - fail closed on mismatch
      if (repairResult.candidateId !== candidate.candidateId) {
        this.metrics.recordHumanEscalation();
        return {
          state: "human_decision_required",
          rejectionReason: `CORRELATION_ERROR:repairResult candidateId mismatch (expected ${candidate.candidateId}, got ${repairResult.candidateId})`,
          repairAttemptsUsed: attemptNumber,
        };
      }

      if (!repairResult.success) {
        this.metrics.recordRepairRejected();
        lastFeedback = repairResult.error ?? "REPAIR_FAILED";
        continue;
      }

      // Repair succeeded, go to review with repaired proposal
      if (repairResult.repairedProposal) {
        currentProposal = repairResult.repairedProposal;
      }

      const reviewOutcome = await this.independentReview.review(candidate.candidateId, currentProposal);

      // Verify candidateId correlation - fail closed on mismatch
      if (reviewOutcome.candidateId !== candidate.candidateId) {
        this.metrics.recordHumanEscalation();
        return {
          state: "human_decision_required",
          rejectionReason: `CORRELATION_ERROR:reviewOutcome candidateId mismatch (expected ${candidate.candidateId}, got ${reviewOutcome.candidateId})`,
          repairAttemptsUsed: attemptNumber,
        };
      }

      // Handle unknown review result - fail closed
      if (!this.isKnownReviewResult(reviewOutcome.result)) {
        this.metrics.recordHumanEscalation();
        return {
          state: "human_decision_required",
          rejectionReason: `UNKNOWN_REVIEW_RESULT:${reviewOutcome.result}`,
          repairAttemptsUsed: attemptNumber,
        };
      }

      switch (reviewOutcome.result) {
        case "approved":
          this.metrics.recordRepairAccepted();
          return {
            state: "accepted",
            acceptedProposal: { ...currentProposal },
            repairAttemptsUsed: attemptNumber,
          };
        case "rejected":
          this.metrics.recordRepairRejected();
          lastFeedback = reviewOutcome.reason;
          break;
        case "needs_repair":
          this.metrics.recordRepairRejected();
          lastFeedback = reviewOutcome.reason;
          break;
        default:
          this.metrics.recordHumanEscalation();
          return {
            state: "human_decision_required",
            rejectionReason: `UNKNOWN_REVIEW_RESULT:${reviewOutcome.result}`,
            repairAttemptsUsed: attemptNumber,
          };
      }
    }

    // Exhausted all repair attempts
    this.metrics.recordRepairExhausted();
    return {
      state: "exhausted",
      rejectionReason: lastFeedback,
      repairAttemptsUsed: attemptNumber - 1,
    };
  }

  private isKnownPolicyResult(result: PolicyEvaluationResult): boolean {
    return ["allow", "deny", "repair"].includes(result);
  }

  private isKnownReviewResult(result: ReviewResult): boolean {
    return ["approved", "rejected", "needs_repair"].includes(result);
  }

  private buildOutcome(
    candidateId: string,
    finalState: SelfDevelopmentState,
    acceptedProposal: Record<string, JsonValue> | undefined,
    rejectionReason: string | undefined,
    repairAttemptsUsed: number,
  ): SelfDevelopmentOutcome {
    return {
      candidateId,
      finalState,
      acceptedProposal: acceptedProposal ? { ...acceptedProposal } : undefined,
      rejectionReason,
      repairAttemptsUsed,
      completedAt: this.now().toISOString(),
    };
  }

  getMetrics(): SelfDevelopmentMetricsPort {
    return this.metrics;
  }
}