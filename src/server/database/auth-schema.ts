import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Schéma Better Auth (généré par `auth generate` v1.6.23, puis intégré et revu)
 * + table ICOS `user_roles`.
 *
 * Divergences documentées :
 * - Better Auth utilise `timestamp` SANS fuseau (convention de la bibliothèque),
 *   contrairement aux tables métier ICOS en `timestamptz` — conservé tel quel
 *   pour correspondre EXACTEMENT aux attentes de Better Auth.
 * - Les identifiants (`user.id`, `session.id`, …) sont générés par Better Auth
 *   (aucune convention `user-` ICOS imposée).
 * - `session.token` est stocké NATIVEMENT par Better Auth (non haché au repos ;
 *   le cookie porte un token signé). Ne jamais l'exposer ni l'auditer.
 * - Le hash du mot de passe réside UNIQUEMENT dans `account.password` (scrypt
 *   Better Auth). Aucune table `credentials` ni hasher ICOS parallèle.
 */

export const user = pgTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(), // @classification C3
    email: text("email").notNull().unique(), // @classification C3
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    // Champ ICOS (via user.additionalFields ; jamais modifiable par une route
    // Better Auth publique — input:false). Distinct d'un rôle et d'un agent IA.
    status: text("status").default("active").notNull(),
  },
  (t) => [check("user_status_check", sql`${t.status} in ('active','disabled')`)],
);

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_userId_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("account_userId_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Rôles applicatifs ICOS (owner/admin/operator/viewer), multi-rôles. Table
 * ICOS distincte de Better Auth et **sans lien** avec `agents.authorization_level`.
 */
export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.role] }),
    check("user_roles_role_check", sql`${t.role} in ('owner','admin','operator','viewer')`),
    index("user_roles_role_idx").on(t.role),
  ],
);
