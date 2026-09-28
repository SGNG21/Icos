import type {
  ReviewerService,
  ReviewerPort,
  ReviewInput,
  ReviewDecisionRecord,
  ReviewDecision,
  ReviewDecisionRepository,
} from "@/server/review/ports";
import { idSchema } from "@/core/contracts/common";
import { DeterministicReviewer } from "./deterministic-reviewer";

/**
 * Service de revue principal combinant :
 * 1. Règles déterministes (autoritaires, non-déclassables)
 * 2. Reviewer LLM (provider-indépendant via ReviewerPort)
 * 3. Persistence des décisions via ReviewDecisionRepository
 */
export class ReviewerServiceImpl implements ReviewerService {
  constructor(
    private readonly llmReviewer: ReviewerPort,
    private readonly deterministicReviewer: DeterministicReviewer,
    private readonly reviewDecisionRepository: ReviewDecisionRepository,
  ) {}

  async review(input: ReviewInput): Promise<ReviewDecisionRecord> {
    // ÉTAPE 1: Revue déterministe (règles dures)
    const deterministicResult = this.deterministicReviewer.apply(input);

    // Si une décision bloquante a été prise, elle est FINALE
    if (deterministicResult.blockingDecision) {
      return this.reviewDecisionRepository.save({
        ...deterministicResult.blockingDecision,
        missionId: input.mission.id,
        taskId: input.executionResult.taskId,
        workflowId: input.executionResult.workflowId,
      });
    }

    // ÉTAPE 2: Revue LLM (seulement si pas de blocage dur)
    if (!deterministicResult.proceedToLlm) {
      // Ne devrait pas arriver si deterministicReviewer est correct
      throw new Error("Deterministic reviewer returned no decision but proceedToLlm=false");
    }

    const llmResult = await this.llmReviewer.review(input);

    // Construire la décision finale combinée
    const finalDecision: ReviewDecisionRecord = {
      id: `review-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      taskId: input.executionResult.taskId,
      workflowId: input.executionResult.workflowId,
      missionId: input.mission.id,
      decision: llmResult.decision,
      reviewerKind: "llm",
      severity: this.decisionToSeverity(llmResult.decision),
      reasons: llmResult.reasons,
      requestedChanges: llmResult.requestedChanges,
      /*
       * Evidence is referenced by TYPE, matching DeterministicReviewer.
       *
       * This mapped `e.timestamp` before, which can NEVER satisfy `idSchema`
       * (lowercase, digits, `-`/`_` only) because an ISO timestamp carries `T`, `Z`,
       * `:` and `.`. Any reviewed result that carried evidence therefore produced an
       * invalid decision record and threw QUALITY_CONTROL_INVALID_REVIEW. It never
       * fired because nothing attached evidence to a reviewed SUCCESS until the M6.3
       * external worker executor did; the CORE3 chaos certification is what exposed it.
       *
       * Non-conforming labels are dropped rather than allowed to invalidate the whole
       * record: losing a reference is a cosmetic loss, losing the review is not.
       */
      evidenceRefs: input.evidence
        .map((e) => e.type)
        .filter((type) => idSchema.safeParse(type).success),
      findingRefs: input.findings.map((f) => f.check),
      policyRefs: ["llm-review"],
      providerMetadata: llmResult.providerMetadata,
      confidence: llmResult.confidence,
      createdAt: new Date().toISOString(),
      humanOverridden: false,
      overriddenBy: undefined,
    };

    return this.reviewDecisionRepository.save(finalDecision);
  }

  private decisionToSeverity(decision: ReviewDecision): "info" | "warning" | "critical" {
    switch (decision) {
      case "APPROVE":
        return "info";
      case "REQUEST_CHANGES":
      case "RETRY":
      case "REPLAN":
        return "warning";
      case "BLOCK":
      case "ESCALATE_TO_HUMAN":
        return "critical";
    }
  }
}
