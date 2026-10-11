import { asc } from "drizzle-orm";

import { measureFleet, type FleetReadiness } from "@/core/workers/fleet-readiness";
import type { Database } from "@/server/database/client";
import { workers } from "@/server/database/schema";
import { rowToWorker } from "@/server/repositories/postgres/worker-registry-store";

/**
 * Reads the durable fleet and measures it with the canonical eligibility rules.
 *
 * ONE query over `workers`, mapped through the store's own validated mapper, then the
 * pure `measureFleet`. A row that violates the contract raises RepositoryMappingError
 * here exactly as it would on the routing path: a readiness figure computed over rows
 * routing would refuse to read would be a figure about a different fleet.
 *
 * Read-only. `workers` has no tenant column (decision 0064, Consequences): a worker is a
 * runtime execution unit and isolation is per database, so no tenant context applies.
 */
export async function readFleetReadiness(db: Database, now: Date): Promise<FleetReadiness> {
  const rows = await db.select().from(workers).orderBy(asc(workers.id));
  return measureFleet(rows.map(rowToWorker), now);
}

export type { FleetReadiness, ProviderReadiness } from "@/core/workers/fleet-readiness";
