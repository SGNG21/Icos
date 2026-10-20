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
import { scopeRefused } from "./observed";
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
  metered24h: 25_636,
  unmetered24h: 0,
  priced24h: 0,
  freeTier24h: 0,
  unpriced24h: 25_636,
  tokens24h: 1_000,
  tokensUnknown24h: 0,
  amount24h: null,
  currency: null,
  currencies: 0,
  lastObservedAt: t(40),
  ledgerTenantId: "icos-holding",
};

const healthyWorker = {
  ...hermesWorker,
  status: "active" as const,
  health: "healthy" as const,
  availability: "available" as const,
  lastProbeOutcome: "ok" as const,
  lastProbeAt: t(10),
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
      dead24h: 0,
      lastUpdatedAt: t(30),
    }),
    workers: real([
      healthyWorker,
      {
        ...hermesWorker,
        id: "w-2",
        status: "active",
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
  it("projette les cinq sources, fraîches, versionnées, avec tenant et horodatages réels", () => {
    const o = buildLiveOverview(inputs());
    expect(o.schema).toBe(1);
    expect(o.generatedAt).toBe(now.toISOString());
    expect(Object.keys(o.sources)).toEqual(["core3", "workers", "omniroute", "memory", "vps"]);
    for (const [key, s] of Object.entries(o.sources)) {
      expect(s.collectedAt).toBe(now.toISOString());
      // Le ledger est écrit sous son propre tenant : la source OmniRoute ne porte pas l'estampille de surface.
      if (key === "omniroute") expect(s.tenantId).toBeUndefined();
      else expect(s.tenantId).toBe("default");
    }
    expect(o.sources.omniroute.data?.spend?.ledgerTenantId).toBe("icos-holding");
    expect(o.sources.core3).toMatchObject({
      state: "ok",
      observedAt: t(30),
      maxAgeMs: LIVE_MAX_AGE_MS.core3,
      data: { attempts: { nonTerminal: 0 } },
    });
    expect(o.sources.workers).toMatchObject({
      state: "ok",
      observedAt: t(10),
      data: {
        registered: 2,
        active: 2,
        routable: 1,
        byProbeOutcome: { ok: 1, failed: 1 },
        staleActive: 0,
        recentFailed: 1,
      },
    });
    expect(o.sources.omniroute).toMatchObject({
      state: "ok",
      observedAt: t(5),
      data: {
        health: { state: "operational" },
        spend: { priceStatus: "UNPRICED", amount24h: null },
      },
    });
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

  it("dispatches illisibles : jamais 0, core3 dégradé avec le code, scheduler conservé", () => {
    const o = buildLiveOverview(inputs({ attempts: missing("unknown", "ledger down") }));
    expect(o.sources.core3).toMatchObject({ state: "degraded", errorCode: "READ_FAILED" });
    expect(o.sources.core3.data).toMatchObject({
      attempts: null,
      attemptsErrorCode: "READ_FAILED",
    });
    expect(o.sources.core3.data?.scheduler?.leased).toBe(0);
    expect(JSON.stringify(o.sources.core3.data?.attempts)).not.toContain("0");
  });

  it("missions illisibles mais scheduler lisible : core3 reste lu, dégradé, scheduler conservé", () => {
    const o = buildLiveOverview(
      inputs({ missions: missing("unknown", "x"), attempts: missing("unknown", "x") }),
    );
    expect(o.sources.core3).toMatchObject({ state: "degraded", errorCode: "READ_FAILED" });
    expect(o.sources.core3.data).toMatchObject({
      missions: null,
      missionsErrorCode: "READ_FAILED",
    });
    expect(o.sources.core3.data?.scheduler?.activeByKind.probe_workers).toBe(1);
  });

  it("affectations illisibles : workers dégradé avec le code, compteur null, jamais 0", () => {
    const o = buildLiveOverview(inputs({ activeAssignments: missing("not_connected", "x") }));
    expect(o.sources.workers).toMatchObject({ state: "degraded", errorCode: "NOT_CONNECTED" });
    expect(o.sources.workers.data).toMatchObject({
      activeAssignments: null,
      activeAssignmentsErrorCode: "NOT_CONNECTED",
    });
  });

  it("fraîcheur de flotte : un worker actif sans preuve récente dégrade la source même si un autre est frais", () => {
    const mixed = buildLiveOverview(
      inputs({
        workers: real([
          healthyWorker,
          { ...healthyWorker, id: "w-old", lastProbeAt: t(30 * 86_400) },
          { ...healthyWorker, id: "w-never", lastProbeAt: null, lastProbeOutcome: "never" },
          { ...healthyWorker, id: "w-inactive", status: "inactive", lastProbeAt: null },
        ]),
      }),
    );
    expect(mixed.sources.workers).toMatchObject({
      state: "degraded",
      errorCode: "STALE_WORKER_EVIDENCE",
      observedAt: t(10),
      data: { staleActive: 2, registered: 4 },
    });
    const old = buildLiveOverview(
      inputs({ workers: real([{ ...healthyWorker, lastProbeAt: t(121) }]) }),
    );
    expect(old.sources.workers).toMatchObject({
      state: "stale",
      errorCode: "STALE_WORKER_EVIDENCE",
    });
    expect(old.sources.workers.data?.registered).toBe(1);
  });

  it("jamais sondé / registre vide : lu mais fraîcheur improuvable → degraded, EMPTY_SOURCE si vide", () => {
    expect(
      buildLiveOverview(inputs({ workers: real([{ ...hermesWorker, status: "active" }]) })).sources
        .workers,
    ).toMatchObject({ state: "degraded", observedAt: null, errorCode: "STALE_WORKER_EVIDENCE" });
    expect(buildLiveOverview(inputs({ workers: real([]) })).sources.workers).toMatchObject({
      state: "degraded",
      errorCode: "EMPTY_SOURCE",
      data: { registered: 0 },
    });
    expect(
      buildLiveOverview(
        inputs({
          memory: real({
            records: 0,
            active: 0,
            retrievals24h: 0,
            entities: 0,
            relations: 0,
            lastWriteAt: null,
          }),
        }),
      ).sources.memory,
    ).toMatchObject({ state: "degraded", errorCode: "EMPTY_SOURCE" });
  });

  it("portée liée : les sources tenant-wide sont forbidden, CORE3 reste lisible et ok", () => {
    const o = buildLiveOverview(
      inputs({
        scope: "linked",
        workers: scopeRefused("W"),
        activeAssignments: scopeRefused("W"),
        scheduler: scopeRefused("S"),
        spend: scopeRefused("L"),
        services: scopeRefused("P"),
        memory: scopeRefused("M"),
        vps: scopeRefused("H"),
        missions: real([]),
      }),
    );
    for (const key of ["workers", "omniroute", "memory", "vps"] as const) {
      expect(o.sources[key]).toMatchObject({
        state: "forbidden",
        data: null,
        errorCode: "FORBIDDEN_SCOPE",
      });
    }
    expect(o.services).toMatchObject({ state: "forbidden", data: null });
    // Scheduler refusé par la portée : ce n'est pas une panne ; CORE3 vide → EMPTY_SOURCE.
    expect(o.sources.core3).toMatchObject({ state: "degraded", errorCode: "EMPTY_SOURCE" });
    expect(o.sources.core3.data?.schedulerErrorCode).toBe("FORBIDDEN_SCOPE");
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
    expect(o.sources.omniroute).toMatchObject({
      state: "degraded",
      errorCode: "LEDGER_UNAVAILABLE",
    });
    expect(o.sources.omniroute.data).toMatchObject({
      spend: null,
      spendErrorCode: "NOT_CONNECTED",
    });
    expect(o.sources.core3).toMatchObject({ state: "degraded", errorCode: "NOT_CONNECTED" });
    expect(o.sources.core3.data).toMatchObject({
      scheduler: null,
      schedulerErrorCode: "NOT_CONNECTED",
    });
  });

  it("OmniRoute mixte : santé fraîche + ledger illisible → degraded ; sondes illisibles + ledger lu → degraded", () => {
    const a = buildLiveOverview(inputs({ spend: missing("unknown", "x") }));
    expect(a.sources.omniroute).toMatchObject({
      state: "degraded",
      errorCode: "LEDGER_UNAVAILABLE",
    });
    const b = buildLiveOverview(inputs({ services: missing("unknown", "x") }));
    expect(b.sources.omniroute).toMatchObject({
      state: "degraded",
      errorCode: "GATEWAY_UNAVAILABLE",
    });
    expect(b.sources.omniroute.data).toMatchObject({
      health: null,
      healthErrorCode: "READ_FAILED",
    });
    expect(b.sources.omniroute.data?.spend?.calls24h).toBe(25_636);
  });

  it("incidents confirmés seulement sur une mesure fraîche", () => {
    const fresh = buildLiveOverview(
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
        scheduler: real({ activeByKind: {}, leased: 0, dead: 40, dead24h: 2, lastUpdatedAt: t(1) }),
        workers: real([]),
      }),
    );
    expect(fresh.incidents.map((i) => i.code).sort()).toEqual(
      ["HOST_SATURATED", "OMNIROUTE_DOWN", "POSTGRES_DOWN", "SCHEDULER_DEAD_JOBS"].sort(),
    );
    // Les mêmes données, périmées : aucun incident n'est affirmé.
    const stale = buildLiveOverview(
      inputs({
        services: real([svc("postgres", "down", t(3600)), svc("omniroute", "down", t(3600))]),
        vps: real({
          hostname: null,
          sampledAt: t(3600),
          overall: "incident",
          cores: 1,
          cpuUsage: 0.99,
          load1: 9,
          memoryRatio: 0.95,
          diskRatio: 0.9,
          vram: "NO_TELEMETRY",
        }),
        scheduler: real({
          activeByKind: {},
          leased: 0,
          dead: 40,
          dead24h: 0,
          lastUpdatedAt: t(3600),
        }),
        workers: real([
          { ...healthyWorker, lastProbeOutcome: "failed", lastProbeAt: t(90 * 86_400) },
        ]),
      }),
    );
    expect(stale.incidents).toEqual([]);
    expect(stale.sources.vps.state).toBe("stale");
    // Un worker inactif avec une vieille sonde échouée n'est pas un incident ; un actif frais l'est.
    const inactive = buildLiveOverview(
      inputs({
        workers: real([
          { ...healthyWorker, status: "inactive", lastProbeOutcome: "failed", lastProbeAt: t(5) },
        ]),
      }),
    );
    expect(inactive.incidents).toEqual([]);
  });

  it("sonde datée dans le futur : pas une preuve dans l'horizon, incident non affirmé", () => {
    const o = buildLiveOverview(
      inputs({
        workers: real([
          {
            ...healthyWorker,
            lastProbeOutcome: "failed",
            health: "unhealthy",
            lastProbeAt: t(-3600),
          },
        ]),
      }),
    );
    expect(o.sources.workers).toMatchObject({
      state: "degraded",
      data: { staleActive: 1, recentFailed: 0 },
    });
    expect(o.incidents).toEqual([]);
  });

  it("CPU inconnu : cores null dégrade la source VPS, jamais « 0 vCPU »", () => {
    const o = buildLiveOverview(
      inputs({
        vps: real({
          hostname: null,
          sampledAt: t(1),
          overall: "ok",
          cores: null,
          cpuUsage: null,
          load1: 0.1,
          memoryRatio: 0.5,
          diskRatio: 0.5,
          vram: "NO_TELEMETRY",
        }),
      }),
    );
    expect(o.sources.vps).toMatchObject({ state: "degraded", errorCode: "CPU_COUNT_UNKNOWN" });
  });

  it("statut de prix : un seul mot de prix inconnu, gratuité vérifiée explicite, jamais 0 par défaut", () => {
    expect(priceStatusOf(spend)).toBe("UNPRICED");
    expect(priceStatusOf({ ...spend, calls24h: 0, metered24h: 0, unpriced24h: 0 })).toBe(
      "NO_TRAFFIC",
    );
    expect(
      priceStatusOf({
        ...spend,
        unpriced24h: 0,
        priced24h: 25_636,
        amount24h: 1.5,
        currency: "EUR",
        currencies: 1,
      }),
    ).toBe("PRICED");
    expect(
      priceStatusOf({
        ...spend,
        unpriced24h: 1,
        priced24h: 25_635,
        amount24h: null,
        currencies: 1,
      }),
    ).toBe("UNPRICED");
    expect(
      priceStatusOf({ ...spend, unpriced24h: 0, priced24h: 0, freeTier24h: 25_636, currencies: 1 }),
    ).toBe("FREE_TIER");
    expect(
      priceStatusOf({
        ...spend,
        unpriced24h: 0,
        priced24h: 2,
        freeTier24h: 1,
        currencies: 2,
        amount24h: null,
      }),
    ).toBe("MIXED_CURRENCY");
    // Uniquement des appels non métrés : le prix ne peut pas être prouvé.
    expect(priceStatusOf({ ...spend, metered24h: 0, unmetered24h: 25_636, unpriced24h: 0 })).toBe(
      "UNPRICED",
    );
  });
});
