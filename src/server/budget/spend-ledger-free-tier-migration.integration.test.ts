import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TEST_DATABASE_URL,
  assertSafeTestDatabaseUrl,
} from "@/server/database/test-database-guard";

/**
 * Migration 0066 (decision 0078) proven on its OWN throwaway database, created and dropped here:
 *   1. first install on a database migrated through 0065 that already HOLDS 0055/0065-shaped rows
 *      (COST, UNPRICED, UNMETERED, cache counters) — every row survives and validates;
 *   2. idempotent replay of the file (constraint oids unchanged) and through drizzle `migrate`;
 *   3. the ROLLBACK block of the file's own header, executed verbatim, then a reapply.
 * The CHECKs themselves (a FREE_TIER row of non-zero amount is unrepresentable) are asserted at
 * each stage. Never touches any database but the one it creates.
 */

const DB = "icos_free_tier_migration_test";
const DIR = join(process.cwd(), "drizzle");
const FILE = "0066_spend_ledger_free_tier";
const migrationSql = readFileSync(join(DIR, `${FILE}.sql`), "utf8");

/** The ROLLBACK statements, read from the migration header itself (not a copy). */
function rollbackFromHeader(): string {
  const lines = migrationSql.split("\n");
  const start = lines.findIndex((l) => l.trim() === "-- ROLLBACK");
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("--")) break;
    if (line.startsWith("--   ")) body.push(line.slice(5));
    else if (body.length > 0) break;
  }
  return body.join("\n");
}

let sql: postgres.Sql;
let admin: postgres.Sql;
let pre0066: string;

const url = new URL(`/${DB}`, TEST_DATABASE_URL).toString();

const constraints = async () =>
  sql<{ conname: string; oid: number; def: string; validated: boolean }[]>`
    select conname, oid::int as oid, pg_get_constraintdef(oid) as def, convalidated as validated
      from pg_constraint
     where conrelid = 'spend_ledger'::regclass
       and conname in ('spend_ledger_cost_kind_check', 'spend_ledger_cost_shape')
     order by conname`;

const pgCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "NO_ERROR";
  } catch (error) {
    return (error as { code?: string }).code ?? "UNKNOWN";
  }
};

let n = 0;
const insert = (cols: Record<string, unknown>) => {
  const row = {
    id: `row-${++n}`,
    tenant_id: "default",
    attribution_key: "goal=g1",
    model_id: "test/model",
    usage_kind: "METERED",
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    observed_at: "2026-10-14T00:00:00.000Z",
    ...cols,
  };
  return sql`insert into spend_ledger ${sql(row as Record<string, postgres.ParameterOrJSON<never>>)}`;
};
const FREE_ROW = {
  cost_kind: "FREE_TIER",
  currency: "EUR",
  amount: 0,
  free_tier_provenance: "https://example.invalid/terms",
  free_tier_verified_on: "2026-10-14",
};

beforeAll(async () => {
  assertSafeTestDatabaseUrl(url);
  admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${DB}`);
  await admin.unsafe(`create database ${DB}`);
  sql = postgres(url, { max: 1, onnotice: () => {} });

  /* A migrations folder that STOPS at 0065: the state of every database before this change. */
  pre0066 = mkdtempSync(join(tmpdir(), "icos-pre0066-"));
  cpSync(DIR, pre0066, { recursive: true });
  rmSync(join(pre0066, `${FILE}.sql`));
  const journalPath = join(pre0066, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => e.tag !== FILE);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  await migrate(drizzle(sql), { migrationsFolder: pre0066 });
});

afterAll(async () => {
  await sql?.end();
  await admin?.unsafe(`drop database if exists ${DB}`);
  await admin?.end();
  if (pre0066) rmSync(pre0066, { recursive: true, force: true });
});

describe("migration 0066 — spend_ledger FREE_TIER (throwaway database)", () => {
  it("before 0066: FREE_TIER is refused and the columns do not exist", async () => {
    const cols = await sql`select column_name from information_schema.columns
      where table_name = 'spend_ledger' and column_name like 'free_tier%'`;
    expect(cols).toHaveLength(0);
    expect(await pgCode(insert({ cost_kind: "FREE_TIER", currency: "EUR", amount: 0 }))).toBe(
      "23514",
    );
  });

  it("first install on a database holding 0055/0065 rows keeps and validates every row", async () => {
    await insert({ cost_kind: "COST", currency: "EUR", amount: 0.000165 });
    await insert({ cost_kind: "UNPRICED", unpriced_reason: "ABSENT", cache_read: 0 });
    await insert({
      usage_kind: "UNMETERED",
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      unmetered_reason: "USAGE_ABSENT",
    });
    await insert({ cost_kind: "COST", currency: "EUR", amount: 0, cache_creation: 3 });
    const before = await sql`select * from spend_ledger order by id`;

    await sql.unsafe(migrationSql);

    const after = await sql`select * from spend_ledger order by id`;
    expect(after).toHaveLength(before.length);
    after.forEach((row, i) => {
      expect(row).toMatchObject(before[i]!);
      expect(row.free_tier_provenance).toBeNull();
      expect(row.free_tier_verified_on).toBeNull();
    });
    for (const c of await constraints()) {
      expect(c.def).toContain("FREE_TIER");
      expect(c.validated).toBe(true);
    }
  });

  it("is idempotent: replaying the file changes no constraint (same oids)", async () => {
    const first = await constraints();
    await sql.unsafe(migrationSql);
    await sql.unsafe(migrationSql);
    expect(await constraints()).toEqual(first);
  });

  it("drizzle migrate then records 0066 exactly once and replays nothing else", async () => {
    await migrate(drizzle(sql), { migrationsFolder: DIR });
    const journal = JSON.parse(readFileSync(join(DIR, "meta", "_journal.json"), "utf8")) as {
      entries: unknown[];
    };
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations`;
    expect(count).toBe(journal.entries.length);
    await migrate(drizzle(sql), { migrationsFolder: DIR });
    const [{ count: again }] = await sql<{ count: number }[]>`
      select count(*)::int as count from drizzle.__drizzle_migrations`;
    expect(again).toBe(count);
  });

  describe("the row shape after 0066", () => {
    it("accepts a FREE_TIER row of amount 0 with its dated proof", async () => {
      expect(await pgCode(insert(FREE_ROW))).toBe("NO_ERROR");
    });

    it.each([
      ["a non-zero amount", { amount: 1 }],
      ["a NULL amount", { amount: null }],
      ["no currency", { currency: null }],
      ["no provenance", { free_tier_provenance: null }],
      ["a blank provenance", { free_tier_provenance: "   " }],
      ["no verification date", { free_tier_verified_on: null }],
      ["an unpriced reason", { unpriced_reason: "ABSENT" }],
    ])("refuses FREE_TIER with %s", async (_label, override) => {
      expect(await pgCode(insert({ ...FREE_ROW, ...override }))).toBe("23514");
    });

    it("refuses free-tier proof on a COST or an UNPRICED row", async () => {
      const proof = {
        free_tier_provenance: "https://x.invalid",
        free_tier_verified_on: "2026-10-14",
      };
      expect(
        await pgCode(insert({ cost_kind: "COST", currency: "EUR", amount: 1, ...proof })),
      ).toBe("23514");
      expect(
        await pgCode(insert({ cost_kind: "UNPRICED", unpriced_reason: "ABSENT", ...proof })),
      ).toBe("23514");
    });

    it("refuses an unknown cost word", async () => {
      expect(await pgCode(insert({ cost_kind: "FREE", currency: "EUR", amount: 0 }))).toBe("23514");
    });

    it("still accepts COST of amount 0 (a zero-token call), which is NOT a free tier", async () => {
      expect(await pgCode(insert({ cost_kind: "COST", currency: "EUR", amount: 0 }))).toBe(
        "NO_ERROR",
      );
    });
  });

  it("header ROLLBACK runs verbatim, keeps FREE_TIER evidence, narrows new writes; reapply restores", async () => {
    const rollback = rollbackFromHeader();
    expect(rollback).toContain("NOT VALID");
    const freeRows = async () =>
      (await sql`select count(*)::int as c from spend_ledger where cost_kind = 'FREE_TIER'`)[0]!.c;
    const kept = await freeRows();
    expect(kept).toBeGreaterThan(0);

    await sql.unsafe(rollback);
    expect(await freeRows()).toBe(kept);
    for (const c of await constraints()) {
      expect(c.def).not.toContain("FREE_TIER");
      expect(c.validated).toBe(false);
    }
    expect(await pgCode(insert(FREE_ROW))).toBe("23514");
    expect(await pgCode(insert({ cost_kind: "COST", currency: "EUR", amount: 1 }))).toBe(
      "NO_ERROR",
    );

    await sql.unsafe(migrationSql);
    for (const c of await constraints()) {
      expect(c.def).toContain("FREE_TIER");
      expect(c.validated).toBe(true);
    }
    expect(await pgCode(insert(FREE_ROW))).toBe("NO_ERROR");
    expect(await pgCode(insert({ ...FREE_ROW, amount: 1 }))).toBe("23514");
  });
});
