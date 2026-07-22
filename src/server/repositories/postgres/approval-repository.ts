import { eq } from "drizzle-orm";

import type { Approval } from "@/core/contracts";
import type { Database } from "@/server/database/client";
import { rowToApproval } from "@/server/database/mappers";
import { approvals } from "@/server/database/schema";
import type { ApprovalRepository } from "@/server/repositories/ports";

export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<Approval[]> {
    const rows = await this.db.select().from(approvals);
    return rows.map(rowToApproval);
  }

  async listForAction(actionId: string): Promise<Approval[]> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.actionId, actionId));
    return rows.map(rowToApproval);
  }
}
