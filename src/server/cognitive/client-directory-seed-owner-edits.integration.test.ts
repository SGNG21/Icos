import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";

import { seedClientDirectory } from "./client-directory-seed";
import { systemClock } from "./conversation-store";
import { PostgresCognitiveMemoryStore } from "./memory-store";

/*
 * REVIEW L3: the boot seed runs on EVERY production boot. It must deliver its aliases once
 * per alias set, and never re-add an alias the owner removed afterwards. Test database only.
 */
const handles: DatabaseHandle[] = [];

async function store() {
  const handle = await createDatabase(TEST_DATABASE_URL);
  handles.push(handle);
  return { db: handle.db, memory: new PostgresCognitiveMemoryStore(handle.db, systemClock) };
}

async function ldsAliases(db: Awaited<ReturnType<typeof store>>["db"]): Promise<string[]> {
  const rows = (await db.execute(
    sql.raw(`select aliases from memory_entities where kind = 'client' and key = 'lds-renov'`),
  )) as unknown as Array<{ aliases: string[] }>;
  return rows[0]?.aliases ?? [];
}

beforeEach(async () => {
  const { db } = await store();
  await db.execute(
    sql.raw("TRUNCATE TABLE memory_entities, memory_records RESTART IDENTITY CASCADE"),
  );
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("boot seed respects owner alias edits (PostgreSQL)", () => {
  it("first boot delivers the aliases; an owner removal survives every later boot", async () => {
    const { db, memory } = await store();
    await seedClientDirectory(memory, CURRENT_SINGLE_TENANT_ID, "system:boot-seed");
    expect(await ldsAliases(db)).toEqual(expect.arrayContaining(["lds-renov.fr", "desc:cannes"]));

    /* The OWNER removes a descriptor (an owner edit, as the directory's API would apply it). */
    await db.execute(
      sql.raw(
        `update memory_entities set aliases = array_remove(aliases, 'desc:cannes') where kind = 'client' and key = 'lds-renov'`,
      ),
    );

    /* Two more boots, on fresh handles: the removal holds. */
    for (let boot = 0; boot < 2; boot++) {
      const next = await store();
      await seedClientDirectory(next.memory, CURRENT_SINGLE_TENANT_ID, "system:boot-seed");
    }
    const aliases = await ldsAliases(db);
    expect(aliases).not.toContain("desc:cannes");
    expect(aliases).toContain("lds-renov.fr");
  });
});
