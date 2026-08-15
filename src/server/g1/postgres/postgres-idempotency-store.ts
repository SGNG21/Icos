import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { type IdempotencyEntry, type IdempotencyKey, type IdempotencyState } from "@/core/g1";
import type { Database } from "@/server/database/client";
import { idempotencyEntryToRow, rowToIdempotencyEntry } from "@/server/database/mappers";
import { idempotencyEntries } from "@/server/database/schema";
import type { IdempotencyStore } from "@/server/g1/ports";

/**
 * IdempotencyStore PostgreSQL.
 *
 * Les transitions atomiques sont garanties par UPDATE conditionnel :
 * la clause WHERE vérifie l'état attendu avant la mise à jour.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database | PostgresJsDatabase<Record<string, never>>) {}

  async reserve(entry: IdempotencyEntry): Promise<IdempotencyEntry | null> {
    try {
      await this.db.insert(idempotencyEntries).values(idempotencyEntryToRow(entry));
      return { ...entry };
    } catch {
      // Violation de contrainte PK → clé déjà existante
      return null;
    }
  }

  async transition(
    idempotencyKey: IdempotencyKey,
    expectedState: IdempotencyState,
    targetState: IdempotencyState,
    update: Partial<IdempotencyEntry>,
  ): Promise<IdempotencyEntry | null> {
    const now = new Date();
    const isTerminal =
      targetState === "COMPLETED" || targetState === "FAILED_SAFE" || targetState === "UNKNOWN";

    const rows = await this.db
      .update(idempotencyEntries)
      .set({
        state: targetState,
        updatedAt: now,
        ...(update.requestHash ? { requestHash: update.requestHash } : {}),
        ...(isTerminal ? { completedAt: now } : {}),
      })
      .where(
        and(
          eq(idempotencyEntries.idempotencyKey, idempotencyKey),
          eq(idempotencyEntries.state, expectedState),
        ),
      )
      .returning();

    if (rows.length === 0) {
      return null;
    }

    return rowToIdempotencyEntry(rows[0]);
  }

  async findByKey(idempotencyKey: IdempotencyKey): Promise<IdempotencyEntry | null> {
    const rows = await this.db
      .select()
      .from(idempotencyEntries)
      .where(eq(idempotencyEntries.idempotencyKey, idempotencyKey))
      .limit(1);

    return rows.length > 0 ? rowToIdempotencyEntry(rows[0]) : null;
  }

  async listByTenant(tenantId: string): Promise<IdempotencyEntry[]> {
    const rows = await this.db
      .select()
      .from(idempotencyEntries)
      .where(eq(idempotencyEntries.tenantId, tenantId));

    return rows.map(rowToIdempotencyEntry);
  }
}
