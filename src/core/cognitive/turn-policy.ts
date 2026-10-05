import { classifyMissionAutonomy } from "@/core/autonomy/mission-autonomy-policy";

import type {
  ActionProposal,
  CognitionResult,
  GoalProposal,
  RefKind,
  TurnOutcome,
} from "./contracts";

export interface GovernedOutcome {
  readonly outcome: TurnOutcome;
  readonly reply: string;
  readonly proposal?: { readonly kind: RefKind; readonly payload: GoalProposal | ActionProposal };
}

/**
 * Policy between cognition and the world (decision 0056). The cognitive engine never
 * mutates anything: an action or a mission is only ever PROPOSED here, persisted as a
 * turn reference awaiting explicit human approval, and handed to the canonical ICOS
 * path (goal intake → CORE3) only after that approval.
 */
export function governOutcome(result: CognitionResult): GovernedOutcome {
  switch (result.kind) {
    case "ANSWER_ONLY":
      return { outcome: "ANSWER_ONLY", reply: result.text };
    case "CLARIFICATION":
      return { outcome: "CLARIFICATION", reply: result.question };
    case "NO_ACTION":
      return { outcome: "NO_ACTION", reply: result.text ?? "Aucune action nécessaire." };
    case "ACTION_REQUEST":
      return {
        outcome: "APPROVAL_REQUEST",
        reply: result.text,
        proposal: { kind: "action_request", payload: result.action },
      };
    case "MISSION_REQUEST":
      return {
        outcome: "MISSION_REQUEST",
        reply: result.text,
        proposal: { kind: "goal_proposal", payload: result.goal },
      };
  }
}

export interface LaunchPolicyDecision {
  readonly status: "approval_required";
  readonly reason: string;
}

/**
 * Launch policy for a conversational proposal.
 *
 * Every conversational goal and action still requires an explicit human approval before
 * launch: the approval is a policy step taken by the conversation's human, and once given
 * the launch is automatic and durable.
 *
 * What changed (decision 0067, item 7, first half): the REASON is no longer a blanket
 * "risk asserted by the model". A goal is now classified by `classifyMissionAutonomy` from
 * the capabilities the proposal declares — the model may only narrow, never widen — and the
 * verdict is written on the proposal, so the approving human reads WHY policy would or
 * would not have let it start on its own. Turning an `AUTO_ALLOWED` verdict into a launch
 * without the human step is the second half, and it is deliberately a separate change.
 */
export function launchPolicy(kind: RefKind, payload?: GoalProposal): LaunchPolicyDecision {
  if (kind !== "goal_proposal") {
    return {
      status: "approval_required",
      reason: "CONVERSATIONAL_ACTION_ALWAYS_APPROVED_BY_HUMAN",
    };
  }
  const verdict = classifyMissionAutonomy({
    capabilities: payload?.capabilities ?? [],
    assertedRisk: payload?.riskLevel,
  });
  return { status: "approval_required", reason: `${verdict.policyClass}: ${verdict.reason}` };
}
