import type { AgentAction } from "@/types/actions";

export interface ExecutionDecision {
  allowed: boolean;
  reason: "approved" | "approval_required" | "approval_rejected";
}

export function decideExecution(action: AgentAction): ExecutionDecision {
  if (action.approvalStatus === "rejected") {
    return { allowed: false, reason: "approval_rejected" };
  }

  if (action.risk === "sensitive" || action.requiresHumanApproval) {
    return action.approvalStatus === "approved"
      ? { allowed: true, reason: "approved" }
      : { allowed: false, reason: "approval_required" };
  }

  return { allowed: true, reason: "approved" };
}
