import type { Role } from "./roles";

/**
 * Permissions applicatives ICOS. Logique PURE, centrale, sans accès base.
 * `authentification` (qui) et `autorisation` (quoi) sont distinctes ;
 * l'autorisation métier d'un agent (`authorizationLevel`) reste séparée.
 */
export const PERMISSIONS = [
  "cockpit.read",
  "tasks.write", // création + transition
  "approvals.decide", // décisions / approbations
  "audit.read.limited",
  "audit.read.full",
  "agents.manage",
  "config.manage",
  "users.read",
  "users.create",
  "users.role.write",
  "users.status.write",
  "agentLinks.read",
  "agentLinks.write",
  "integrations.manage",
  // Capability registry (Lot C1).
  "capabilities.read",
  "capabilities.create",
  "capabilities.status.write",
  "agentCapabilities.read",
  "agentCapabilities.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Permissions PROPRES à chaque rôle (hors héritage) ; l'héritage est appliqué
// ci-dessous pour produire l'ensemble cumulé.
const OWN_PERMISSIONS: Record<Role, readonly Permission[]> = {
  viewer: ["cockpit.read", "audit.read.limited", "capabilities.read", "agentCapabilities.read"],
  operator: ["tasks.write", "approvals.decide", "audit.read.full"],
  admin: [
    "agents.manage",
    "config.manage",
    "users.read",
    "users.create",
    "users.role.write",
    "users.status.write",
    "agentLinks.read",
    "agentLinks.write",
    "integrations.manage",
    "capabilities.create",
    "capabilities.status.write",
    "agentCapabilities.write",
  ],
  owner: [],
};

const INHERITS: Record<Role, Role | null> = {
  viewer: null,
  operator: "viewer",
  admin: "operator",
  owner: "admin",
};

function cumulativePermissions(role: Role): ReadonlySet<Permission> {
  const set = new Set<Permission>();
  let current: Role | null = role;
  while (current !== null) {
    for (const permission of OWN_PERMISSIONS[current]) {
      set.add(permission);
    }
    current = INHERITS[current];
  }
  return set;
}

/** Matrice cumulée rôle → permissions (héritage hiérarchique appliqué). */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  viewer: cumulativePermissions("viewer"),
  operator: cumulativePermissions("operator"),
  admin: cumulativePermissions("admin"),
  owner: cumulativePermissions("owner"),
};

/** Vrai si l'un des rôles confère la permission demandée. */
export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].has(permission));
}
