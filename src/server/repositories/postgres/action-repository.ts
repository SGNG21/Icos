import { and, asc, eq, inArray } from "drizzle-orm";

import type { AgentAction } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import { rowToAction } from "@/server/database/mappers";
import { actions } from "@/server/database/schema";
import type { ActionQuery, ActionRepository, AgentScope } from "@/server/repositories/ports";

export class PostgresActionRepository implements ActionRepository {
  constructor(private readonly db: Database) {}

  async list(filter?: ActionQuery): Promise<AgentAction[]> {
    // Ordre déterministe : created_at (= requestedAt) ASC, id ASC.
    const rows = filter?.approvalStatus
      ? await this.db
          .select()
          .from(actions)
          .where(eq(actions.approvalStatus, filter.approvalStatus))
          .orderBy(asc(actions.createdAt), asc(actions.id))
      : await this.db.select().from(actions).orderBy(asc(actions.createdAt), asc(actions.id));
    return rows.map(rowToAction);
  }

  async listForScope(scope: AgentScope, filter?: ActionQuery): Promise<AgentAction[]> {
    if (scope.kind === "global") {
      return this.list(filter);
    }

    const agentIds = [...scope.agentIds];
    if (agentIds.length === 0) {
      return [];
    }

    const scopeCondition = inArray(actions.initiatedByAgentId, agentIds);
    const rows = await this.db
      .select()
      .from(actions)
      .where(
        filter?.approvalStatus
          ? and(scopeCondition, eq(actions.approvalStatus, filter.approvalStatus))
          : scopeCondition,
      )
      .orderBy(asc(actions.createdAt), asc(actions.id));
    return rows.map(rowToAction);
  }

  async getById(id: string): Promise<AgentAction | null> {
    const rows = await this.db.select().from(actions).where(eq(actions.id, id)).limit(1);
    return rows[0] ? rowToAction(rows[0]) : null;
  }

  async getByIdForScope(id: string, scope: AgentScope): Promise<AgentAction | null> {
    const rows =
      scope.kind === "global"
        ? await this.db.select().from(actions).where(eq(actions.id, id)).limit(1)
        : scope.agentIds.size === 0
          ? []
          : await this.db
              .select()
              .from(actions)
              .where(
                and(eq(actions.id, id), inArray(actions.initiatedByAgentId, [...scope.agentIds])),
              )
              .limit(1);
    return rows[0] ? rowToAction(rows[0]) : null;
  }
}
