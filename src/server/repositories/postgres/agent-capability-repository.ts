import { asc, eq } from "drizzle-orm";

import { type AgentCapability } from "@/core/contracts/capability";
import type { Database } from "@/server/database/client";
import { RepositoryMappingError } from "@/server/database/errors";
import { agentCapabilityToRow, rowToAgentCapability } from "@/server/database/mappers";
import { agentCapabilities } from "@/server/database/schema";
import type { AgentCapabilityRepository } from "@/server/repositories/capability-ports";

/**
 * Repository PostgreSQL des assignations capacité ↔ agent.
 *
 * Toute ligne lue est revalidée par Zod (`rowToAgentCapability`) ; une ligne
 * invalide lève `RepositoryMappingError`.
 */
export class PostgresAgentCapabilityRepository implements AgentCapabilityRepository {
  constructor(private readonly db: Database) {}

  async listByAgent(agentId: string): Promise<AgentCapability[]> {
    const rows = await this.db
      .select()
      .from(agentCapabilities)
      .where(eq(agentCapabilities.agentId, agentId))
      .orderBy(asc(agentCapabilities.assignedAt));
    return rows.map(rowToAgentCapability);
  }

  async getById(id: string): Promise<AgentCapability | null> {
    const rows = await this.db
      .select()
      .from(agentCapabilities)
      .where(eq(agentCapabilities.id, id))
      .limit(1);
    return rows.length === 0 ? null : rowToAgentCapability(rows[0]);
  }

  async grant(agentCapability: AgentCapability): Promise<AgentCapability> {
    const row = agentCapabilityToRow(agentCapability);
    try {
      const inserted = await this.db.insert(agentCapabilities).values(row).returning();
      return rowToAgentCapability(inserted[0]);
    } catch (error) {
      throw new RepositoryMappingError(
        "agent_capabilities",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.db
      .delete(agentCapabilities)
      .where(eq(agentCapabilities.id, id))
      .returning({ id: agentCapabilities.id });
    return result.length > 0;
  }
}
