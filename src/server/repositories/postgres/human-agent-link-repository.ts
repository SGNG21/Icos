import { asc, eq } from "drizzle-orm";

import { humanAgentLinkSchema, type HumanAgentLink } from "@/core/identity";
import type { Database } from "@/server/database/client";
import { humanAgentLinks } from "@/server/database/schema";
import type { HumanAgentLinkRepository } from "@/server/repositories/ports";

type HumanAgentLinkRow = typeof humanAgentLinks.$inferSelect;

function rowToHumanAgentLink(row: HumanAgentLinkRow): HumanAgentLink {
  return humanAgentLinkSchema.parse({
    id: row.id,
    humanUserId: row.humanUserId,
    agentId: row.agentId,
    relation: row.relation,
    createdAt: row.createdAt.toISOString(),
    createdByHumanUserId: row.createdByHumanUserId,
  });
}

export class PostgresHumanAgentLinkRepository implements HumanAgentLinkRepository {
  constructor(private readonly db: Database) {}

  async listForHuman(humanUserId: string): Promise<HumanAgentLink[]> {
    const rows = await this.db
      .select()
      .from(humanAgentLinks)
      .where(eq(humanAgentLinks.humanUserId, humanUserId))
      .orderBy(asc(humanAgentLinks.createdAt), asc(humanAgentLinks.id));
    return rows.map(rowToHumanAgentLink);
  }

  async listAgentIdsForHuman(humanUserId: string): Promise<ReadonlySet<string>> {
    const rows = await this.db
      .select({ agentId: humanAgentLinks.agentId })
      .from(humanAgentLinks)
      .where(eq(humanAgentLinks.humanUserId, humanUserId))
      .orderBy(asc(humanAgentLinks.agentId));
    return new Set(rows.map(({ agentId }) => agentId));
  }
}
