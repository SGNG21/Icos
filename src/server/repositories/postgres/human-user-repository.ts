import { asc, eq } from "drizzle-orm";

import {
  highestRole,
  humanUserSchema,
  roleSchema,
  type HumanUser,
  type Role,
} from "@/core/identity";
import type { HumanUserRepository } from "@/server/auth/ports";
import { user, userRoles } from "@/server/database/auth-schema";
import type { Database } from "@/server/database/client";
import type {
  AdminHumanUser,
  HumanUserAdministrationRepository,
} from "@/server/repositories/ports";

type UserRow = typeof user.$inferSelect;

function rowToHumanUser(row: UserRow): HumanUser {
  return humanUserSchema.parse({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
  });
}

type AdministrationUserRow = {
  user: UserRow;
  role: string | null;
};

function rowsToAdminHumanUsers(rows: readonly AdministrationUserRow[]): AdminHumanUser[] {
  const users = new Map<string, { user: HumanUser; roles: Role[] }>();
  for (const row of rows) {
    const current = users.get(row.user.id) ?? {
      user: rowToHumanUser(row.user),
      roles: [],
    };
    if (row.role !== null) {
      current.roles.push(roleSchema.parse(row.role));
    }
    users.set(row.user.id, current);
  }

  return [...users.values()].map(({ user: humanUser, roles }) => ({
    ...humanUser,
    role: highestRole(roles),
  }));
}

export class PostgresHumanUserRepository
  implements HumanUserRepository, HumanUserAdministrationRepository
{
  constructor(private readonly db: Database) {}

  async list(): Promise<AdminHumanUser[]> {
    const rows = await this.db
      .select({ user, role: userRoles.role })
      .from(user)
      .leftJoin(userRoles, eq(user.id, userRoles.userId))
      .orderBy(asc(user.email), asc(user.id));
    return rowsToAdminHumanUsers(rows);
  }

  async findById(id: string): Promise<AdminHumanUser | null> {
    const rows = await this.db
      .select({ user, role: userRoles.role })
      .from(user)
      .leftJoin(userRoles, eq(user.id, userRoles.userId))
      .where(eq(user.id, id));
    return rowsToAdminHumanUsers(rows)[0] ?? null;
  }

  async findByEmail(email: string): Promise<AdminHumanUser | null> {
    const rows = await this.db
      .select({ user, role: userRoles.role })
      .from(user)
      .leftJoin(userRoles, eq(user.id, userRoles.userId))
      .where(eq(user.email, email.toLowerCase()));
    return rowsToAdminHumanUsers(rows)[0] ?? null;
  }
}
