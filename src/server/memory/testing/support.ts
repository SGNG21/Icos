import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { missions } from "@/server/database/schema";

/**
 * Support des tests PostgreSQL de la mémoire (Phase 7B). Base de test uniquement
 * (`createDatabase` refuse toute base non « test » sous Vitest).
 */
export const TENANT = "default";
export const OTHER_TENANT = "tenant-b";

export function openTestDb(): DatabaseHandle {
  return createDatabase(TEST_DATABASE_URL, { max: 12 });
}

/** TRUNCATE (les triggers append-only ne se déclenchent pas sur TRUNCATE). */
export async function resetMemory(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql`TRUNCATE TABLE memory_retrieval_log, procedural_memory_evidence, procedural_memory_entries,
        business_memory_entries, mission_memory_entries, missions RESTART IDENTITY CASCADE`,
  );
}

export async function insertMission(handle: DatabaseHandle, id: string): Promise<void> {
  const now = new Date("2026-09-19T10:00:00.000Z");
  await handle.db.insert(missions).values({
    id,
    title: `Mission ${id}`,
    objective: "test",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });
}
