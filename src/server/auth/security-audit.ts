import { randomUUID } from "node:crypto";

import type { AuditEntry } from "@/core/contracts";
import type { Permission, Role } from "@/core/identity";
import type { AuditRepository } from "@/server/repositories/ports";

export type SecurityAuditReason =
  | "invalid_credentials"
  | "account_disabled"
  | "missing_session"
  | "expired_session"
  | "forbidden"
  | "cross_origin";

type LoginSucceededAudit = {
  eventType: "auth.login.succeeded";
  userId: string;
};

type LoginRejectedAudit = {
  eventType: "auth.login.rejected";
  reason: "invalid_credentials" | "account_disabled";
  userId?: string;
};

type LogoutSucceededAudit = {
  eventType: "auth.logout.succeeded";
  userId: string;
};

type AccessDeniedAudit = {
  eventType: "auth.access.denied";
  userId?: string;
  method: string;
  route: string;
  permission?: Permission;
  role?: Role;
  reason: Exclude<SecurityAuditReason, "invalid_credentials">;
};

export type SecurityAuditInput =
  LoginSucceededAudit | LoginRejectedAudit | LogoutSucceededAudit | AccessDeniedAudit;

function detailsFor(input: SecurityAuditInput): AuditEntry["details"] {
  switch (input.eventType) {
    case "auth.login.succeeded":
    case "auth.logout.succeeded":
      return {};
    case "auth.login.rejected":
      return { reason: input.reason };
    case "auth.access.denied":
      return {
        method: input.method,
        route: input.route,
        ...(input.permission ? { permission: input.permission } : {}),
        ...(input.role ? { role: input.role } : {}),
        reason: input.reason,
      };
  }
}

/** Ajoute un événement auth à partir d'un ensemble fermé de données non sensibles. */
export async function appendSecurityAudit(
  audit: AuditRepository,
  input: SecurityAuditInput,
): Promise<AuditEntry> {
  return audit.append({
    id: `audit-${randomUUID()}`,
    occurredAt: new Date().toISOString(),
    eventType: input.eventType,
    actor: input.userId ? { kind: "human", id: input.userId } : { kind: "system", id: "icos-auth" },
    details: detailsFor(input),
  });
}
