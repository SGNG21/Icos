import { eq } from "drizzle-orm";

import { humanUserSchema, type HumanUser } from "@/core/identity";
import type { Database } from "@/server/database/client";
import { user } from "@/server/database/auth-schema";
import type { HumanUserRepository } from "@/server/auth/ports";

type UserRow = typeof user.$inferSelect;

function rowToHumanUser(row: UserRow): HumanUser {
  return humanUserSchema.parse({
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
  });
}

export class PostgresHumanUserRepository implements HumanUserRepository {
  constructor(private readonly db: Database) {}

  async findById(id: string): Promise<HumanUser | null> {
    const rows = await this.db.select().from(user).where(eq(user.id, id)).limit(1);
    return rows[0] ? rowToHumanUser(rows[0]) : null;
  }

  async findByEmail(email: string): Promise<HumanUser | null> {
    const rows = await this.db.select().from(user).where(eq(user.email, email)).limit(1);
    return rows[0] ? rowToHumanUser(rows[0]) : null;
  }
}
