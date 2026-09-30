import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { PERMISSIONS, type AuthenticatedSession } from "@/core/identity";
import type { Principal } from "@/core/workforce/governance";
import { AuthorizationService } from "@/server/auth/authorization-service";

/**
 * THE principal boundary of the digital workforce (decision 0057 §integration).
 *
 * A `Principal` is only accepted by the WorkforceService if THIS authority issued it: issued
 * principals are frozen and registered in a private WeakSet. An object literal, a parsed JSON
 * body, a spread copy or a principal from another authority instance is refused — so no HTTP
 * caller can forge a human, an agent or the system.
 *
 *   authenticated session  → human principal  (identity + permissions derived from roles by
 *                                              the existing AuthorizationService; disabled
 *                                              user ⇒ no permission)
 *   trusted ICOS runtime   → system principal (only through the `runtime` facet, which the
 *                                              composition root hands to CORE3 / the Tool
 *                                              Gateway / the Cognitive Runtime — never to a
 *                                              route)
 *   system principal       → agent principal  (the runtime vouches that agent X is acting)
 *
 * TENANT: ICOS has no runtime TenantContext yet (COMPLIANCE-1). Every principal carries the
 * explicit single-tenant shim `CURRENT_SINGLE_TENANT_ID`; no multi-tenancy is simulated.
 * CLIENT/PROJECT SCOPE: `AuthenticatedSession` carries none, so a human principal has no
 * client/project restriction to retain; agents carry theirs in their own record.
 */

/** Trusted in-process components that may act as the system. Closed list. */
export const RUNTIME_COMPONENTS = [
  "core3-dispatch",
  "tool-gateway",
  "cognitive-runtime",
  "workforce-bootstrap",
] as const;
export type RuntimeComponent = (typeof RUNTIME_COMPONENTS)[number];

export interface SessionPrincipals {
  fromSession(session: AuthenticatedSession): Principal;
}

export interface RuntimePrincipals {
  system(component: RuntimeComponent): Principal;
  /** The runtime vouches that `agentId` is acting. Requires an issued system principal. */
  actAsAgent(system: Principal, agentId: string): Principal;
}

export interface PrincipalAuthority {
  /** Safe to give to HTTP routes / server components. */
  readonly sessions: SessionPrincipals;
  /** Composition root only. */
  readonly runtime: RuntimePrincipals;
  isIssued(principal: unknown): principal is Principal;
}

export class UntrustedPrincipalError extends Error {
  constructor(reason: string) {
    super(`workforce: principal refusé (${reason})`);
    this.name = "UntrustedPrincipalError";
  }
}

const authorization = new AuthorizationService();

export function createPrincipalAuthority(): PrincipalAuthority {
  const issued = new WeakSet<object>();
  const issue = (p: Principal): Principal => {
    const frozen = Object.freeze({ ...p, permissions: Object.freeze([...p.permissions]) });
    issued.add(frozen);
    return frozen;
  };
  const isIssued = (p: unknown): p is Principal =>
    typeof p === "object" && p !== null && issued.has(p);

  return {
    isIssued,
    sessions: {
      fromSession(session) {
        if (!session?.user?.id) throw new UntrustedPrincipalError("session sans identité");
        return issue({
          kind: "human",
          id: session.user.id,
          tenantId: CURRENT_SINGLE_TENANT_ID,
          permissions: PERMISSIONS.filter((p) => authorization.can(session, p)),
        });
      },
    },
    runtime: {
      system(component) {
        if (!RUNTIME_COMPONENTS.includes(component))
          throw new UntrustedPrincipalError("composant inconnu");
        return issue({
          kind: "system",
          id: component,
          tenantId: CURRENT_SINGLE_TENANT_ID,
          permissions: [],
        });
      },
      actAsAgent(system, agentId) {
        if (!isIssued(system) || system.kind !== "system") {
          throw new UntrustedPrincipalError("seul le runtime peut faire agir un agent");
        }
        if (!agentId) throw new UntrustedPrincipalError("agent inconnu");
        return issue({ kind: "agent", id: agentId, tenantId: system.tenantId, permissions: [] });
      },
    },
  };
}
