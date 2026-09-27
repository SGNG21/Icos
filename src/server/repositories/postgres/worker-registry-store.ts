import { asc } from "drizzle-orm";
import { eq } from "drizzle-orm";

import {
  workerRegistryEntrySchema,
  type WorkerRegistryEntry,
} from "@/core/contracts/worker-registry";
import type { Database } from "@/server/database/client";
import { RepositoryMappingError } from "@/server/database/errors";
import { workers, type WorkerRow } from "@/server/database/schema";
import type { WorkerRegistryStore } from "@/server/repositories/worker-ports";

/**
 * Durable worker registry store (migration 0042, decision 0031).
 *
 * Every row read back is revalidated by Zod: a row that does not satisfy the
 * contract raises RepositoryMappingError rather than silently entering the
 * routing pool. Routing on an unvalidated row is how a worker with a garbage
 * health value becomes eligible.
 */
export class PostgresWorkerRegistryStore implements WorkerRegistryStore {
  constructor(private readonly db: Database) {}

  async list(): Promise<WorkerRegistryEntry[]> {
    const rows = await this.db.select().from(workers).orderBy(asc(workers.id));
    return rows.map((row) => rowToWorker(row));
  }

  async get(id: string): Promise<WorkerRegistryEntry | null> {
    const rows = await this.db.select().from(workers).where(eq(workers.id, id)).limit(1);
    return rows.length === 0 ? null : rowToWorker(rows[0]);
  }

  async upsert(worker: WorkerRegistryEntry): Promise<WorkerRegistryEntry> {
    const row = workerToRow(worker);
    try {
      const upserted = await this.db
        .insert(workers)
        .values(row)
        .onConflictDoUpdate({ target: workers.id, set: row })
        .returning();
      return rowToWorker(upserted[0]);
    } catch (error) {
      throw new RepositoryMappingError(
        "workers",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async remove(id: string): Promise<boolean> {
    const deleted = await this.db.delete(workers).where(eq(workers.id, id)).returning();
    return deleted.length > 0;
  }
}

function workerToRow(worker: WorkerRegistryEntry): typeof workers.$inferInsert {
  const parsed = workerRegistryEntrySchema.parse(worker);
  return {
    id: parsed.id,
    workerKind: parsed.workerKind,
    displayName: parsed.displayName,
    capabilities: parsed.capabilities,
    features: parsed.features,
    supportsTools: parsed.supportsTools,
    supportsStructuredOutput: parsed.supportsStructuredOutput,
    status: parsed.status,
    runtime: parsed.runtime,
    runtimeSupport: parsed.runtimeSupport,
    health: parsed.health,
    availability: parsed.availability,
    tags: parsed.tags,
    metadata: parsed.metadata,
    lastProbeAt: parsed.lastProbeAt ? new Date(parsed.lastProbeAt) : null,
    lastProbeOutcome: parsed.lastProbeOutcome,
    maxConcurrency: parsed.maxConcurrency,
    capacityPool: parsed.capacityPool,
    capacityPoolLimit: parsed.capacityPoolLimit,
    updatedAt: new Date(parsed.updatedAt),
  };
}

function rowToWorker(row: WorkerRow): WorkerRegistryEntry {
  const result = workerRegistryEntrySchema.safeParse({
    id: row.id,
    workerKind: row.workerKind,
    displayName: row.displayName,
    capabilities: row.capabilities,
    features: row.features,
    supportsTools: row.supportsTools,
    supportsStructuredOutput: row.supportsStructuredOutput,
    status: row.status,
    runtime: row.runtime,
    runtimeSupport: row.runtimeSupport,
    health: row.health,
    availability: row.availability,
    tags: row.tags,
    metadata: row.metadata,
    lastProbeAt: row.lastProbeAt ? row.lastProbeAt.toISOString() : null,
    lastProbeOutcome: row.lastProbeOutcome,
    maxConcurrency: row.maxConcurrency,
    capacityPool: row.capacityPool,
    capacityPoolLimit: row.capacityPoolLimit,
    updatedAt: row.updatedAt.toISOString(),
  });

  if (!result.success) {
    throw new RepositoryMappingError("workers", result.error.message);
  }

  return result.data;
}
