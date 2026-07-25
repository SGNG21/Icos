import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * Retention gate : interdit l'activation d'une Capability C3 sans
 * politique de rétention associée.
 *
 * Cette règle est déjà implémentée dans CapabilityService (changeStatus).
 * Le gate D1 la reflète comme règle de politique centralisée.
 */
export class RetentionGate implements PolicyGate {
  readonly name = "retention";

  evaluate(request: PolicyRequest): PolicyGateResult {
    // La règle s'applique uniquement à l'action "activate" sur une capability C3.
    if (request.action !== "activate" && request.action !== "status.write") {
      return { decision: "next" };
    }
    if (request.resource.sensitivityLevel !== "C3") {
      return { decision: "next" };
    }

    // Vérifier la présence d'une politique de rétention.
    if (!request.resource.retentionPolicyRef) {
      return {
        decision: "deny",
        code: "retention_policy_required",
        reason: "Capability C3 sans politique de rétention",
      };
    }

    return { decision: "next" };
  }
}
