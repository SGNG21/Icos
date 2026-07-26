import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { ExecutionRecord, IdempotencyKey } from "@/core/g1";
import type { Database } from "@/server/database/client";
import {
  executionRecordToRow,
  rowToExecutionRecord,
} from "@/server/database/mappers";
import { executionRecords } from "@/server/database/schema";
import type { ExecutionRecordStore } from "@/server/g1/ports";

/**
 * ExecutionRecordStore PostgreSQL.
 *
 * Append-only au niveau applicatif : chaque appel à append() ajoute une
 * nouvelle ligne. La contrainte PK évite les doublons.
 */
export class PostgresExecutionRecordStore implements ExecutionRecordStore {
  constructor(private readonly db: Database | PostgresJsDatabase<Record<string, never>>) {}

  async append(record: ExecutionRecord): Promise<void> {
    try {
      await this.db.insert(executionRecords).values(executionRecordToRow(record));
    } catch {
      // Si le record existe déjà (doublon), on ne lance pas d'erreur
      // car l'append-only garantit l'immutabilité
      throw new Error(`ExecutionRecord ${record.id} already exists (append-only)`);
    }
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.id, id))
      .limit(1);

    return rows.length > 0 ? rowToExecutionRecord(rows[0]) : null;
  }

  async findByIdempotencyKey(idempotencyKey: IdempotencyKey): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.idempotencyKey, idempotencyKey));

    return rows.map(rowToExecutionRecord);
  }

  async listByTenant(tenantId: string): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.tenantId, tenantId));

    return rows.map(rowToExecutionRecord);
  }
}
