import { eq } from "drizzle-orm";

import type { AgentAction } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import { rowToAction } from "@/server/database/mappers";
import { actions } from "@/server/database/schema";
import type { ActionQuery, ActionRepository } from "@/server/repositories/ports";

export class PostgresActionRepository implements ActionRepository {
  constructor(private readonly db: Database) {}

  async list(filter?: ActionQuery): Promise<AgentAction[]> {
    const rows = filter?.approvalStatus
      ? await this.db
          .select()
          .from(actions)
          .where(eq(actions.approvalStatus, filter.approvalStatus))
      : await this.db.select().from(actions);
    return rows.map(rowToAction);
  }

  async getById(id: string): Promise<AgentAction | null> {
    const rows = await this.db.select().from(actions).where(eq(actions.id, id)).limit(1);
    return rows[0] ? rowToAction(rows[0]) : null;
  }
}
