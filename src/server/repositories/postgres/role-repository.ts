import { and, eq } from "drizzle-orm";

import { roleSchema, type Role, type UserStatus } from "@/core/identity";
import type { Database } from "@/server/database/client";
import { user, userRoles } from "@/server/database/auth-schema";
import type { GuardedResult, RoleRepository } from "@/server/auth/ports";

/**
 * Rôles ICOS sur PostgreSQL. Les opérations pouvant retirer le dernier owner
 * actif sont exécutées dans une TRANSACTION verrouillant les lignes des owners
 * actifs (`SELECT … FOR UPDATE`) — jamais un simple « compter puis modifier ».
 */
export class PostgresRoleRepository implements RoleRepository {
  constructor(private readonly db: Database) {}

  async listRoles(userId: string): Promise<Role[]> {
    const rows = await this.db
      .select({ role: userRoles.role })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    return rows.map((r) => roleSchema.parse(r.role));
  }

  async grantRole(userId: string, role: Role): Promise<void> {
    await this.db
      .insert(userRoles)
      .values({ userId, role, grantedAt: new Date() })
      .onConflictDoNothing();
  }

  async listActiveOwnerIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: userRoles.userId })
      .from(userRoles)
      .innerJoin(user, eq(user.id, userRoles.userId))
      .where(and(eq(userRoles.role, "owner"), eq(user.status, "active")));
    return rows.map((r) => r.id);
  }

  async revokeRole(userId: string, role: Role): Promise<GuardedResult> {
    return this.db.transaction(async (tx) => {
      if (role === "owner") {
        const locked = await tx
          .select({ id: userRoles.userId })
          .from(userRoles)
          .innerJoin(user, eq(user.id, userRoles.userId))
          .where(and(eq(userRoles.role, "owner"), eq(user.status, "active")))
          .for("update");
        const owners = new Set(locked.map((r) => r.id));
        if (owners.has(userId) && owners.size <= 1) {
          return { ok: false, reason: "last_owner" };
        }
      }
      const deleted = await tx
        .delete(userRoles)
        .where(and(eq(userRoles.userId, userId), eq(userRoles.role, role)))
        .returning({ id: userRoles.userId });
      return deleted.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
    });
  }

  async setUserStatus(userId: string, status: UserStatus): Promise<GuardedResult> {
    return this.db.transaction(async (tx) => {
      if (status === "disabled") {
        const locked = await tx
          .select({ id: userRoles.userId })
          .from(userRoles)
          .innerJoin(user, eq(user.id, userRoles.userId))
          .where(and(eq(userRoles.role, "owner"), eq(user.status, "active")))
          .for("update");
        const owners = new Set(locked.map((r) => r.id));
        if (owners.has(userId) && owners.size <= 1) {
          return { ok: false, reason: "last_owner" };
        }
      }
      const updated = await tx
        .update(user)
        .set({ status })
        .where(eq(user.id, userId))
        .returning({ id: user.id });
      return updated.length > 0 ? { ok: true } : { ok: false, reason: "not_found" };
    });
  }
}
