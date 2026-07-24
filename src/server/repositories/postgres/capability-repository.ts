import { asc, eq } from "drizzle-orm";

import {
  capabilitySchema,
  type Capability,
  type CapabilityStatus,
} from "@/core/contracts/capability";
import { compareCapabilities } from "@/core/ordering";
import type { Database } from "@/server/database/client";
import { RepositoryMappingError } from "@/server/database/errors";
import { capabilityToRow, rowToCapability } from "@/server/database/mappers";
import { capabilities } from "@/server/database/schema";
import type { CapabilityRepository } from "@/server/repositories/capability-ports";

/**
 * Repository PostgreSQL des capacités.
 *
 * Toute ligne lue est revalidée par Zod (`rowToCapability`) ; une ligne
 * invalide lève `RepositoryMappingError`.
 */
export class PostgresCapabilityRepository implements CapabilityRepository {
  constructor(private readonly db: Database) {}

  async list(): Promise<Capability[]> {
    const rows = await this.db
      .select()
      .from(capabilities)
      .orderBy(asc(capabilities.createdAt), asc(capabilities.id));
    return rows.map(rowToCapability).sort(compareCapabilities);
  }

  async getById(id: string): Promise<Capability | null> {
    const rows = await this.db.select().from(capabilities).where(eq(capabilities.id, id)).limit(1);
    return rows.length === 0 ? null : rowToCapability(rows[0]);
  }

  async getByKey(key: string): Promise<Capability | null> {
    const rows = await this.db
      .select()
      .from(capabilities)
      .where(eq(capabilities.key, key))
      .limit(1);
    return rows.length === 0 ? null : rowToCapability(rows[0]);
  }

  async create(capability: Capability): Promise<Capability> {
    const row = capabilityToRow(capability);
    try {
      const inserted = await this.db.insert(capabilities).values(row).returning();
      return rowToCapability(inserted[0]);
    } catch (error) {
      throw new RepositoryMappingError(
        "capabilities",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async updateStatus(id: string, status: CapabilityStatus): Promise<Capability | null> {
    const rows = await this.db
      .update(capabilities)
      .set({ status, updatedAt: new Date() })
      .where(eq(capabilities.id, id))
      .returning();
    return rows.length === 0 ? null : rowToCapability(rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .delete(capabilities)
      .where(eq(capabilities.id, id))
      .returning({ id: capabilities.id });
    return result.length > 0;
  }
}
