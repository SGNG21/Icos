import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import type { Database } from "@/server/database/client";
import { account, session, user, verification } from "@/server/database/auth-schema";

export interface BetterAuthConfig {
  secret: string;
  baseURL: string;
}

/**
 * Construit une instance Better Auth sur le handle Drizzle EXISTANT du container
 * (aucun second pool ; postgres.js se connecte paresseusement). Aucune connexion
 * n'est ouverte à l'import ; le cycle de vie du pool reste géré par le container.
 *
 * Better Auth prend en charge : email/mot de passe (hachage scrypt), sessions en
 * base révocables, cookies (préfixe `icos`, HttpOnly/Secure/SameSite), CSRF.
 * `session.cookieCache` est désactivé : la validation reste autoritaire en base.
 */
export function createBetterAuth(db: Database, config: BetterAuthConfig) {
  return betterAuth({
    secret: config.secret,
    baseURL: config.baseURL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    // `autoSignIn: false` : la création d'utilisateur (dont le bootstrap) ne crée
    // AUCUNE session durable ; la connexion se fera explicitement (Lot 2B-1b).
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      autoSignIn: false,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    user: {
      additionalFields: {
        status: { type: "string", required: true, defaultValue: "active", input: false },
      },
    },
    advanced: { cookiePrefix: "icos" },
  });
}

export type IcosBetterAuth = ReturnType<typeof createBetterAuth>;
