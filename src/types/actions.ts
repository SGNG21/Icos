export type ActionRisk = "read_only" | "reversible" | "sensitive";
export type ApprovalStatus = "not_required" | "pending" | "approved" | "rejected";
export type ExecutionStatus = "not_started" | "refused" | "succeeded" | "failed";

export interface AgentAction {
  id: string;
  initiatedByAgentId: string;
  kind: string;
  risk: ActionRisk;
  requiresHumanApproval: boolean;
  approvalStatus: ApprovalStatus;
  requestedAt: string;
}

export interface ExecutionResult {
  actionId: string;
  status: ExecutionStatus;
  auditedAt: string;
  message: string;
}
