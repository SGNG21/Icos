import type { PolicyGate, PolicyGateResult } from "./gate";
import type { PolicyRequest } from "../contract";

/**
 * Permission gate : vérifie que l'acteur possède la permission demandée.
 * Les permissions sont transportées dans `request.actor.roles` (liste des
 * identifiants de permission accordés).
 *
 * La permission requise est construite comme `resource.type.action`
 * (ex: "capabilities.read", "skills.create").
 */
export class PermissionGate implements PolicyGate {
  readonly name = "permission";

  evaluate(request: PolicyRequest): PolicyGateResult {
    const permissions = request.actor.roles;
    if (!permissions || permissions.length === 0) {
      return { decision: "deny", code: "forbidden", reason: "Aucune permission accordée" };
    }

    const requiredPermission = `${request.resource.type}.${request.action}`;
    if (!permissions.includes(requiredPermission)) {
      return {
        decision: "deny",
        code: "forbidden",
        reason: `Permission '${requiredPermission}' manquante`,
      };
    }

    return { decision: "next" };
  }
}
