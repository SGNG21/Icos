import { describe, expect, it } from "vitest";

import type { ServiceHealth } from "@/core/telemetry";
import { hermesWorker } from "@/server/services/worker-registry/fixtures";

import {
  buildLiveOverview,
  LIVE_MAX_AGE_MS,
  priceStatusOf,
  type LiveOverviewInputs,
  type SpendFacts,
} from "./live-overview";
import { missing, real } from "./truth";

const now = new Date("2026-10-20T00:00:00.000Z");
const t = (secondsAgo: number) => new Date(now.getTime() - secondsAgo * 1000).toISOString();

const svc = (key: string, state: ServiceHealth["state"], checkedAt?: string): ServiceHealth => ({
  key,
  label: key,
  state,
  detail: `${key} ${state}`,
  source: "test",
  process: null,
  availability: { state, detail: `${key} ${state}` },
  mission: null,
  ...(checkedAt ? { checkedAt } : {}),
});

const spend: SpendFacts = {
  calls24h: 25_636,
  tokens24h: 1_000,
  unpriced24h: 25_636,
  amount24h: null,
  currency: null,
  lastObservedAt: t(40),
};

function inputs(overrides: Partial<LiveOverviewInputs> = {}): LiveOverviewInputs {
  return {
    now,
    scope: "global",
    tenantId: "default",
    missions: real([]),
    attempts: real([]),
    scheduler: real({
      activeByKind: { probe_workers: 1, supervisor_observe: 1 },
      leased: 0,
      dead: 0,
      lastUpdatedAt: t(30),
    }),
    workers: real([
      {
        ...hermesWorker,
        status: "active",
        health: "healthy",
        availability: "available",
        lastProbeOutcome: "ok",
        lastProbeAt: t(10),
      },
      {
        ...hermesWorker,
        id: "w-2",
        lastProbeOutcome: "failed",
        health: "unhealthy",
        lastProbeAt: t(20),
      },
    ]),
    activeAssignments: real([]),
    spend: real(spend),
    services: real([
      svc("postgres", "operational", t(5)),
      svc("omniroute", "operational", t(5)),
      svc("nemotron", "operational"),
      svc("temporal", "not_instrumented"),
    ]),
    memory: real({
      records: 99,
      active: 0,
      retrievals24h: 534,
      entities: 3,
      relations: 1,
      lastWriteAt: t(3600 * 7),
    }),
    vps: real({
      hostname: "vps",
      sampledAt: t(8),
      overall: "ok",
      cores: 8,
      cpuUsage: 0.2,
      load1: 1.2,
      memoryRatio: 0.36,
      diskRatio: 0.23,
      vram: "NO_TELEMETRY",
    }),
    ...overrides,
  };
}

describe("buildLiveOverview", () => {
  it("projette les cinq sources, fraîches, avec tenant et horodatages réels", () => {
    const o = buildLiveOverview(inputs());
    expect(o.generatedAt).toBe(now.toISOString());
    expect(Object.keys(o.sources)).toEqual(["core3", "workers", "omniroute", "memory", "vps"]);
    for (const s of Object.values(o.sources)) {
      expect(s.collectedAt).toBe(now.toISOString());
      expect(s.tenantId).toBe("default");
    }
    expect(o.sources.core3).toMatchObject({
      state: "ok",
      observedAt: t(30),
      maxAgeMs: LIVE_MAX_AGE_MS.core3,
    });
    expect(o.sources.workers).toMatchObject({
      state: "ok",
      observedAt: t(10),
      data: { registered: 2, active: 2, routable: 1, byProbeOutcome: { ok: 1, failed: 1 } },
    });
    expect(o.sources.omniroute).toMatchObject({
      state: "ok",
      observedAt: t(5),
      data: {
        health: { state: "operational" },
        spend: { priceStatus: "UNPRICED", amount24h: null },
      },
    });
    // La mémoire n'a pas de seuil : vieille de 7 h, elle reste « ok ».
    expect(o.sources.memory).toMatchObject({
      state: "ok",
      maxAgeMs: null,
      data: { entities: 3, postgres: { state: "operational" } },
    });
    expect(o.sources.vps).toMatchObject({ state: "ok", data: { vram: "NO_TELEMETRY", cores: 8 } });
    expect(o.services).toMatchObject({ state: "ok", observedAt: t(5) });
    expect(o.services.data?.map((s) => s.key)).toEqual([
      "postgres",
      "omniroute",
      "nemotron",
      "temporal",
    ]);
    expect(o.incidents.map((i) => i.code)).toEqual(["WORKER_PROBE_FAILED"]);
  });

  it("périmé : une preuve de sonde plus vieille que l'horizon devient stale, jamais verte", () => {
    const o = buildLiveOverview(
      inputs({ workers: real([{ ...hermesWorker, lastProbeOutcome: "ok", lastProbeAt: t(121) }]) }),
    );
    expect(o.sources.workers.state).toBe("stale");
    expect(o.sources.workers.data?.registered).toBe(1);
  });

  it("jamais sondé : données lues mais fraîcheur improuvable → degraded, pas zéro", () => {
    const o = buildLiveOverview(inputs({ workers: real([hermesWorker]) }));
    expect(o.sources.workers).toMatchObject({
      state: "degraded",
      observedAt: null,
      errorCode: "NO_SOURCE_TIMESTAMP",
    });
  });

  it("portée liée : les sources tenant-wide sont forbidden, CORE3 reste lisible", () => {
    const refused = missing<never>(
      "not_available",
      "This source is visible to owner/admin scope only.",
    );
    const o = buildLiveOverview(
      inputs({
        scope: "linked",
        workers: refused,
        activeAssignments: refused,
        scheduler: refused,
        spend: refused,
        services: refused,
        memory: refused,
        vps: refused,
      }),
    );
    for (const key of ["workers", "omniroute", "memory", "vps"] as const) {
      expect(o.sources[key]).toMatchObject({
        state: "forbidden",
        data: null,
        errorCode: "FORBIDDEN_SCOPE",
      });
    }
    expect(o.sources.core3.state).toBe("degraded"); // missions lues (0), scheduler refusé → pas d'horodatage
    expect(o.sources.core3.data?.schedulerErrorCode).toBe("NOT_AVAILABLE");
    expect(o.incidents).toEqual([]);
  });

  it("sans base durable : scheduler/ledger/mémoire unavailable avec NOT_CONNECTED, données null", () => {
    const noDb = missing<never>("not_connected", "This process has no durable database.");
    const o = buildLiveOverview(inputs({ scheduler: noDb, spend: noDb, memory: noDb }));
    expect(o.sources.memory).toMatchObject({
      state: "unavailable",
      data: null,
      errorCode: "NOT_CONNECTED",
    });
    expect(o.sources.omniroute.data).toMatchObject({
      spend: null,
      spendErrorCode: "NOT_CONNECTED",
    });
    expect(o.sources.core3.data).toMatchObject({
      scheduler: null,
      schedulerErrorCode: "NOT_CONNECTED",
    });
  });

  it("incidents confirmés uniquement : OmniRoute down, PostgreSQL down, hôte saturé, jobs dead", () => {
    const o = buildLiveOverview(
      inputs({
        services: real([svc("postgres", "down", t(1)), svc("omniroute", "down", t(1))]),
        vps: real({
          hostname: null,
          sampledAt: t(1),
          overall: "incident",
          cores: 1,
          cpuUsage: 0.99,
          load1: 9,
          memoryRatio: 0.95,
          diskRatio: 0.9,
          vram: "NO_TELEMETRY",
        }),
        scheduler: real({ activeByKind: {}, leased: 0, dead: 2, lastUpdatedAt: t(1) }),
        workers: real([]),
      }),
    );
    expect(o.incidents.map((i) => i.code).sort()).toEqual(
      ["HOST_SATURATED", "OMNIROUTE_DOWN", "POSTGRES_DOWN", "SCHEDULER_DEAD_JOBS"].sort(),
    );
    // Un registre vide n'est pas un incident ni une mesure fraîche : degraded (aucune preuve).
    expect(o.sources.workers.state).toBe("degraded");
  });

  it("statut de prix : jamais 0 par défaut", () => {
    expect(priceStatusOf(spend)).toBe("UNPRICED");
    expect(priceStatusOf({ ...spend, calls24h: 0, unpriced24h: 0 })).toBe("UNKNOWN");
    expect(priceStatusOf({ ...spend, unpriced24h: 0, amount24h: 1.5, currency: "EUR" })).toBe(
      "PRICED",
    );
    expect(priceStatusOf({ ...spend, unpriced24h: 1, amount24h: 1.5 })).toBe("UNPRICED");
  });
});
