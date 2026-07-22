import { getSessionCookie } from "better-auth/cookies";

import type { AuthenticatedSession, Permission, Role } from "@/core/identity";
import type { Container } from "@/server/container";

import { AuthorizationService } from "./authorization-service";
import { AuthGuardError } from "./errors";

const authorization = new AuthorizationService();

export async function requireSession(
  container: Pick<Container, "auth">,
  headers: Headers,
): Promise<AuthenticatedSession> {
  if (!container.auth) {
    throw new AuthGuardError("unauthenticated");
  }

  const hasCredential = getSessionCookie(headers, { cookiePrefix: "icos" }) !== null;
  if (!hasCredential) {
    throw new AuthGuardError("unauthenticated");
  }

  const session = await container.auth.readSession(headers);
  if (!session) {
    throw new AuthGuardError("session_expired");
  }
  if (session.user.status !== "active") {
    await container.auth.revokeUserSessions(session.user.id).catch(() => {});
    throw new AuthGuardError("account_disabled", session.user.id);
  }
  return session;
}

export async function requireRole(
  container: Pick<Container, "auth">,
  headers: Headers,
  requiredRole: Role,
): Promise<AuthenticatedSession> {
  const session = await requireSession(container, headers);
  if (!authorization.hasRole(session, requiredRole)) {
    throw new AuthGuardError("forbidden", session.user.id);
  }
  return session;
}

export async function requirePermission(
  container: Pick<Container, "auth">,
  headers: Headers,
  permission: Permission,
): Promise<AuthenticatedSession> {
  const session = await requireSession(container, headers);
  if (!authorization.can(session, permission)) {
    throw new AuthGuardError("forbidden", session.user.id);
  }
  return session;
}
