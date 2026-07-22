import { eq } from "drizzle-orm";

import { userStatusSchema, type AuthenticatedSession, type HumanUser } from "@/core/identity";
import type { Database } from "@/server/database/client";
import { session as sessionTable, user as userTable } from "@/server/database/auth-schema";

import type { IcosBetterAuth } from "./better-auth";
import type {
  AuthGateway,
  CreateHumanUserResult,
  HumanUserRepository,
  RoleRepository,
} from "./ports";

/** Utilisateur Better Auth projeté (inclut le champ additionnel `status`). */
interface BetterAuthUser {
  id: string;
  email: string;
  name?: string | null;
  status?: string | null;
}

function toHumanUser(u: BetterAuthUser): HumanUser | null {
  const status = userStatusSchema.safeParse(u.status);
  if (!status.success) {
    return null;
  }
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? undefined,
    status: status.data,
  };
}

/**
 * Façade étroite ICOS au-dessus de Better Auth. N'expose que les opérations
 * nécessaires ; les routes ICOS ne touchent jamais les internes de Better Auth.
 * La révocation de session s'appuie sur les sessions en base (cookieCache
 * désactivé → validation autoritaire côté serveur).
 */
export class AuthenticationService implements AuthGateway {
  constructor(
    private readonly auth: IcosBetterAuth,
    private readonly users: HumanUserRepository,
    private readonly roles: RoleRepository,
    private readonly db: Database,
  ) {}

  async createHumanUser(input: {
    email: string;
    password: string;
    name?: string;
  }): Promise<CreateHumanUserResult> {
    // Contrôle déterministe d'unicité (la contrainte UNIQUE reste le garde ultime).
    if (await this.users.findByEmail(input.email)) {
      return { ok: false, reason: "already_exists" };
    }
    try {
      const context = await this.auth.$context;
      const createdUser = await context.internalAdapter.createUser({
        email: input.email,
        name: input.name ?? input.email,
        emailVerified: false,
        status: "active",
      });
      const password = await context.password.hash(input.password);
      await context.internalAdapter.linkAccount({
        userId: createdUser.id,
        accountId: createdUser.id,
        providerId: "credential",
        password,
      });
      return { ok: true, userId: createdUser.id };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
      if (message.includes("exist") || message.includes("already")) {
        return { ok: false, reason: "already_exists" };
      }
      return { ok: false, reason: "invalid_input" };
    }
  }

  async readHumanUser(userId: string): Promise<HumanUser | null> {
    return this.users.findById(userId);
  }

  async readHumanUserByEmail(email: string): Promise<HumanUser | null> {
    return this.users.findByEmail(email);
  }

  async deleteHumanUser(userId: string): Promise<void> {
    // La cascade FK supprime account, session et user_roles.
    await this.db.delete(userTable).where(eq(userTable.id, userId));
  }

  async readSession(headers: Headers): Promise<AuthenticatedSession | null> {
    const result = await this.auth.api.getSession({ headers });
    if (!result?.user) {
      return null;
    }
    const user = toHumanUser(result.user as BetterAuthUser);
    if (!user) {
      return null;
    }
    const roles = await this.roles.listRoles(user.id);
    return { user, roles };
  }

  async revokeSession(headers: Headers): Promise<void> {
    await this.auth.api.signOut({ headers });
  }

  async revokeUserSessions(userId: string): Promise<void> {
    // Suppression des sessions en base : la validation étant autoritaire côté
    // serveur, l'utilisateur est immédiatement déconnecté.
    await this.db.delete(sessionTable).where(eq(sessionTable.userId, userId));
  }
}
