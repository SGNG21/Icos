import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * IDOR gate : vérification supplémentaire cross-tenant.
 * S'applique même si le tenant gate a déjà vérifié — cette gate
 * protège contre les cas où resource.ownerTenantId n'est pas fourni.
 *
 * Comparaison strict entre tenant de l'acteur et tenant de la session.
 */
export class IDORGate implements PolicyGate {
  readonly name = "idor";

  evaluate(request: PolicyRequest): PolicyGateResult {
    // Si le tenant de l'acteur diffère du tenant de session → IDOR
    if (request.actor.tenantId !== request.tenant.tenantId) {
      return {
        decision: "deny",
        code: "cross_tenant_idor",
        reason: "IDOR détecté : tenant acteur ≠ tenant session",
      };
    }

    return { decision: "next" };
  }
}
