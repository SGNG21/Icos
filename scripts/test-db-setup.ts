/**
 * Crée (si absente) et migre la base de test dédiée (`icos_test` par défaut,
 * ou ICOS_TEST_DATABASE_URL). Refuse toute base non « test » (voir
 * src/server/database/test-database-guard.ts) : jamais la base live.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { TEST_DATABASE_URL, assertSafeTestDatabaseUrl } from "../src/server/database/test-database-guard";

/** `false` only when the server says the database does not exist (3D000). */
async function databaseExists(url: string): Promise<boolean> {
  const probe = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await probe`select 1`;
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "3D000") return false;
    throw error;
  } finally {
    await probe.end();
  }
}

async function main(): Promise<void> {
  assertSafeTestDatabaseUrl(TEST_DATABASE_URL);
  const target = new URL(TEST_DATABASE_URL);
  const name = decodeURIComponent(target.pathname.slice(1));

  /*
   * The database itself first: inside the integration gate's PostgreSQL step the role owns
   * exactly one disposable database and may open nothing else — not even `postgres` (H1,
   * ADR 0075). The maintenance database is only needed to CREATE a missing one.
   */
  if (!(await databaseExists(TEST_DATABASE_URL))) {
    const admin = postgres(new URL("/postgres", target).toString(), { max: 1, onnotice: () => {} });
    const exists = await admin`select 1 from pg_database where datname = ${name}`;
    if (exists.length === 0) await admin.unsafe(`create database "${name.replace(/"/g, "")}"`);
    await admin.end();
  }

  const sql = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
  await sql.end();
  console.log(`test database ready: ${name}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
