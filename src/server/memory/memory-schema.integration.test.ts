import { getTableColumns, getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DatabaseHandle } from "@/server/database/client";
import {
  businessMemoryEntries,
  memoryRetrievalLog,
  missionMemoryEntries,
  proceduralMemoryEntries,
  proceduralMemoryEvidence,
} from "@/server/database/memory-schema";
import { insertMission, openTestDb, resetMemory } from "./testing/support";

const T0 = "2026-09-19T10:00:00Z";

/** Erreur SQL brute → SQLSTATE (postgres.js: `code`, drizzle peut envelopper dans `cause`). */
async function sqlState(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
}

describe("operational memory schema (PostgreSQL)", () => {
  let h: DatabaseHandle;
  beforeAll(() => {
    h = openTestDb();
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(async () => {
    await resetMemory(h);
    await insertMission(h, "m1");
  });

  const missionRow = (id: string) =>
    sql.raw(`INSERT INTO mission_memory_entries
      (id, tenant_id, mission_id, scope, kind, title, summary, payload, source_type, source_id,
       recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
      VALUES ('${id}','default','m1','mission','result','t','s','{}','execution_result','src-${id}',
       'system','sys','${T0}','${T0}','${T0}',1,'observed','tenant')`);

  it("schema parity: every Drizzle column exists in PostgreSQL with matching nullability", async () => {
    const tables: PgTable[] = [
      missionMemoryEntries,
      proceduralMemoryEntries,
      proceduralMemoryEvidence,
      businessMemoryEntries,
      memoryRetrievalLog,
    ];
    for (const table of tables) {
      const rows = await h.sql`select column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = ${getTableName(table)}`;
      const db = new Map(rows.map((r) => [r.column_name as string, r.is_nullable === "YES"]));
      const cols = Object.values(getTableColumns(table));
      expect(db.size, getTableName(table)).toBe(cols.length);
      for (const c of cols) {
        expect(db.get(c.name), `${getTableName(table)}.${c.name}`).toBe(!c.notNull);
      }
    }
  });

  it("mission memory: UPDATE and DELETE are rejected by trigger (IC002)", async () => {
    await h.db.execute(missionRow("e1"));
    expect(
      await sqlState(
        h.db.execute(sql`UPDATE mission_memory_entries SET title = 'x' WHERE id = 'e1'`),
      ),
    ).toBe("IC002");
    expect(
      await sqlState(h.db.execute(sql`DELETE FROM mission_memory_entries WHERE id = 'e1'`)),
    ).toBe("IC002");
  });

  it("mission memory: unknown mission is rejected by FK, kind by CHECK", async () => {
    expect(
      await sqlState(
        h.sql`insert into mission_memory_entries (id, tenant_id, mission_id, scope, kind, title, summary, payload, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
          values ('e3','default','ghost','mission','result','t','s','{}','system','s','system','sys',${T0},${T0},${T0},1,'observed','tenant')`,
      ),
    ).toBe("23503");
    expect(
      await sqlState(
        h.sql`insert into mission_memory_entries (id, tenant_id, mission_id, scope, kind, title, summary, payload, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
          values ('e4','default','m1','mission','gossip','t','s','{}','system','s','system','sys',${T0},${T0},${T0},1,'observed','tenant')`,
      ),
    ).toBe("23514");
  });

  it("mission memory: a second non-superseding terminal_state per mission is rejected", async () => {
    const ins = (id: string) =>
      h.sql`insert into mission_memory_entries (id, tenant_id, mission_id, scope, kind, title, summary, payload, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
        values (${id},'default','m1','mission','terminal_state','t','s','{}','mission',${"src-" + id},'system','sys',${T0},${T0},${T0},1,'observed','tenant')`;
    expect(await sqlState(ins("t1"))).toBeUndefined();
    expect(await sqlState(ins("t2"))).toBe("23505");
  });

  it("mission memory: replaying the same source+kind is rejected (idempotence key)", async () => {
    await h.db.execute(missionRow("e5"));
    expect(
      await sqlState(
        h.sql`insert into mission_memory_entries (id, tenant_id, mission_id, scope, kind, title, summary, payload, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
          values ('e6','default','m1','mission','result','t','s','{}','execution_result','src-e5','system','sys',${T0},${T0},${T0},1,'observed','tenant')`,
      ),
    ).toBe("23505");
  });

  it("visibility CHECKs: private needs owner, restricted needs permission", async () => {
    const ins = (vis: string) =>
      h.sql`insert into mission_memory_entries (id, tenant_id, mission_id, scope, kind, title, summary, payload, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
        values (${"v-" + vis},'default','m1','mission','result','t','s','{}','system',${"s-" + vis},'system','sys',${T0},${T0},${T0},1,'observed',${vis})`;
    expect(await sqlState(ins("private"))).toBe("23514");
    expect(await sqlState(ins("restricted"))).toBe("23514");
    expect(await sqlState(ins("tenant"))).toBeUndefined();
  });

  const proc = (over: Record<string, string | number> = {}) => {
    const v = {
      id: "p1",
      kind: "strategy",
      status: "candidate",
      occ: 1,
      ok: 1,
      ko: 0,
      ...over,
    };
    return h.sql`insert into procedural_memory_entries
      (id, tenant_id, kind, scope, scope_key, signature, title, summary, payload, status, occurrence_count, success_count, failure_count,
       first_observed_at, last_observed_at, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at,
       confidence, confidence_basis, visibility)
      values (${v.id},'default',${v.kind as string},'tenant','*',${"sig-" + v.id},'t','s','{}',${v.status as string},${v.occ as number},${v.ok as number},${v.ko as number},
       ${T0},${T0},'execution_result','r1','system','sys',${T0},${T0},${T0},0.6,'derived','tenant')`;
  };

  it("procedural: counters must sum to occurrences", async () => {
    expect(await sqlState(proc())).toBeUndefined();
    expect(await sqlState(proc({ id: "p2", occ: 3, ok: 1, ko: 1 }))).toBe("23514");
  });

  it("procedural: validated status requires validated_by; validated_remediation cannot be a candidate", async () => {
    expect(await sqlState(proc({ id: "p3", status: "validated" }))).toBe("23514");
    expect(
      await sqlState(proc({ id: "p4", kind: "validated_remediation", status: "candidate" })),
    ).toBe("23514");
  });

  it("procedural: DELETE is rejected (IC002); evidence is append-only", async () => {
    await proc();
    expect(
      await sqlState(h.db.execute(sql`DELETE FROM procedural_memory_entries WHERE id = 'p1'`)),
    ).toBe("IC002");
    await h.sql`insert into procedural_memory_evidence (id, entry_id, tenant_id, source_type, source_id, outcome, observed_at, recorded_at)
      values ('ev1','p1','default','execution_result','r1','success',${T0},${T0})`;
    expect(
      await sqlState(
        h.db.execute(sql`UPDATE procedural_memory_evidence SET outcome='failure' WHERE id='ev1'`),
      ),
    ).toBe("IC002");
    expect(
      await sqlState(
        h.sql`insert into procedural_memory_evidence (id, entry_id, tenant_id, source_type, source_id, outcome, observed_at, recorded_at)
          values ('ev2','p1','default','execution_result','r1','success',${T0},${T0})`,
      ),
    ).toBe("23505");
  });

  const biz = (over: Record<string, string | null> = {}) => {
    const v = { id: "b1", status: "active", decided_by: "user-1", subject: "brand.tone", ...over };
    return h.sql`insert into business_memory_entries
      (id, tenant_id, kind, scope, scope_key, subject_key, summary, value, version, status, decided_by, decided_at,
       source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at, last_verified_at, confidence, confidence_basis, visibility)
      values (${v.id!},'default','preference','tenant','*',${v.subject!},'s','{"tone":"warm"}',${v.status === "active" ? 1 : null},${v.status!},${v.decided_by},${v.decided_by ? T0 : null},
       'human_input','u1','human','user-1',${T0},${T0},${T0},1,'declared','tenant')`;
  };

  it("business: an active entry without decided_by is impossible (workers cannot activate)", async () => {
    expect(await sqlState(biz({ id: "b2", decided_by: null }))).toBe("23514");
    expect(await sqlState(biz({ id: "b3", status: "proposed", decided_by: null }))).toBeUndefined();
  });

  it("business: only one active version per subject", async () => {
    expect(await sqlState(biz())).toBeUndefined();
    expect(await sqlState(biz({ id: "b4" }))).toBe("23505");
  });

  it("business: value is immutable (IC003) but status may change; DELETE rejected", async () => {
    await biz();
    expect(
      await sqlState(
        h.db.execute(
          sql`UPDATE business_memory_entries SET value = '{"tone":"cold"}' WHERE id = 'b1'`,
        ),
      ),
    ).toBe("IC003");
    expect(
      await sqlState(
        h.db.execute(sql`UPDATE business_memory_entries SET status = 'superseded' WHERE id = 'b1'`),
      ),
    ).toBeUndefined();
    expect(
      await sqlState(h.db.execute(sql`DELETE FROM business_memory_entries WHERE id = 'b1'`)),
    ).toBe("IC002");
  });

  it("retrieval log is append-only", async () => {
    await h.sql`insert into memory_retrieval_log (id, tenant_id, memory_type, requester_type, requester_id, query, result, returned_count, stats, retrieved_at)
      values ('r1','default','mission','agent','a1','{}','[]',0,'{}',${T0})`;
    expect(
      await sqlState(
        h.db.execute(sql`UPDATE memory_retrieval_log SET returned_count = 1 WHERE id = 'r1'`),
      ),
    ).toBe("IC002");
    expect(
      await sqlState(h.db.execute(sql`DELETE FROM memory_retrieval_log WHERE id = 'r1'`)),
    ).toBe("IC002");
  });
});
