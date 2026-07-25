import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * Risk gate : vérifie que le niveau de risque de l'action est compatible
 * avec le niveau d'autorisation de l'acteur et son état d'approbation.
 *
 * Règles :
 * - read_only → autorisé si authorizationLevel ≥ 0
 * - reversible → authorizationLevel ≥ 2
 * - sensitive → authorizationLevel ≥ 3 OU require_approval
 */
export class RiskGate implements PolicyGate {
  readonly name = "risk";

  evaluate(request: PolicyRequest): PolicyGateResult {
    if (!request.risk || request.risk === "read_only") {
      return { decision: "next" };
    }

    const actorLevel = request.actor.authorizationLevel ?? 0;

    if (request.risk === "reversible" && actorLevel < 2) {
      return {
        decision: "deny",
        code: "insufficient_authorization",
        reason: `Action réversible nécessite niveau 2, acteur a niveau ${actorLevel}`,
      };
    }

    if (request.risk === "sensitive") {
      if (actorLevel >= 3) {
        return { decision: "next" }; // Superviseur peut exécuter directement
      }
      return {
        decision: "require_approval",
        reason: "Action sensible necessite approbation humaine",
      };
    }

    return { decision: "next" };
  }
}
