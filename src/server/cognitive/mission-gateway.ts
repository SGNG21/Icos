import type { GoalProposal } from "@/core/cognitive/contracts";
import { HighLevelGoalSchema } from "@/core/contracts/high-level-goal";
import type { GoalRepository } from "@/server/repositories/ports";
import type { SchedulerService } from "@/server/scheduler/scheduler-service";
import type { GoalNormalizer } from "@/server/services/goal-normalizer";
import type { GoalPlanner } from "@/server/services/goal-planner";
import type { GoalPreviewStore } from "@/server/services/goal-preview-store";

/** Everything a launch must retain about where the proposal came from. */
export interface GoalLaunchRequest {
  readonly refId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly approvedBy: string;
  readonly clientId: string | null;
  readonly projectId: string | null;
}

export type GoalLaunch =
  | {
      readonly status: "launched";
      readonly goalId: string;
      readonly missionId: string;
      readonly launchJobId: string;
    }
  | { readonly status: "failed" | "not_connected"; readonly reason: string };

/**
 * ConversationIntent → GoalProposal → canonical CORE3 mission intake (decision 0056).
 * The conversation runtime reaches CORE3 only through this port, only after approval.
 */
export interface MissionGateway {
  launch(goal: GoalProposal, request: GoalLaunchRequest): Promise<GoalLaunch>;
}

/** Stable idempotency identity of a launch: one proposal ↔ one scheduler job ↔ one mission. */
export const launchIdempotencyKey = (refId: string) => `cognitive-proposal:${refId}`;

/**
 * REAL backend, canonical CORE3 path:
 *  1. goal intake (normalizer → planner preview → goal store) records a durable goal whose
 *     metadata keeps conversationId / turnId / proposalRefId / clientId / projectId;
 *  2. `SchedulerService.enqueue({ kind: "start_mission", payload: { title, objective, goalId } })`
 *     — the canonical Durable Scheduler entry — fixes the missionId at enqueue time;
 *  3. the production DurableScheduler (production-services.ts) runs `igniteAutonomousMission`
 *     with the governed supervisor and planner. This lane never builds a supervisor.
 *
 * Both writes are idempotent on the proposal: a replay returns the same goal, the same job
 * and the same missionId, so a duplicate launch can never create a second mission.
 */
export class CanonicalGoalLauncher implements MissionGateway {
  constructor(
    private readonly deps: {
      goalNormalizer: GoalNormalizer;
      goalPlanner: GoalPlanner;
      goalPreviewStore: GoalPreviewStore;
      goalRepository: GoalRepository;
      scheduler: Pick<SchedulerService, "enqueue">;
    },
  ) {}

  async launch(p: GoalProposal, r: GoalLaunchRequest): Promise<GoalLaunch> {
    const metadata: Record<string, string> = {
      source: "cognitive_conversation",
      conversationId: r.conversationId,
      turnId: r.turnId,
      proposalRefId: r.refId,
      approvedBy: r.approvedBy,
      ...(r.clientId ? { clientId: r.clientId } : {}),
      ...(r.projectId ? { projectId: r.projectId } : {}),
    };
    const goal = this.deps.goalNormalizer.normalize({
      title: p.title,
      objective: p.objective,
      constraints: p.constraints,
      successCriteria: p.successCriteria,
      riskLevel: p.riskLevel,
      humanApprovalPolicy: "always",
      metadata,
      correlationId: r.refId,
    });
    HighLevelGoalSchema.parse(goal);
    // Goal ids are derived from the text by the existing normalizer: a replay of THIS
    // proposal is idempotent; a different proposal with the same text fails closed.
    const existing = await this.deps.goalRepository.getById(goal.id);
    if (existing && existing.goal.metadata.proposalRefId !== r.refId) {
      return { status: "failed", reason: "goal_id_collision" };
    }
    if (!existing) {
      await this.deps.goalPreviewStore.store(goal.id, goal, this.deps.goalPlanner.plan(goal));
    }
    const { job } = await this.deps.scheduler.enqueue({
      kind: "start_mission",
      idempotencyKey: launchIdempotencyKey(r.refId),
      payload: { title: goal.title, objective: goal.objective, goalId: goal.id },
    });
    if (!job.missionId) return { status: "failed", reason: "scheduler_returned_no_mission_id" };
    return { status: "launched", goalId: goal.id, missionId: job.missionId, launchJobId: job.id };
  }
}
