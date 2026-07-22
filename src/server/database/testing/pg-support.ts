import { execSync } from "node:child_process";

import { sql } from "drizzle-orm";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { runMigrations } from "@/server/database/migrate";

/**
 * Support des tests d'intégration PostgreSQL (Testcontainers). Ce module n'est
 * pas un fichier de test ; il est importé par les suites `*.integration.test.ts`.
 */

/** Détection synchrone de Docker (évaluée à la collecte, pour `describe.skipIf`). */
export function detectDocker(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

export const dockerAvailable = detectDocker();

export interface PgContext {
  container: StartedPostgreSqlContainer;
  handle: DatabaseHandle;
}

/** Démarre un conteneur PostgreSQL, applique les migrations depuis une base vide. */
export async function startPostgres(): Promise<PgContext> {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const handle = createDatabase(container.getConnectionUri(), { max: 5 });
  await runMigrations(handle.db);
  return { container, handle };
}

/** Ferme le client puis arrête le conteneur. */
export async function stopPostgres(ctx: PgContext | undefined): Promise<void> {
  if (!ctx) {
    return;
  }
  await ctx.handle.close();
  await ctx.container.stop();
}

/** Vide toutes les tables entre les tests (isolation), y compris l'identité. */
export async function truncateAll(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql`TRUNCATE TABLE audit_entries, approvals, actions, tasks, agents,
        user_roles, "session", account, verification, "user" RESTART IDENTITY CASCADE`,
  );
}
