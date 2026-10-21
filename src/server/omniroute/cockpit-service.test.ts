import { describe, expect, it, vi } from "vitest";

import { buildMemoryContainer } from "@/server/container";
import type { OmniRouteMonitoringResult } from "@/server/telemetry/omniroute-monitoring";

import { omniRouteCockpitResponseSchema } from "./cockpit-contract";
import { readOmniRouteCockpit } from "./cockpit-service";

const health: OmniRouteMonitoringResult = {
  ok: true,
  latencyMs: 12,
  snapshot: {
    status: "healthy",
    partial: false,
    uptimeSeconds: 3600,
    breakers: { open: 0, halfOpen: 0, degraded: 1, closed: 2, total: 3 },
    providers: { configured: 4, active: 3 },
    providerStates: {
      nvidia: { state: "CLOSED", failures: 0 },
      "duckduckgo-web": { state: "DEGRADED", failures: 6 },
    },
  },
};

const listedModels = [
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra",
  "codex/gpt-5.6-sol-xhigh",
  "unscoped-model",
];

describe("readOmniRouteCockpit", () => {
  it("compose la santé et le catalogue OmniRoute sans exposer de secret ni d'identifiant de modèle", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    const result = await readOmniRouteCockpit(container, {
      now: new Date("2026-10-21T18:00:00.000Z"),
      monitor: { monitoringHealth: vi.fn(async () => health) },
      listModels: vi.fn(async () => listedModels),
      spend: vi.fn(async () => ({
        calls24h: 4,
        metered24h: 3,
        unmetered24h: 1,
        priced24h: 2,
        freeTier24h: 0,
        unpriced24h: 1,
        tokens24h: 1200,
        tokensUnknown24h: 1,
        amount24h: null,
        currency: "USD",
        currencies: 1,
        lastObservedAt: "2026-10-21T17:59:00.000Z",
        ledgerTenantId: "must-not-leak",
      })),
    });

    expect(result).toMatchObject({
      schema: 1,
      generatedAt: "2026-10-21T18:00:00.000Z",
      readOnly: true,
      health: {
        available: true,
        value: { state: "degraded", latencyMs: 12 },
      },
      providers: {
        available: true,
        value: {
          configured: 4,
          active: 3,
          openBreakers: 0,
          degradedBreakers: 1,
          providers: [
            { id: "duckduckgo-web", state: "degraded", failures: 6 },
            { id: "nvidia", state: "healthy", failures: 0 },
          ],
        },
      },
      models: {
        available: true,
        value: { listed: 4, byProvider: { codex: 1, nvidia: 2, unscoped: 1 } },
      },
      usage: {
        available: true,
        value: { calls: 4, meteredCalls: 3, unmeteredCalls: 1, tokens: 1200 },
      },
      cost: {
        available: true,
        value: { status: "UNPRICED", amount: null, currency: "USD", unpricedCalls: 1 },
      },
      errors: { available: false, code: "NOT_INSTRUMENTED" },
      latency: { available: false, code: "NOT_INSTRUMENTED" },
    });
    expect(omniRouteCockpitResponseSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /must-not-leak|nemotron-3|gpt-5|credential|password|secret|bearer|api[_-]?key/i,
    );
  });

  it("isole les sous-sources absentes au lieu d'inventer des zéros", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    const result = await readOmniRouteCockpit(container, {
      now: new Date("2026-10-21T18:00:00.000Z"),
      monitor: {
        monitoringHealth: vi.fn(async () => ({
          ok: false as const,
          latencyMs: 500,
          error: "timeout" as const,
        })),
      },
      listModels: vi.fn(async () => {
        throw new Error("listing unavailable");
      }),
      spend: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    });

    expect(result).toMatchObject({
      health: { available: false, code: "UPSTREAM_TIMEOUT" },
      providers: { available: false, code: "UPSTREAM_TIMEOUT" },
      models: { available: false, code: "READ_FAILED" },
      usage: { available: false, code: "READ_FAILED" },
      cost: { available: false, code: "READ_FAILED" },
    });
    expect(omniRouteCockpitResponseSchema.safeParse(result).success).toBe(true);
  });

  it("ne tente aucun appel amont ni ledger si OmniRoute n'est pas configuré", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    const monitor = { monitoringHealth: vi.fn(async () => health) };
    const listModels = vi.fn(async () => listedModels);
    const spend = vi.fn(async () => {
      throw new Error("must not run");
    });

    const result = await readOmniRouteCockpit(container, {
      now: new Date("2026-10-21T18:00:00.000Z"),
      monitor,
      listModels,
      spend,
      configured: false,
    });

    expect(result).toMatchObject({
      health: { available: false, code: "NOT_CONNECTED" },
      providers: { available: false, code: "NOT_CONNECTED" },
      models: { available: false, code: "NOT_CONNECTED" },
      usage: { available: false, code: "NOT_CONNECTED" },
      cost: { available: false, code: "NOT_CONNECTED" },
    });
    expect(monitor.monitoringHealth).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });
});
