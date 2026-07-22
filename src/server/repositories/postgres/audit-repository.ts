import { and, asc, eq, type SQL } from "drizzle-orm";

import { auditEntrySchema, type AuditEntry } from "@/core/contracts";
import type { AuditQuery } from "@/server/audit/in-memory-audit-log";
import type { Database } from "@/server/database/client";
import { auditToRow, rowToAuditEntry } from "@/server/database/mappers";
import { auditEntries } from "@/server/database/schema";
import type { AuditRepository } from "@/server/repositories/ports";

/**
 * Repository d'audit PostgreSQL. Append-only au niveau applicatif : il n'expose
 * AUCUNE méthode de modification ou de suppression. Une protection SQL (trigger)
 * complète cette garantie au Lot 2A-2b.
 */
export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly db: Database) {}

  async append(entry: AuditEntry): Promise<AuditEntry> {
    const validated = auditEntrySchema.parse(entry);
    await this.db.insert(auditEntries).values(auditToRow(validated));
    return validated;
  }

  async appendMany(entries: readonly AuditEntry[]): Promise<AuditEntry[]> {
    const validated = entries.map((entry) => auditEntrySchema.parse(entry));
    if (validated.length > 0) {
      await this.db.insert(auditEntries).values(validated.map(auditToRow));
    }
    return validated;
  }

  async list(): Promise<AuditEntry[]> {
    // Ordre déterministe : occurred_at ASC, id ASC (chronologique).
    const rows = await this.db
      .select()
      .from(auditEntries)
      .orderBy(asc(auditEntries.occurredAt), asc(auditEntries.id));
    return rows.map(rowToAuditEntry);
  }

  async query(filter: AuditQuery): Promise<AuditEntry[]> {
    const conditions: SQL[] = [];
    if (filter.eventType !== undefined) {
      conditions.push(eq(auditEntries.eventType, filter.eventType));
    }
    if (filter.actorId !== undefined) {
      conditions.push(eq(auditEntries.actorLabel, filter.actorId));
    }
    if (filter.taskId !== undefined) {
      conditions.push(eq(auditEntries.taskId, filter.taskId));
    }
    if (filter.actionId !== undefined) {
      conditions.push(eq(auditEntries.actionId, filter.actionId));
    }

    const rows = await this.db
      .select()
      .from(auditEntries)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(auditEntries.occurredAt), asc(auditEntries.id));
    return rows.map(rowToAuditEntry);
  }
}
