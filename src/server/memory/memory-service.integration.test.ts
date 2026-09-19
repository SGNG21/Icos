import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  MemorySecretRejectedError,
  MemoryTenantRequiredError,
  type HumanActor,
  type MemoryActor,
} from "@/core/memory";
import type { DatabaseHandle } from "@/server/database/client";
import { MemoryService } from "./memory-service";
import { PostgresBusinessMemoryStore } from "./postgres-business-memory-store";
import { PostgresMissionMemoryStore } from "./postgres-mission-memory-store";
import { PostgresProceduralMemoryStore } from "./postgres-procedural-memory-store";
import { PostgresRetrievalLogStore } from "./postgres-retrieval-log-store";
import type { RetrievalLogStore } from "./ports";
import { insertMission, openTestDb, OTHER_TENANT, resetMemory, TENANT } from "./testing/support";

const T0 = new Date("2026-09-19T12:00:00.000Z");
const deps = { now: () => T0 };
const sys: MemoryActor = { tenantId: TENANT, kind: "system", id: "icos-runtime", permissions: [] };
const agent: MemoryActor = { tenantId: TENANT, kind: "agent", id: "agent-cto", permissions: [] };
const human: HumanActor = { tenantId: TENANT, kind: "human", id: "user-1", permissions: [] };

let h: DatabaseHandle;
let mission: PostgresMissionMemoryStore;
let proc: PostgresProceduralMemoryStore;
let biz: PostgresBusinessMemoryStore;
let log: PostgresRetrievalLogStore;
let service: MemoryService;

beforeAll(() => {
  h = openTestDb();
  mission = new PostgresMissionMemoryStore(h.db, deps);
  proc = new PostgresProceduralMemoryStore(h.db, deps);
  biz = new PostgresBusinessMemoryStore(h.db, deps);
  log = new PostgresRetrievalLogStore(h.db);
  service = new MemoryService({ mission, procedural: proc, business: biz, log }, deps);
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetMemory(h);
  await insertMission(h, "m1");
  await mission.append(sys, {
    missionId: "m1",
    kind: "result",
    title: "ok",
    summary: "ok",
    payload: {},
    provenance: { sourceType: "execution_result", sourceId: "res-1" },
    occurredAt: "2026-09-19T11:00:00.000Z",
    confidence: { value: 1, basis: "observed" },
  });
  await mission.append(sys, {
    missionId: "m1",
    kind: "review",
    title: "audit only",
    summary: "restricted",
    payload: {},
    provenance: { sourceType: "audit_entry", sourceId: "aud-1" },
    occurredAt: "2026-09-19T11:05:00.000Z",
    confidence: { value: 1, basis: "observed" },
    visibility: {
      visibility: "restricted",
      requiredPermission: "audit.read.full",
      ownerSubject: null,
    },
  });
});

describe("MemoryService retrieval traceability", () => {
  it("logs every retrieval: requester, query, returned entries with provenance, exclusion stats", async () => {
    const res = await service.retrieveMission(agent, { missionId: "m1" });
    expect(res.memoryType).toBe("mission");
    expect(res.entries).toHaveLength(1);
    expect(res.stats).toMatchObject({ matched: 2, returned: 1, denied: 1 });

    const [row] = await log.listByRequester(TENANT, "agent-cto");
    expect(row).toMatchObject({
      id: res.retrievalId,
      tenantId: TENANT,
      memoryType: "mission",
      requesterType: "agent",
      requesterId: "agent-cto",
      missionId: "m1",
      retrievedAt: T0.toISOString(),
      stats: { matched: 2, returned: 1, denied: 1 },
    });
    expect(row.query).toMatchObject({ missionId: "m1", limit: 10 });
    expect(row.result).toEqual([
      {
        entryId: res.entries[0].entry.id,
        rank: 1,
        freshness: "fresh",
        confidence: 1,
        sourceType: "execution_result",
        sourceId: "res-1",
      },
    ]);
  });

  it("never logs the content of denied entries", async () => {
    await service.retrieveMission(agent, { missionId: "m1" } as never);
    const rows =
      await h.sql`select result::text as r, query::text as q, stats::text as s from memory_retrieval_log`;
    expect(JSON.stringify(rows)).not.toContain("audit only");
    expect(JSON.stringify(rows)).not.toContain("aud-1");
  });

  it("fails closed when the trace cannot be written: no untraced memory is returned", async () => {
    const broken: RetrievalLogStore = {
      append: () => Promise.reject(new Error("log down")),
      listByRequester: () => Promise.resolve([]),
    };
    const s = new MemoryService({ mission, procedural: proc, business: biz, log: broken }, deps);
    await expect(s.retrieveMission(agent, { missionId: "m1" } as never)).rejects.toThrow(
      "log down",
    );
  });

  it("requires tenant context and rejects secrets in the purpose", async () => {
    await expect(
      service.retrieveMission({ ...agent, tenantId: "" }, { missionId: "m1" } as never),
    ).rejects.toBeInstanceOf(MemoryTenantRequiredError);
    await expect(
      service.retrieveProcedural(agent, {
        purpose: "use Bearer abcdefghijklmnopqrstuvwxyz",
      } as never),
    ).rejects.toBeInstanceOf(MemorySecretRejectedError);
    expect((await h.sql`select count(*)::int as n from memory_retrieval_log`)[0].n).toBe(0);
  });

  it("caps the limit at 50 and validates the query", async () => {
    await expect(
      service.retrieveMission(agent, { missionId: "m1", limit: 51 } as never),
    ).rejects.toThrow();
    await expect(service.retrieveMission(agent, {} as never)).rejects.toThrow();
  });

  it("logs procedural and business retrievals under their own memory type, scoped per tenant", async () => {
    await proc.observe(sys, {
      kind: "strategy",
      scope: "capability",
      scopeKey: "website.build",
      signature: "sig",
      title: "t",
      summary: "s",
      outcome: "success",
      provenance: { sourceType: "execution_result", sourceId: "res-1" },
      occurredAt: "2026-09-19T11:00:00.000Z",
    });
    await biz.record(human, {
      kind: "preference",
      scope: "tenant",
      subjectKey: "brand.tone",
      summary: "warm",
      value: { tone: "warm" },
      provenance: { sourceType: "human_input", sourceId: "f1" },
      occurredAt: "2026-09-19T11:00:00.000Z",
      confidence: { value: 1, basis: "declared" },
    });
    const p = await service.retrieveProcedural(sys, {
      capability: "website.build",
      purpose: "plan build",
    } as never);
    const b = await service.retrieveBusiness(human, { subjectKeyPrefix: "brand." } as never);
    expect(p.entries).toHaveLength(1);
    expect(b.entries).toHaveLength(1);
    expect(p.entries[0].entry.sourceId).toBe("res-1");

    const sysRows = await log.listByRequester(TENANT, "icos-runtime");
    expect(sysRows.map((r) => [r.memoryType, r.purpose])).toEqual([["procedural", "plan build"]]);
    const humanRows = await log.listByRequester(TENANT, "user-1");
    expect(humanRows.map((r) => r.memoryType)).toEqual(["business"]);
    expect(await log.listByRequester(OTHER_TENANT, "icos-runtime")).toEqual([]);
  });
});
