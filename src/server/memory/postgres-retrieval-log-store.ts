import { and, desc, eq } from "drizzle-orm";

import type { Database } from "@/server/database/client";
import { memoryRetrievalLog as t } from "@/server/database/memory-schema";
import type { RetrievalLogRow, RetrievalLogStore } from "./ports";
import { normalizeRow } from "./sql";

/** Trace append-only des retrievals (trigger `IC002`). */
export class PostgresRetrievalLogStore implements RetrievalLogStore {
  constructor(private readonly db: Database) {}

  async append(r: RetrievalLogRow): Promise<void> {
    await this.db.insert(t).values({
      id: r.id,
      tenantId: r.tenantId,
      memoryType: r.memoryType,
      requesterType: r.requesterType,
      requesterId: r.requesterId,
      onBehalfOfUserId: r.onBehalfOfUserId,
      purpose: r.purpose,
      missionId: r.missionId,
      query: r.query,
      result: [...r.result],
      returnedCount: r.result.length,
      stats: r.stats,
      retrievedAt: new Date(r.retrievedAt),
    });
  }

  async listByRequester(
    tenantId: string,
    requesterId: string,
    limit = 50,
  ): Promise<RetrievalLogRow[]> {
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.tenantId, tenantId), eq(t.requesterId, requesterId)))
      .orderBy(desc(t.retrievedAt), desc(t.id))
      .limit(limit);
    return rows.map((row) => {
      const n = normalizeRow(row);
      const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
      return {
        id: row.id,
        tenantId: row.tenantId,
        memoryType: row.memoryType as RetrievalLogRow["memoryType"],
        requesterType: row.requesterType as RetrievalLogRow["requesterType"],
        requesterId: row.requesterId,
        onBehalfOfUserId: row.onBehalfOfUserId,
        purpose: row.purpose,
        missionId: row.missionId,
        query: json(row.query) as RetrievalLogRow["query"],
        result: json(row.result) as RetrievalLogRow["result"],
        stats: json(row.stats) as RetrievalLogRow["stats"],
        retrievedAt: n.retrievedAt as string,
      };
    });
  }
}
