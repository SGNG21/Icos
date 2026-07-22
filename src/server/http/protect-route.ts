import type { Permission, Role } from "@/core/identity";
import { AuthGuardError } from "@/server/auth/errors";
import { requirePermission, requireRole } from "@/server/auth/guards";
import { appendSecurityAudit, type SecurityAuditReason } from "@/server/auth/security-audit";
import type { Container } from "@/server/container";

import { authErrorResponse } from "./auth-response";
import { isSameOriginMutation } from "./origin";

type RouteRequirement =
  { permission: Permission; role?: never } | { permission?: never; role: Role };

type ProtectedRoute = RouteRequirement & {
  container: Container;
  request: Request;
  route: string;
  sameOrigin?: boolean;
};

function reasonFor(error: AuthGuardError): Exclude<SecurityAuditReason, "invalid_credentials"> {
  switch (error.code) {
    case "unauthenticated":
      return "missing_session";
    case "session_expired":
      return "expired_session";
    case "account_disabled":
      return "account_disabled";
    case "forbidden":
      return "forbidden";
  }
}

/** Applique le guard serveur et audite tout refus avec des métadonnées fermées. */
export async function protectRoute(input: ProtectedRoute): Promise<Response | null> {
  try {
    const session = input.permission
      ? await requirePermission(input.container, input.request.headers, input.permission)
      : await requireRole(input.container, input.request.headers, input.role);

    if (input.sameOrigin && !isSameOriginMutation(input.request)) {
      await appendSecurityAudit(input.container.audit, {
        eventType: "auth.access.denied",
        userId: session.user.id,
        method: input.request.method,
        route: input.route,
        ...(input.permission ? { permission: input.permission } : { role: input.role }),
        reason: "cross_origin",
      }).catch(() => {});
      return authErrorResponse(new AuthGuardError("forbidden"));
    }

    return null;
  } catch (error) {
    if (!(error instanceof AuthGuardError)) {
      throw error;
    }

    await appendSecurityAudit(input.container.audit, {
      eventType: "auth.access.denied",
      userId: error.userId,
      method: input.request.method,
      route: input.route,
      ...(input.permission ? { permission: input.permission } : { role: input.role }),
      reason: reasonFor(error),
    }).catch(() => {});
    return authErrorResponse(error);
  }
}
