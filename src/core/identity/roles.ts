import { z } from "zod";

/**
 * Rôles applicatifs humains ICOS, hiérarchiques : owner ⊇ admin ⊇ operator ⊇
 * viewer. Aucun rapport avec `Agent.authorizationLevel` (autorisation métier
 * d'un agent IA) ni avec un quelconque rôle interne de Better Auth.
 */
export const roleSchema = z.enum(["owner", "admin", "operator", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

/** Rang hiérarchique (plus élevé = plus de droits). */
export const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
  owner: 3,
};

/** Rôle effectif le plus élevé d'un ensemble (ou `null` si vide). */
export function highestRole(roles: readonly Role[]): Role | null {
  return roles.reduce<Role | null>(
    (best, role) => (best === null || ROLE_RANK[role] > ROLE_RANK[best] ? role : best),
    null,
  );
}
