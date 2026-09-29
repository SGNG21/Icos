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
