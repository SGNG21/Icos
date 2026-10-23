import { BRAIN_ROLES } from "@/core/workforce/brains";

import type { WorkforceSnapshot } from "./read-model";

export interface BrainRoleStatus {
  readonly roleId: string;
  readonly version: string;
  readonly status: string;
}

/**
 * Projette le statut des 9 rôles de cerveaux depuis un `WorkforceSnapshot`. Fonction unique
 * partagée par `/status` et `/brains/activate` : une seule définition de ce que signifie
 * « pas encore vu » (`not-bootstrapped`) pour un rôle absent du snapshot.
 */
export function brainRoleStatuses(snapshot: WorkforceSnapshot): readonly BrainRoleStatus[] {
  return BRAIN_ROLES.map((b) => {
    const found = snapshot.roles.find((r) => r.roleId === b.roleId && r.version === b.version);
    return { roleId: b.roleId, version: b.version, status: found?.status ?? "not-bootstrapped" };
  });
}

export function allBrainRolesActive(statuses: readonly BrainRoleStatus[]): boolean {
  return statuses.every((r) => r.status === "active");
}
