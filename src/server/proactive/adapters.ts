import { HighLevelGoalInputSchema } from "@/core/contracts/high-level-goal";
import type { Severity } from "@/core/supervisor/contracts";
import type { MissionRepository } from "@/server/mission/ports";
import type { GoalRepository } from "@/server/repositories/ports";
import type { GoalNormalizer } from "@/server/services/goal-normalizer";
import type { GoalPlanner } from "@/server/services/goal-planner";
import type { GoalPreviewStore } from "@/server/services/goal-preview-store";

import type { GoalIntakePort, SubjectStatusPort } from "./proactive-supervisor";

const PRIORITY: Record<Severity, number> = { low: 2, medium: 3, high: 4, critical: 5 };

/**
 * GoalProposal → CORE3, through the SAME components as `POST /api/goals`:
 * normalizer → planner → preview store. The result is a PENDING goal. Turning it
 * into a mission stays with CORE3's conversion path; the supervisor never does it.
 *
 * Replay-safe: the goal id is derived from the proposal id, and an existing goal
 * is returned instead of re-created (the goals table rejects a duplicate id).
 */
export class CanonicalGoalIntake implements GoalIntakePort {
  constructor(
    private readonly deps: {
      normalizer: GoalNormalizer;
      planner: GoalPlanner;
      previews: GoalPreviewStore;
      goals: Pick<GoalRepository, "getById">;
    },
  ) {}

  async submit(proposal: Parameters<GoalIntakePort["submit"]>[0]) {
    const goalId = `goal-proactive-${proposal.id.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`;
    if (await this.deps.goals.getById(goalId)) return { status: "SUBMITTED" as const, ref: goalId };

    const input = HighLevelGoalInputSchema.parse({
      title: `[proactive] ${proposal.action}: ${proposal.reason}`.slice(0, 200),
      objective: proposal.desiredOutcome,
      constraints: proposal.constraints,
      successCriteria: [proposal.desiredOutcome],
      priority: PRIORITY[proposal.urgency],
      riskLevel: proposal.risk,
      allowedCapabilities: proposal.requestedCapabilities,
      // Anything above read-only still asks a human at the CORE3 approval step.
      humanApprovalPolicy: proposal.risk === "read_only" ? "if_risky" : "always",
      metadata: {
        origin: "proactive-supervisor",
        proposalId: proposal.id,
        situationId: proposal.situationId,
        sourceEventId: proposal.sourceEventId,
        tenantId: proposal.tenantId,
        // Kept in metadata: the normalizer drops correlationId/policyContext.
        initiativeLevel: proposal.initiativeLevel,
        policyVersion: proposal.evidence.policyVersion,
        ...(proposal.clientScope ? { clientScope: proposal.clientScope } : {}),
        ...(proposal.projectScope ? { projectScope: proposal.projectScope } : {}),
      },
      correlationId: proposal.situationId,
      policyContext: {
        initiativeLevel: proposal.initiativeLevel,
        policyVersion: proposal.evidence.policyVersion,
      },
    });
    const goal = { ...this.deps.normalizer.normalize(input), id: goalId };
    const preview = this.deps.planner.plan(goal);
    await this.deps.previews.store(goal.id, goal, preview);
    return { status: "SUBMITTED" as const, ref: goal.id };
  }
}

const TERMINAL_MISSION = new Set(["succeeded", "failed", "cancelled"]);

/** `mission:<id>` subjects: a finished mission is never reopened by a late event. */
export class MissionSubjectStatus implements SubjectStatusPort {
  constructor(private readonly missions: Pick<MissionRepository, "findById">) {}

  async isTerminal(subject: string): Promise<boolean> {
    if (!subject.startsWith("mission:")) return false;
    const mission = await this.missions.findById(subject.slice("mission:".length));
    return mission !== null && TERMINAL_MISSION.has(mission.status);
  }
}
