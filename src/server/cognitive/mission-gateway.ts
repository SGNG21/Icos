import type { GoalProposal } from "@/core/cognitive/contracts";
import { HighLevelGoalSchema } from "@/core/contracts/high-level-goal";
import type { GoalRepository } from "@/server/repositories/ports";
import type { GoalNormalizer } from "@/server/services/goal-normalizer";
import type { GoalPlanner } from "@/server/services/goal-planner";
import type { GoalPreviewStore } from "@/server/services/goal-preview-store";

export interface GoalSubmissionMeta {
  readonly refId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly approvedBy: string;
  readonly clientId: string | null;
  readonly projectId: string | null;
}

export type GoalSubmission =
  | { readonly status: "submitted"; readonly externalId: string }
  | { readonly status: "not_connected" | "failed"; readonly detail: string };

/**
 * ConversationIntent → GoalProposal → canonical autonomous runtime (decision 0056).
 * The conversation runtime only reaches CORE3 through this port, and only after a human
 * approved the proposal.
 */
export interface MissionGateway {
  submitGoal(goal: GoalProposal, meta: GoalSubmissionMeta): Promise<GoalSubmission>;
}

/**
 * REAL backend: the canonical goal intake (normalizer → planner preview → goal store),
 * the same path as POST /api/goals. It deliberately stops at a PENDING goal: starting the
 * mission stays the existing governed operator step (convert-preview / autonomous start),
 * so a conversation can never ignite workers on its own.
 */
export class GoalIntakeMissionGateway implements MissionGateway {
  constructor(
    private readonly deps: {
      goalNormalizer: GoalNormalizer;
      goalPlanner: GoalPlanner;
      goalPreviewStore: GoalPreviewStore;
      goalRepository: GoalRepository;
    },
  ) {}

  async submitGoal(p: GoalProposal, meta: GoalSubmissionMeta): Promise<GoalSubmission> {
    const metadata: Record<string, string> = {
      source: "cognitive_conversation",
      conversationId: meta.conversationId,
      turnId: meta.turnId,
      proposalRefId: meta.refId,
      approvedBy: meta.approvedBy,
      ...(meta.clientId ? { clientId: meta.clientId } : {}),
      ...(meta.projectId ? { projectId: meta.projectId } : {}),
    };
    const goal = this.deps.goalNormalizer.normalize({
      title: p.title,
      objective: p.objective,
      constraints: p.constraints,
      successCriteria: p.successCriteria,
      riskLevel: p.riskLevel,
      humanApprovalPolicy: "always",
      metadata,
      correlationId: meta.refId,
    });
    HighLevelGoalSchema.parse(goal);
    // Goal ids are derived from the text: a replay of THIS proposal is idempotent, a
    // different proposal with the same text must not be silently attached to it.
    const existing = await this.deps.goalRepository.getById(goal.id);
    if (existing) {
      return existing.goal.metadata.proposalRefId === meta.refId
        ? { status: "submitted", externalId: goal.id }
        : { status: "failed", detail: "goal_id_collision" };
    }
    await this.deps.goalPreviewStore.store(goal.id, goal, this.deps.goalPlanner.plan(goal));
    return { status: "submitted", externalId: goal.id };
  }
}

/** Action execution has no canonical conversational backend yet: recorded, never run. */
export const ACTION_GATEWAY_STATUS = "not_connected" as const;
