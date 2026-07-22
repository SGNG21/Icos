import { asc, desc, eq } from "drizzle-orm";

import type { Agent } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import { rowToAgent } from "@/server/database/mappers";
import { agents } from "@/server/database/schema";
import type { AgentRepository } from "@/server/repositories/ports";

export class PostgresAgentRepository implements AgentRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<Agent[]> {
    // Ordre déterministe : authorization_level DESC, id ASC.
    const rows = await this.db
      .select()
      .from(agents)
      .orderBy(desc(agents.authorizationLevel), asc(agents.id));
    return rows.map(rowToAgent);
  }

  async getById(id: string): Promise<Agent | null> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }
}
