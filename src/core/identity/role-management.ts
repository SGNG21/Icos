import { highestRole, ROLE_RANK, type Role } from "./roles";

export type AdministrationOperation = "create" | "role" | "status" | "links";

export type AdministrationDecision = { ok: true } | { ok: false; reason: "forbidden" };

const forbidden: AdministrationDecision = { ok: false, reason: "forbidden" };

export function canCreateRole(
  actorRoles: readonly Role[],
  requestedRole: Role,
): AdministrationDecision {
  const actorRole = highestRole(actorRoles);
  if (actorRole === "owner") {
    return { ok: true };
  }

  return actorRole === "admin" && ROLE_RANK[requestedRole] < ROLE_RANK.admin
    ? { ok: true }
    : forbidden;
}

export function canAdministerTarget(input: {
  actorUserId: string;
  actorRoles: readonly Role[];
  targetUserId: string;
  targetRoles: readonly Role[];
}): AdministrationDecision {
  if (input.actorUserId === input.targetUserId) {
    return forbidden;
  }

  const actorRole = highestRole(input.actorRoles);
  const targetRole = highestRole(input.targetRoles);
  if (actorRole === null || targetRole === null) {
    return forbidden;
  }

  if (actorRole === "owner") {
    return { ok: true };
  }

  return actorRole === "admin" && ROLE_RANK[targetRole] < ROLE_RANK.admin
    ? { ok: true }
    : forbidden;
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
