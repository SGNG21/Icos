import type { Agent, AgentAction, AuthorizationLevel, RiskLevel } from "@/core/contracts";

/**
 * Niveau d'autorisation minimal exigé par niveau de risque. Pour `sensitive`,
 * le niveau est nécessaire mais jamais suffisant : l'approbation humaine
 * explicite reste obligatoire dans tous les cas.
 */
const minimumLevelByRisk: Record<RiskLevel, AuthorizationLevel> = {
  read_only: 0,
  reversible: 2,
  sensitive: 2,
};

export type ExecutionDecision =
  | { outcome: "allowed"; reason: "authorized" }
  | { outcome: "awaiting_approval"; reason: "approval_required" }
  | {
      outcome: "refused";
      reason: "approval_rejected" | "insufficient_authorization" | "invalid_state";
    };

/**
 * Politique centrale d'autorisation. Priorités, dans l'ordre :
 * 1. un rejet explicite est définitif pour la demande concernée ;
 * 2. un niveau d'autorisation insuffisant refuse l'action ;
 * 3. une action `sensitive` exige toujours une approbation humaine explicite,
 *    même si l'action déclare `requiresHumanApproval: false` — la politique
 *    est prioritaire sur les propriétés déclaratives ;
 * 4. tout état inconnu ou incohérent conduit au refus, jamais à l'autorisation.
 */
export function decideExecution(action: AgentAction, agent: Agent): ExecutionDecision {
  if (action.approvalStatus === "rejected") {
    return { outcome: "refused", reason: "approval_rejected" };
  }

  const requiredLevel = minimumLevelByRisk[action.risk];
  if (requiredLevel === undefined || agent.authorizationLevel < requiredLevel) {
    return { outcome: "refused", reason: "insufficient_authorization" };
  }

  const needsHumanApproval = action.risk === "sensitive" || action.requiresHumanApproval;

  if (needsHumanApproval) {
    switch (action.approvalStatus) {
      case "approved":
        return { outcome: "allowed", reason: "authorized" };
      case "pending":
      case "not_required":
        // "not_required" contredit la politique : l'approbation reste exigée.
        return { outcome: "awaiting_approval", reason: "approval_required" };
      default:
        return { outcome: "refused", reason: "invalid_state" };
    }
  }

  switch (action.approvalStatus) {
    case "not_required":
    case "approved":
      return { outcome: "allowed", reason: "authorized" };
    case "pending":
      return { outcome: "awaiting_approval", reason: "approval_required" };
    default:
      return { outcome: "refused", reason: "invalid_state" };
  }
}
