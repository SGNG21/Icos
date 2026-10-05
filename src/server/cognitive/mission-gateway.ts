import { classifyRawObjective } from "@/core/chief/objective-classification";
import type { GoalProposal } from "@/core/cognitive/contracts";
import { HighLevelGoalSchema, type HighLevelGoal } from "@/core/contracts/high-level-goal";
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
      /**
       * Objective admission (decision 0065). Optional: without it a launch enqueues at
       * priority 0 and unbounded, exactly as before this lane. The coordinator never
       * replaces the scheduler — it calls the same enqueue with a priority and runAt.
       */
      objectiveCoordinator?: {
        admit(input: {
          goal: HighLevelGoal;
          idempotencyKey: string;
          title: string;
          objective: string;
        }): Promise<{ jobId: string; missionId: string | undefined }>;
      };
    },
  ) {}

  async launch(p: GoalProposal, r: GoalLaunchRequest): Promise<GoalLaunch> {
    /*
     * WORK CLASS, SERVER-ASSERTED (decision 0065). This is the one point where the raw text
     * of an approved proposal becomes a durable goal, so it is where the class is DERIVED —
     * by `classifyRawObjective`, from the text and from nothing else. Nothing the payload
     * carries is read: `p` arrives here through a cast, and a proposal that could name its
     * own class would let any caller aim ICOS at modifying itself.
     *
     * Only SELF_IMPROVEMENT is promoted, and only outside a client scope: work approved FOR
     * a client is client work whatever the sentence says. Every other outcome — CLIENT, and
     * above all UNKNOWN — keeps the conversational provenance the launch already had. An
     * objective that does not clearly classify is never guessed into self-modifying work.
     *
     * Title and objective are joined by a FULL STOP, not ": ". The classifier's proximity
     * rules stop at `. ; ! ?`, so a colon would let a title run into the objective and read
     * a signal that spans both: "Optimise la plaquette: ICOS doit rendre un PDF" classifies
     * SELF_IMPROVEMENT when joined by a colon, UNKNOWN when joined as the two sentences it
     * really is. They are two sentences.
     */
    const classified = classifyRawObjective(`${p.title}. ${p.objective}`);
    const selfImprovement = classified.workClass === "SELF_IMPROVEMENT" && !r.clientId;

    const metadata: Record<string, string> = {
      source: "cognitive_conversation",
      conversationId: r.conversationId,
      turnId: r.turnId,
      proposalRefId: r.refId,
      approvedBy: r.approvedBy,
      ...(r.clientId ? { clientId: r.clientId } : {}),
      ...(r.projectId ? { projectId: r.projectId } : {}),
      /*
       * Reserved namespace (decision 0065): the priority governor classifies on these and
       * on nothing else, because ICOS wrote them. The unprefixed keys above stay for the
       * readers that already depend on them (cognitive operational state reads clientId).
       *
       * `icos.source` carries the CLASS; the unprefixed `source` above stays provenance —
       * a self-improvement goal did still come from a conversation.
       */
      "icos.source": selfImprovement ? "self_development" : "cognitive_conversation",
      ...(r.clientId ? { "icos.clientId": r.clientId } : {}),
    };
    const goal = this.deps.goalNormalizer.normalize({
      title: p.title,
      objective: p.objective,
      constraints: p.constraints,
      successCriteria: p.successCriteria,
      riskLevel: p.riskLevel,
      // The proposal's declared needs reach intake as the goal's capability allowlist, so the
      // planner and the autonomy policy read the same declaration the human approved.
      allowedCapabilities: p.capabilities,
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
    const idempotencyKey = launchIdempotencyKey(r.refId);
    const admitted = this.deps.objectiveCoordinator
      ? await this.deps.objectiveCoordinator.admit({
          goal,
          idempotencyKey,
          title: goal.title,
          objective: goal.objective,
        })
      : await this.deps.scheduler
          .enqueue({
            kind: "start_mission",
            idempotencyKey,
            payload: { title: goal.title, objective: goal.objective, goalId: goal.id },
          })
          .then(({ job }) => ({ jobId: job.id, missionId: job.missionId }));

    if (!admitted.missionId)
      return { status: "failed", reason: "scheduler_returned_no_mission_id" };
    /*
     * A DEFERRED admission is still `launched`: the durable job exists and the missionId is
     * fixed. Reporting a failure would push the caller to launch a second time.
     */
    return {
      status: "launched",
      goalId: goal.id,
      missionId: admitted.missionId,
      launchJobId: admitted.jobId,
    };
  }
}
