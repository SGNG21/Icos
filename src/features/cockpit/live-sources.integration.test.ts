import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { AuthenticatedSession } from "@/core/identity";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import { memoryRecords } from "@/server/cognitive/schema";
import type { Container } from "@/server/container";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { createDatabaseHealth } from "@/server/database/health";
import { spendLedger } from "@/server/database/schema";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { hermesWorker } from "@/server/services/worker-registry/fixtures";

import { readLiveOverview } from "./live-sources";
import type { VpsFacts } from "./live-overview";

/**
 * Agrégats RÉELS de `readLiveOverview` sur une base PostgreSQL de test jetable
 * (`pnpm test:integration`, `ICOS_TEST_DATABASE_URL`). Mêmes repositories que le
 * container de production, aucun scheduler ni sweeper démarré.
 */

const session = (role: "owner" | "viewer"): AuthenticatedSession => ({
  user: { id: `human-${role}`, email: `${role}@icos.test`, status: "active" },
  roles: [role],
});

const vps = async (): Promise<VpsFacts> => ({
  hostname: "test",
  sampledAt: new Date().toISOString(),
  overall: "ok",
  cores: 2,
  cpuUsage: 0.1,
  load1: 0.2,
  memoryRatio: 0.3,
  diskRatio: 0.4,
  vram: "NO_TELEMETRY",
});

describe("readLiveOverview (PostgreSQL)", () => {
  let handle: DatabaseHandle;
  let container: Container;

  beforeAll(() => {
    handle = createDatabase(TEST_DATABASE_URL);
    const tasks = new PostgresTaskRepository(handle.db);
    container = {
      db: handle.db,
      databaseHealth: createDatabaseHealth(handle.sql),
      tasks,
      mission: new PostgresMissionRepository(handle.db, tasks),
      dispatchAttempts: new PostgresDispatchAttemptRepository(handle.db),
      workerRegistryStore: new PostgresWorkerRegistryStore(handle.db),
      operationalAccess: new OperationalAccessService({
        listAgentIdsForHuman: async () => new Set<string>(),
      } as never),
    } as unknown as Container;
  });

  beforeEach(async () => {
    await handle.sql`truncate table workers, scheduled_jobs, spend_ledger, memory_records, memory_entities, memory_relations, memory_retrieval_log, missions, mission_tasks, dispatch_attempts cascade`;
  });

  afterAll(async () => {
    await handle.close();
  });

  const now = () => new Date();
  const ago = (ms: number) => new Date(Date.now() - ms);

  async function seedFresh(probeAt: Date) {
    await container.workerRegistryStore.upsert({
      ...hermesWorker,
      id: randomUUID(),
      status: "active",
      health: "healthy",
      availability: "available",
      lastProbeOutcome: "ok",
      lastProbeAt: probeAt.toISOString(),
    });
    await new PostgresScheduledJobRepository(handle.db).enqueue({
      kind: "probe_workers",
      payload: {},
      payloadHash: "h",
      idempotencyKey: `probe-${Date.now()}`,
    });
    await handle.db.insert(spendLedger).values({
      id: `spend-${Date.now()}`,
      tenantId: "default",
      attributionKey: "goal:test",
      modelId: "test/model",
      usageKind: "METERED",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      costKind: "UNPRICED",
      amount: null,
      currency: null,
      unpricedReason: "NO_PRICE",
      observedAt: now(),
    });
    await handle.db.insert(memoryRecords).values({
      id: `mem-${Date.now()}`,
      tenantId: "default",
      type: "semantic",
      subjectKey: "subject",
      content: "a durable fact",
      epistemic: "SYSTEM_OBSERVED",
      statementKind: "fact",
      status: "active",
      confidence: 0.9,
      originTrust: "trusted",
      provenance: {},
      sensitivity: "normal",
      retention: "standard",
      validFrom: now(),
      recordedBy: "test",
      createdAt: now(),
      updatedAt: now(),
    });
  }

  it("fresh rows: every source ok, UNPRICED spend never priced, counts from real rows", async () => {
    await seedFresh(now());
    const o = await readLiveOverview(container, session("owner"), {
      vps,
      services: async () => [],
    });
    expect(o.scope).toBe("global");
    expect(o.sources.core3).toMatchObject({
      state: "ok",
      data: { scheduler: { activeByKind: { probe_workers: 1 }, dead: 0 } },
    });
    expect(o.sources.workers).toMatchObject({
      state: "ok",
      data: { registered: 1, routable: 1, byProbeOutcome: { ok: 1 } },
    });
    expect(o.sources.omniroute.data?.spend).toMatchObject({
      calls24h: 1,
      tokens24h: 15,
      unpriced24h: 1,
      amount24h: null,
      priceStatus: "UNPRICED",
    });
    expect(o.sources.memory).toMatchObject({
      state: "ok",
      data: { records: 1, active: 1, entities: 0, relations: 0 },
    });
    expect(o.sources.vps.state).toBe("ok");
    expect(o.sources.core3.tenantId).toBe("default");
  });

  it("stale probe evidence (10 min old) is STALE, never LIVE, and keeps the measured count", async () => {
    await seedFresh(ago(10 * 60_000));
    const o = await readLiveOverview(container, session("owner"), {
      vps,
      services: async () => [],
    });
    expect(o.sources.workers).toMatchObject({ state: "stale", data: { registered: 1 } });
  });

  it("empty tables: degraded with NO_SOURCE_TIMESTAMP, zero counts are real rows, price status UNKNOWN", async () => {
    const o = await readLiveOverview(container, session("owner"), {
      vps,
      services: async () => [],
    });
    for (const key of ["core3", "workers", "memory"] as const) {
      expect(o.sources[key]).toMatchObject({ state: "degraded", errorCode: "NO_SOURCE_TIMESTAMP" });
    }
    expect(o.sources.workers.data?.registered).toBe(0);
    expect(o.sources.omniroute.data?.spend?.priceStatus).toBe("UNKNOWN");
    expect(o.incidents).toEqual([]);
  });

  it("linked scope (viewer): tenant-wide sources are forbidden and no aggregate query runs for them", async () => {
    await seedFresh(now());
    const o = await readLiveOverview(container, session("viewer"), {
      vps,
      services: async () => [],
    });
    expect(o.scope).toBe("linked");
    for (const key of ["workers", "omniroute", "memory", "vps"] as const) {
      expect(o.sources[key]).toMatchObject({
        state: "forbidden",
        data: null,
        errorCode: "FORBIDDEN_SCOPE",
      });
    }
    expect(o.sources.core3.data?.scheduler).toBeNull();
  });

  it("database unreachable: scheduler, ledger and memory are unavailable with READ_FAILED, nothing fabricated", async () => {
    const broken = createDatabase(
      TEST_DATABASE_URL.replace(/\/[^/]+$/, "/icos_test_does_not_exist"),
    );
    try {
      const tasks = new PostgresTaskRepository(broken.db);
      const c = {
        ...container,
        db: broken.db,
        databaseHealth: createDatabaseHealth(broken.sql),
        tasks,
        mission: new PostgresMissionRepository(broken.db, tasks),
        dispatchAttempts: new PostgresDispatchAttemptRepository(broken.db),
        workerRegistryStore: new PostgresWorkerRegistryStore(broken.db),
      } as unknown as Container;
      const o = await readLiveOverview(c, session("owner"), { vps, services: async () => [] });
      for (const key of ["core3", "workers", "memory"] as const) {
        expect(o.sources[key]).toMatchObject({
          state: "unavailable",
          data: null,
          errorCode: "READ_FAILED",
        });
      }
      expect(o.sources.omniroute.data).toMatchObject({ spend: null, spendErrorCode: "UNKNOWN" });
      expect(JSON.stringify(o)).not.toMatch(/postgres(ql)?:\/\/|password|does_not_exist/i);
    } finally {
      await broken.close();
    }
  });
});
