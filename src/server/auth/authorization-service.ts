import {
  hasPermission,
  ROLE_RANK,
  type AuthenticatedSession,
  type Permission,
  type Role,
} from "@/core/identity";

/**
 * Autorisation applicative ICOS (PURE, sans I/O). Point d'entrée unique pour les
 * futurs guards HTTP (Lot 2B-1b), afin qu'ils ne dépendent pas directement de
 * `core/identity`. Un utilisateur désactivé ne dispose d'aucune permission.
 */
export class AuthorizationService {
  can(session: AuthenticatedSession, permission: Permission): boolean {
    if (session.user.status !== "active") {
      return false;
    }
    return hasPermission(session.roles, permission);
  }

  hasRole(session: AuthenticatedSession, role: Role): boolean {
    return (
      session.user.status === "active" &&
      session.roles.some((grantedRole) => ROLE_RANK[grantedRole] >= ROLE_RANK[role])
    );
  }
}
