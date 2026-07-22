import { hasPermission } from "./permissions";
import type { Role } from "./roles";

/**
 * Règles PURES de gestion des rôles (autorisation « qui peut modifier quoi »).
 * L'invariant « au moins un owner actif » est une cohérence concurrente : il est
 * garanti transactionnellement par le repository (voir PostgresRoleRepository),
 * jamais par un simple « compter puis modifier » hors transaction.
 */

export type RoleChange = { kind: "grant"; role: Role } | { kind: "revoke"; role: Role };

export type ManageDecision = { ok: true } | { ok: false; reason: "forbidden" };

/**
 * Un simple `admin` ne peut ni promouvoir en `owner`, ni modifier un utilisateur
 * `owner` : ces opérations exigent la permission `owners.manage` (owner). Les
 * autres modifications de rôles exigent `users.manage` (admin+).
 */
export function canManageRoleChange(
  actorRoles: readonly Role[],
  change: RoleChange,
  target: { roles: readonly Role[] },
): ManageDecision {
  const touchesOwner = change.role === "owner" || target.roles.includes("owner");
  const permission = touchesOwner ? "owners.manage" : "users.manage";
  return hasPermission(actorRoles, permission) ? { ok: true } : { ok: false, reason: "forbidden" };
}

/**
 * Prédicat pur : l'opération retirerait-elle le DERNIER owner actif ? Utilisé
 * en complément de la garde transactionnelle du repository (jamais seul).
 */
export function wouldLeaveNoActiveOwner(input: {
  activeOwnerUserIds: readonly string[];
  targetUserId: string;
}): boolean {
  const owners = new Set(input.activeOwnerUserIds);
  return owners.has(input.targetUserId) && owners.size <= 1;
}
