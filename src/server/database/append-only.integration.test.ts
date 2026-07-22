import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AUDIT_APPEND_ONLY_SQLSTATE, sqlStateOf } from "@/server/database/errors";
import { auditEntries } from "@/server/database/schema";
import {
  dockerAvailable,
  startPostgres,
  stopPostgres,
  truncateAll,
  type PgContext,
} from "@/server/database/testing/pg-support";

async function seedOneAudit(ctx: PgContext): Promise<void> {
  await ctx.handle.db.insert(auditEntries).values({
    id: "audit-1",
    eventType: "task.created",
    actorType: "system",
    actorLabel: "icos",
    details: { note: "x" },
    occurredAt: new Date("2026-07-22T10:00:00.000Z"),
  });
}

describe.skipIf(!dockerAvailable)("audit_entries append-only (trigger SQL)", () => {
  let ctx: PgContext;

  beforeAll(async () => {
    ctx = await startPostgres();
  }, 120_000);

  afterAll(async () => {
    await stopPostgres(ctx);
  });

  beforeEach(async () => {
    await truncateAll(ctx.handle);
    await seedOneAudit(ctx);
  });

  it("bloque UPDATE avec le SQLSTATE dédié", async () => {
    let sqlstate: string | undefined;
    try {
      await ctx.handle.db.execute(sql`UPDATE audit_entries SET actor_label = 'hack'`);
      throw new Error("UPDATE aurait dû être bloqué");
    } catch (error) {
      sqlstate = sqlStateOf(error);
    }
    expect(sqlstate).toBe(AUDIT_APPEND_ONLY_SQLSTATE);
    // L'entrée n'a pas été modifiée.
    const rows = await ctx.handle.db.select().from(auditEntries);
    expect(rows[0].actorLabel).toBe("icos");
  });

  it("bloque DELETE avec le SQLSTATE dédié", async () => {
    let sqlstate: string | undefined;
    try {
      await ctx.handle.db.execute(sql`DELETE FROM audit_entries`);
      throw new Error("DELETE aurait dû être bloqué");
    } catch (error) {
      sqlstate = sqlStateOf(error);
    }
    expect(sqlstate).toBe(AUDIT_APPEND_ONLY_SQLSTATE);
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(1);
  });

  it("TRUNCATE ... CASCADE reste utilisable malgré le trigger", async () => {
    await expect(truncateAll(ctx.handle)).resolves.toBeUndefined();
    expect(await ctx.handle.db.select().from(auditEntries)).toHaveLength(0);
  });
});
