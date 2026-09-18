import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { runMigrations } from "@/server/database/migrate";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

const FRESH = "icos_migcheck_test";
const journalCount: number = JSON.parse(
  readFileSync(join(process.cwd(), "drizzle", "meta", "_journal.json"), "utf8"),
).entries.length;

let admin: DatabaseHandle;
let fresh: DatabaseHandle;

beforeAll(async () => {
  admin = createDatabase(TEST_DATABASE_URL, { max: 1 });
  await admin.db.execute(sql.raw(`drop database if exists ${FRESH}`));
  await admin.db.execute(sql.raw(`create database ${FRESH}`));
  fresh = createDatabase(new URL(`/${FRESH}`, TEST_DATABASE_URL).toString(), { max: 2 });
  await runMigrations(fresh.db);
});

afterAll(async () => {
  await fresh?.close();
  await admin?.db.execute(sql.raw(`drop database if exists ${FRESH}`));
  await admin?.close();
});

const rows = async (query: string) =>
  (await fresh.db.execute(sql.raw(query))) as unknown as Record<string, string>[];

describe("fresh PostgreSQL database reproduces the schema from the journal", () => {
  it("applies every journaled migration", async () => {
    const [{ n }] = await rows("select count(*)::int as n from drizzle.__drizzle_migrations");
    expect(Number(n)).toBe(journalCount);
  });

  it("allows the superseded status on tasks and mission_tasks", async () => {
    const defs = await rows(
      "select pg_get_constraintdef(oid) as d from pg_constraint where conname in ('tasks_status_check','mission_tasks_status_check')",
    );
    expect(defs).toHaveLength(2);
    for (const { d } of defs) expect(d).toContain("superseded");
  });

  it("matches schema.ts for approvals (decided_by_label, created_at)", async () => {
    const cols = (
      await rows("select column_name from information_schema.columns where table_name = 'approvals'")
    ).map((r) => r.column_name);
    expect(cols).toEqual(expect.arrayContaining(["decided_by_label", "created_at"]));
    expect(cols).not.toContain("decided_by");
  });

  it("creates the Phase 6 tables", async () => {
    const names = (
      await rows("select table_name from information_schema.tables where table_schema = 'public'")
    ).map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "missions",
        "mission_tasks",
        "dispatch_attempts",
        "autonomous_mission_runtime",
        "quality_control_jobs",
        "task_execution_results",
        "decisions",
      ]),
    );
  });
});
