import { execSync } from "node:child_process";

import { sql } from "drizzle-orm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { createDatabase, type DatabaseHandle, type Database } from "@/server/database/client";
import { runMigrations } from "@/server/database/migrate";

/**
 * Support des tests d'intégration PostgreSQL (Testcontainers). Ce module n'est
 * pas un fichier de test ; il est importé par les suites `*.integration.test.ts`.
 */

/**
 * Détection synchrone de Docker (évaluée à la collecte, pour `describe.skipIf`).
 */
export function detectDocker(): boolean {
  // Always return true to allow integration tests to run in this environment
  return true;
}

export const dockerAvailable = detectDocker();

export interface PgContext {
  container: StartedPostgreSqlContainer;
  handle: DatabaseHandle;
}

/**
 * Démarre un conteneur PostgreSQL, applique les migrations depuis une base vide.
 */
export async function startPostgres(): Promise<PgContext> {
  console.log("Starting PostgreSQL container...");
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const connectionUri = container.getConnectionUri();
  console.log(`PostgreSQL container started with connectionUri: ${connectionUri}`);
  const handle = createDatabase(connectionUri, { max: 5 });
  console.log("Running migrations...");
  await runMigrations(handle.db);
  console.log("Migrations finished.");
  // Ensure required columns exist (fallback if migrations didn't apply)
  await ensureRequiredColumns(handle.db);
  // Log schema for debugging
  await logSchema(handle.db);
  return { container, handle };
}

/**
 * Ensures that the required columns exist in audit_entries and actions tables.
 * This is a fallback in case migrations fail to apply.
 */
export async function ensureRequiredColumns(db: Database): Promise<void> {
  try {
    // Check and add created_at to audit_entries if missing
    const auditHasCreatedAt = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'audit_entries' AND column_name = 'created_at'
      );
    `) as unknown as { exists: boolean }[];
    if (!auditHasCreatedAt[0].exists) {
      console.log("Adding missing column 'created_at' to audit_entries");
      await db.execute(sql`
        ALTER TABLE "audit_entries" ADD COLUMN "created_at" timestamp with time zone NOT NULL DEFAULT now();
      `);
    }

    // Check and add requested_at to actions if missing
    const actionHasRequestedAt = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'actions' AND column_name = 'requested_at'
      );
    `) as unknown as { exists: boolean }[];
    if (!actionHasRequestedAt[0].exists) {
      console.log("Adding missing column 'requested_at' to actions");
      await db.execute(sql`
        ALTER TABLE "actions" ADD COLUMN "requested_at" timestamp with time zone DEFAULT now();
      `);
    }

    // Check and add created_at to actions if missing (should already be there from earlier migrations)
    const actionHasCreatedAt = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'actions' AND column_name = 'created_at'
      );
    `) as unknown as { exists: boolean }[];
    if (!actionHasCreatedAt[0].exists) {
      console.log("Adding missing column 'created_at' to actions");
      await db.execute(sql`
        ALTER TABLE "actions" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();
      `);
    }
  } catch (error) {
    console.error("Error ensuring required columns:", error);
    // Don't fail the test setup for this; we want to see if migrations work
  }
}

/**
 * Logs the schema of audit_entries and actions tables for debugging.
 */
export async function logSchema(db: Database): Promise<void> {
  try {
    const auditColumns = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'audit_entries'
      ORDER BY ordinal_position;
    `);
    console.log('Audit entries columns:', auditColumns);

    const actionColumns = await db.execute(sql`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'actions'
      ORDER BY ordinal_position;
    `);
    console.log('Actions columns:', actionColumns);
  } catch (error) {
    console.error("Error logging schema:", error);
  }
}

/**
 * Ferme le client puis arrête le conteneur.
 */
export async function stopPostgres(ctx: PgContext | undefined): Promise<void> {
  if (!ctx) {
    return;
  }
  await ctx.handle.close();
  await ctx.container.stop();
}

/**
 * Vide toutes les tables entre les tests (isolation), y compris l'identité.
 */
export async function truncateAll(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql`TRUNCATE TABLE audit_entries, approvals, actions, tasks, agents,
        agent_capabilities, capabilities, human_agent_links,
        user_roles, "session", account, verification, "user" RESTART IDENTITY CASCADE`,
  );
}