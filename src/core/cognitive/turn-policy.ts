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
 * Policy between cognition and the world (decision 0057). The cognitive engine never
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
 * Launch policy for a conversational proposal. The goal's risk level and scope are
 * asserted by the MODEL, i.e. unverified, so the existing approval semantics
 * (`humanApprovalPolicy`) cannot be relaxed on the model's word: every conversational
 * goal and action requires an explicit human approval before launch. The approval is a
 * policy step taken by the conversation's human, not an operator stage advancement: once
 * approved, launch is automatic and durable.
 */
export function launchPolicy(kind: RefKind): LaunchPolicyDecision {
  return {
    status: "approval_required",
    reason:
      kind === "goal_proposal"
        ? "CONVERSATIONAL_GOAL_RISK_MODEL_ASSERTED"
        : "CONVERSATIONAL_ACTION_ALWAYS_APPROVED_BY_HUMAN",
  };
}
