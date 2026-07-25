import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * Tenant gate : vérifie que l'acteur et la resource appartiennent au même tenant.
 * Prévient les attaques IDOR cross-tenant.
 */
export class TenantGate implements PolicyGate {
  readonly name = "tenant";

  evaluate(request: PolicyRequest): PolicyGateResult {
    if (!request.actor.tenantId) {
      return { decision: "deny", code: "no_tenant", reason: "Acteur sans tenant" };
    }

    // Si la resource a un tenant propriétaire, vérifier la correspondance.
    if (request.resource.ownerTenantId && request.resource.ownerTenantId !== request.actor.tenantId) {
      return {
        decision: "deny",
        code: "cross_tenant_idor",
        reason: "Resource d'un autre tenant",
      };
    }

    return { decision: "next" };
  }
}
