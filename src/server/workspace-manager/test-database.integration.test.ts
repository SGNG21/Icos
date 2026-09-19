import { randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";

import { createDatabase } from "@/server/database/client";
import { runMigrations } from "@/server/database/migrate";

import { PostgresTestDatabaseProvisioner, workerDatabaseUrl } from "./test-database";

const provisioner = new PostgresTestDatabaseProvisioner();
const name = `icos_test_wm_${randomBytes(4).toString("hex")}`;

async function databaseExists(db: string): Promise<boolean> {
  const admin = postgres(new URL("/postgres", workerDatabaseUrl(name)).toString(), {
    max: 1,
    onnotice: () => {},
  });
  try {
    return (await admin`select 1 from pg_database where datname = ${db}`).length > 0;
  } finally {
    await admin.end();
  }
}

afterAll(() => provisioner.drop(name));

describe("PostgresTestDatabaseProvisioner (PostgreSQL réel, base dédiée jetable)", () => {
  it("crée une base dédiée vierge, y applique toutes les migrations depuis zéro, puis la supprime", async () => {
    await provisioner.create(name);
    await provisioner.create(name); // idempotent
    expect(await databaseExists(name)).toBe(true);

    const handle = createDatabase(workerDatabaseUrl(name), { max: 1 });
    try {
      await runMigrations(handle.db);
      const rows = (await handle.db.execute(
        sql.raw("select to_regclass('public.scheduled_jobs') is not null as ok"),
      )) as unknown as { ok: boolean }[];
      expect(rows[0]!.ok).toBe(true);
    } finally {
      await handle.close();
    }

    await provisioner.reset(name); // base vierge à nouveau
    const fresh = createDatabase(workerDatabaseUrl(name), { max: 1 });
    try {
      const rows = (await fresh.db.execute(
        sql.raw("select to_regclass('public.scheduled_jobs') is null as blank"),
      )) as unknown as { blank: boolean }[];
      expect(rows[0]!.blank).toBe(true);
    } finally {
      await fresh.close();
    }

    await provisioner.drop(name);
    expect(await databaseExists(name)).toBe(false);
  });

  it("refuse de créer ou supprimer la base live ou une base non worker", async () => {
    for (const bad of [
      "icos_n23_probe",
      "postgres",
      "icos_test",
      "icos_test_live1",
      "icos_test_prod",
    ]) {
      await expect(provisioner.create(bad)).rejects.toThrow(/DATABASE_FORBIDDEN/);
      await expect(provisioner.drop(bad)).rejects.toThrow(/DATABASE_FORBIDDEN/);
    }
  });
});
