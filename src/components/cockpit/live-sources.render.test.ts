import { readFile } from "node:fs/promises";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { LiveOverview, VpsFacts, WorkersSummary } from "@/features/cockpit/live-overview";
import type { Observed } from "@/features/cockpit/observed";

vi.mock("next/navigation", () => ({
  usePathname: () => "/cockpit",
  useRouter: () => ({ refresh: () => {} }),
}));

const {
  Freshness,
  HostResourcesPanel,
  LiveSourcesPanel,
  OmniRoutePanel,
  ServicesPanel,
  WorkersSummaryPanel,
  observedActivity,
} = await import("./live-sources");

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/** Preuve D1 : sortie réelle (masquée) de scripts/cockpit-live-verify.ts du 2026-10-19 23:44 UTC. */
async function realOverview(): Promise<LiveOverview> {
  const raw = JSON.parse(
    await readFile(
      new URL(
        "../../../docs/reports/evidence/cockpit-live-d1-verify-2026-10-20.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { overview: LiveOverview };
  // La preuve D1 précède l'ajout du bloc `services`, du schéma et des compteurs détaillés
  // (dead24h, staleActive/recentFailed, décomposition du ledger) : complétés depuis ce que la
  // preuve porte déjà (3 sondes en échec datées du même balayage, ledger 100 % UNPRICED, 0 dead).
  const o = raw.overview;
  const w = o.sources.workers.data!;
  const sp = o.sources.omniroute.data!.spend!;
  const sched = o.sources.core3.data!.scheduler!;
  return {
    ...o,
    schema: 1,
    sources: {
      ...o.sources,
      core3: {
        ...o.sources.core3,
        data: {
          ...o.sources.core3.data!,
          scheduler: { ...sched, dead24h: sched.dead24h ?? sched.dead },
        },
      },
      workers: {
        ...o.sources.workers,
        data: {
          ...w,
          staleActive: w.staleActive ?? 0,
          recentFailed: w.recentFailed ?? w.byProbeOutcome.failed ?? 0,
        },
      },
      omniroute: {
        ...o.sources.omniroute,
        data: {
          ...o.sources.omniroute.data!,
          spend: {
            ...sp,
            metered24h: sp.metered24h ?? sp.calls24h,
            unmetered24h: sp.unmetered24h ?? 0,
            priced24h: sp.priced24h ?? 0,
            freeTier24h: sp.freeTier24h ?? 0,
            tokensUnknown24h: sp.tokensUnknown24h ?? 0,
            currencies: sp.currencies ?? 0,
            ledgerTenantId: sp.ledgerTenantId ?? "icos-holding",
          },
        },
      },
    },
    services: o.services ?? {
      state: "ok",
      observedAt: o.sources.omniroute.observedAt,
      collectedAt: o.generatedAt,
      maxAgeMs: 30_000,
      source: "sondes de services",
      data: [
        {
          key: "postgres",
          label: "PostgreSQL",
          state: "operational",
          detail: "Requête exécutée.",
          source: "SELECT 1",
          process: null,
          availability: { state: "operational", detail: "Requête exécutée.", latencyMs: 4 },
          mission: { state: "operational", detail: "Authentification, rôles et audit servis." },
          checkedAt: o.sources.memory.data?.postgres?.checkedAt,
        },
        {
          key: "temporal",
          label: "Temporal",
          state: "not_instrumented",
          detail: "Aucune sonde composée.",
          source: "aucune sonde composée dans ce processus",
          process: { state: "not_instrumented", detail: "Aucune sonde composée." },
          availability: { state: "not_instrumented", detail: "Aucune sonde composée." },
          mission: { state: "not_instrumented", detail: "Aucune sonde composée." },
        },
      ],
    },
  };
}

const SENSITIVE =
  /postgres(ql)?:\/\/|password|secret|bearer|api[_-]?key|session_token|DATABASE_URL|127\.0\.0\.1/i;

describe("live panels on real evidence", () => {
  it("overview: five sources with state, source, timestamp and threshold, incidents named, no secret", async () => {
    const o = await realOverview();
    const out = html(h(LiveSourcesPanel, { overview: o }));
    for (const label of ["CORE3", "Workers", "OmniRoute", "PostgreSQL", "VPS"])
      expect(out).toContain(label);
    expect(out.match(/>LIVE</g)?.length).toBe(5);
    expect(out).toContain("UNPRICED 25,602/25,602");
    expect(out).toContain("11 routable");
    expect(out).toContain("VRAM NO_TELEMETRY");
    expect(out).toContain("WORKER_PROBE_FAILED");
    expect(out).toContain("Threshold");
    expect(out).toContain("No activity observed");
    expect(out).not.toContain('data-observed="true"');
    expect(out).not.toMatch(SENSITIVE);
    expect(observedActivity(o)).toBe(0);
  });

  it("system: host tiles are measured values, VRAM stays UNKNOWN, services in three layers", async () => {
    const o = await realOverview();
    const host = html(h(HostResourcesPanel, { vps: o.sources.vps }));
    expect(host).toContain("CPU usage");
    expect(host).toContain("25%");
    expect(host).toContain("8 vCPU");
    expect(host).toMatch(/VRAM[\s\S]*UNKNOWN/);
    expect(host).toContain('data-tone="ok"');
    const services = html(h(ServicesPanel, { services: o.services }));
    expect(services).toContain("PostgreSQL");
    expect(services).toContain("not instrumented");
    expect(services).not.toMatch(SENSITIVE);
  });

  it("providers: gateway degraded is orange not red, cost stays NOT AVAILABLE while unpriced", async () => {
    const o = await realOverview();
    const out = html(h(OmniRoutePanel, { omniroute: o.sources.omniroute }));
    expect(out).toContain("DEGRADED");
    expect(out).toContain('data-tone="warn"');
    expect(out).toContain("UNPRICED 25,602/25,602");
    expect(out).toContain("NOT AVAILABLE");
    expect(out).toContain("BR-05");
    expect(out).not.toMatch(/Cost 24h[\s\S]{0,200}0\.00/);
  });

  it("workers: failed probes are a red tile, routable count is proven by dated evidence", async () => {
    const o = await realOverview();
    const out = html(h(WorkersSummaryPanel, { workers: o.sources.workers }));
    expect(out).toContain("Recent failed probes (active)");
    expect(out).toContain('data-tone="critical"');
    expect(out).toContain("Routable (proven)");
    expect(out).toContain("last_probe_at");
  });
});

describe("live panels on missing, stale and forbidden data", () => {
  const base = { collectedAt: "2026-10-20T00:00:00.000Z", source: "t", maxAgeMs: 30_000 };

  it("forbidden and unavailable render grey badges and no number", () => {
    const forbidden: Observed<never> = {
      ...base,
      state: "forbidden",
      observedAt: null,
      data: null,
      errorCode: "FORBIDDEN_SCOPE",
    };
    const unavailable: Observed<never> = {
      ...base,
      state: "unavailable",
      observedAt: null,
      data: null,
      errorCode: "NOT_CONNECTED",
    };
    for (const [panel, prop] of [
      [HostResourcesPanel, "vps"],
      [OmniRoutePanel, "omniroute"],
      [WorkersSummaryPanel, "workers"],
      [ServicesPanel, "services"],
    ] as const) {
      for (const o of [forbidden, unavailable]) {
        const out = html(h(panel as never, { [prop]: o } as never));
        expect(out).toContain(o.state.toUpperCase());
        expect(out).toContain(o.errorCode!);
        expect(out).toContain('data-tone="unknown"');
        expect(out).not.toContain('data-tone="critical"');
        expect(out).not.toMatch(/cx-metric__value[^<]*<[^>]*>0</);
      }
    }
  });

  it("stale is orange with STALE and keeps the measured value and its timestamp", () => {
    const stale: Observed<VpsFacts> = {
      ...base,
      state: "stale",
      observedAt: "2026-10-19T23:58:00.000Z",
      data: {
        hostname: null,
        sampledAt: "2026-10-19T23:58:00.000Z",
        overall: "ok",
        cores: 2,
        cpuUsage: 0.5,
        load1: 1,
        memoryRatio: 0.5,
        diskRatio: 0.5,
        vram: "NO_TELEMETRY",
      },
    };
    const out = html(h(HostResourcesPanel, { vps: stale }));
    expect(out).toContain("STALE");
    expect(out).toContain('data-tone="warn"');
    expect(out).toContain("50%");
    expect(out).toContain("2m ago");
    // Périmée : les tuiles ne jugent plus (ni vert ni rouge), seule la fraîcheur parle.
    expect(out).not.toContain('data-tone="ok"');
    expect(out).not.toContain('data-tone="critical"');
  });

  it("sous-sources illisibles : jamais 0 ni NOT CONNECTED à tort, activité UNKNOWN sans animation", async () => {
    const o = await realOverview();
    const partial: LiveOverview = {
      ...o,
      sources: {
        ...o.sources,
        core3: {
          ...o.sources.core3,
          state: "degraded",
          errorCode: "READ_FAILED",
          data: { ...o.sources.core3.data!, attempts: null, attemptsErrorCode: "READ_FAILED" },
        },
        omniroute: {
          ...o.sources.omniroute,
          state: "degraded",
          errorCode: "LEDGER_UNAVAILABLE",
          data: { ...o.sources.omniroute.data!, spend: null, spendErrorCode: "READ_FAILED" },
        },
      },
    };
    expect(observedActivity(partial)).toBeNull();
    const overview = html(h(LiveSourcesPanel, { overview: partial }));
    expect(overview).toContain("Activity UNKNOWN");
    expect(overview).not.toContain("No activity observed");
    expect(overview).not.toContain('data-observed="true"');
    expect(overview).toContain("dispatches UNAVAILABLE (READ_FAILED)");
    expect(overview).not.toContain("0 dispatch");
    const providers = html(h(OmniRoutePanel, { omniroute: partial.sources.omniroute }));
    expect(providers).toContain("UNKNOWN");
    expect(providers).not.toContain("NOT CONNECTED");
    const disconnected = html(
      h(OmniRoutePanel, {
        omniroute: {
          ...partial.sources.omniroute,
          data: { ...partial.sources.omniroute.data!, spendErrorCode: "NOT_CONNECTED" },
        },
      }),
    );
    expect(disconnected).toContain("NOT CONNECTED");
  });

  it("CPU inconnu : pas de « 0 vCPU », tuile charge sans ton", () => {
    const o: Observed<VpsFacts> = {
      ...base,
      state: "degraded",
      errorCode: "CPU_COUNT_UNKNOWN",
      observedAt: "2026-10-19T23:59:59.000Z",
      data: {
        hostname: null,
        sampledAt: "2026-10-19T23:59:59.000Z",
        overall: "ok",
        cores: null,
        cpuUsage: null,
        load1: 0.1,
        memoryRatio: 0.5,
        diskRatio: 0.5,
        vram: "NO_TELEMETRY",
      },
    };
    const out = html(h(HostResourcesPanel, { vps: o }));
    expect(out).not.toContain("0 vCPU");
    expect(out).toContain("vCPU count unknown");
    expect(out).not.toContain('data-tone="critical"');
  });

  it("degraded without source timestamp names NO_SOURCE_TIMESTAMP", () => {
    const o: Observed<WorkersSummary> = {
      ...base,
      state: "degraded",
      observedAt: null,
      errorCode: "NO_SOURCE_TIMESTAMP",
      data: {
        registered: 2,
        active: 2,
        routable: 0,
        byProbeOutcome: { never: 2 },
        byHealth: { unknown: 2 },
        staleActive: 2,
        recentFailed: 0,
        activeAssignments: 0,
        lastProbeAt: null,
      },
    };
    const out = html(h(Freshness, { observed: o }));
    expect(out).toContain("DEGRADED");
    expect(out).toContain("NO_SOURCE_TIMESTAMP");
    expect(out).toContain("no source timestamp");
  });

  it("observed activity animates only when a dispatch or a lease is held", async () => {
    const o = await realOverview();
    const active: LiveOverview = {
      ...o,
      sources: {
        ...o.sources,
        workers: {
          ...o.sources.workers,
          data: { ...o.sources.workers.data!, activeAssignments: 2 },
        },
      },
    };
    expect(observedActivity(active)).toBe(2);
    expect(html(h(LiveSourcesPanel, { overview: active }))).toContain('data-observed="true"');
  });
});
