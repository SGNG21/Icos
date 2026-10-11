import { asc, desc, eq, inArray } from "drizzle-orm";

import { agentSchema, type Agent } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import { agentToRow, rowToAgent } from "@/server/database/mappers";
import { agents } from "@/server/database/schema";
import type { AgentRegistration, AgentRepository, AgentScope } from "@/server/repositories/ports";

export class PostgresAgentRepository implements AgentRepository, AgentRegistration {
  constructor(private readonly db: Database) {}

  async list(): Promise<Agent[]> {
    // Ordre déterministe : authorization_level DESC, id ASC.
    const rows = await this.db
      .select()
      .from(agents)
      .orderBy(desc(agents.authorizationLevel), asc(agents.id));
    return rows.map(rowToAgent);
  }

  async listForScope(scope: AgentScope): Promise<Agent[]> {
    if (scope.kind === "global") {
      return this.list();
    }

    const agentIds = [...scope.agentIds];
    if (agentIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .select()
      .from(agents)
      .where(inArray(agents.id, agentIds))
      .orderBy(desc(agents.authorizationLevel), asc(agents.id));
    return rows.map(rowToAgent);
  }

  async getById(id: string): Promise<Agent | null> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async getByIdForScope(id: string, scope: AgentScope): Promise<Agent | null> {
    if (scope.kind === "linked" && !scope.agentIds.has(id)) {
      return null;
    }

    const rows = await this.db.select().from(agents).where(eq(agents.id, id)).limit(1);
    return rows[0] ? rowToAgent(rows[0]) : null;
  }

  async ensureRegistered(agent: Agent): Promise<"created" | "present"> {
    const inserted = await this.db
      .insert(agents)
      .values(agentToRow(agentSchema.parse(agent)))
      .onConflictDoNothing({ target: agents.id })
      .returning({ id: agents.id });
    return inserted.length === 1 ? "created" : "present";
  }
}
