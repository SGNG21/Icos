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

/** The principal recorded as the decider when policy, not a human, approves a launch. */
export const POLICY_DECIDER = "policy:mission-autonomy";

export type LaunchPolicyDecision =
  /** HOLD_FOR_APPROVAL: a human decides. The reason says what policy saw. */
  | { readonly status: "approval_required"; readonly reason: string }
  /** Policy decided: persisted `approved`, launched at once, audited like a human approval. */
  | { readonly status: "approved"; readonly reason: string; readonly decidedBy: string };

/**
 * Launch policy for a conversational proposal (decision 0067 item 7, P2 of the owner's
 * 2026-10-05 decision — NARROW, never `launchPolicy=always`).
 *
 * An ACTION always holds for a human: it has no execution class, no worktree and no review
 * behind it, so nothing bounds its effect but the person.
 *
 * A GOAL is classified by `classifyMissionAutonomy` from the capabilities the proposal
 * declares — never from the risk the model asserts, which may only escalate:
 *   AUTO_ALLOWED      → approved by policy (verifiably read-only or confined to a worktree);
 *   POLICY_GATED      → HOLD_FOR_APPROVAL;
 *   APPROVAL_REQUIRED → HOLD_FOR_APPROVAL (external, destructive, sensitive or undeclared).
 * A denial is a human `reject`, and a rejected proposal never launches. The proposal row is
 * written in every case, so the audit trail is identical whoever decided.
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
  if (verdict.policyClass === "AUTO_ALLOWED") {
    return {
      status: "approved",
      reason: `AUTO_ALLOWED: ${verdict.reason}`,
      decidedBy: POLICY_DECIDER,
    };
  }
  return { status: "approval_required", reason: `${verdict.policyClass}: ${verdict.reason}` };
}
