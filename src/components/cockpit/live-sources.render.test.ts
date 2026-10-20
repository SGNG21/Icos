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
  // La preuve D1 précède l'ajout du bloc `services` : reconstruit depuis les services sondés.
  return {
    ...raw.overview,
    services: raw.overview.services ?? {
      state: "ok",
      observedAt: raw.overview.sources.omniroute.observedAt,
      collectedAt: raw.overview.generatedAt,
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
          checkedAt: raw.overview.sources.memory.data?.postgres?.checkedAt,
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
    expect(out).toContain("Probes failed");
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
