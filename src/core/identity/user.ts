import { z } from "zod";

import { roleSchema } from "./roles";

/**
 * Contrats d'identité humaine (PURS : aucun import Better Auth / Drizzle / Next /
 * postgres.js / cookies / headers). Les identifiants sont ceux générés par
 * Better Auth (aucune convention `user-` imposée).
 */

export const userStatusSchema = z.enum(["active", "disabled"]);
export type UserStatus = z.infer<typeof userStatusSchema>;

export const humanUserSchema = z.object({
  id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().optional(),
  status: userStatusSchema,
});
export type HumanUser = z.infer<typeof humanUserSchema>;

/** Session authentifiée projetée pour ICOS (indépendante de Better Auth). */
export const authenticatedSessionSchema = z.object({
  user: humanUserSchema,
  roles: z.array(roleSchema),
});
export type AuthenticatedSession = z.infer<typeof authenticatedSessionSchema>;
