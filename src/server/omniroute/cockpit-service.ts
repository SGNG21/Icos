import { loadEnv } from "@/config/env";
import { priceStatusOf, type SpendFacts } from "@/features/cockpit/live-overview";
import { readSpendFacts } from "@/features/cockpit/live-facts";
import { SPEND_LEDGER_TENANT_ID } from "@/server/budget/compose-spend";
import type { Container } from "@/server/container";
import {
  createOmniRouteMonitor,
  type OmniRouteMonitorPort,
  type OmniRouteMonitoringResult,
  type OmniRouteMonitoringSnapshot,
} from "@/server/telemetry/omniroute-monitoring";
import { isOmniRouteConfigured } from "@/server/telemetry/service-probes";
import { listOmniRouteModels } from "@/server/workers/compute-fleet";

import type { OmniRouteCockpitResponse } from "./cockpit-contract";

const WINDOW_MS = 24 * 60 * 60 * 1_000;
const MONITORING_TIMEOUT_MS = 2_500;
const MODELS_TIMEOUT_MS = 10_000;

type SourceCode =
  | "NOT_CONNECTED"
  | "READ_FAILED"
  | "PROBE_MISSING"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNREACHABLE"
  | "UPSTREAM_HTTP"
  | "UPSTREAM_TOO_LARGE"
  | "UPSTREAM_INVALID";

export interface OmniRouteCockpitDependencies {
  now?: Date;
  configured?: boolean;
  monitor?: OmniRouteMonitorPort;
  listModels?: () => Promise<string[]>;
  spend?: () => Promise<SpendFacts>;
  environment?: Readonly<Record<string, string | undefined>>;
}

const unavailable = <T>(code: SourceCode) => ({ available: false as const, code }) as T;
const available = <T>(value: T) => ({ available: true as const, value });

function monitoringCode(result: Extract<OmniRouteMonitoringResult, { ok: false }>): SourceCode {
  switch (result.error) {
    case "timeout":
      return "UPSTREAM_TIMEOUT";
    case "unreachable":
      return "UPSTREAM_UNREACHABLE";
    case "http":
      return "UPSTREAM_HTTP";
    case "too_large":
      return "UPSTREAM_TOO_LARGE";
    case "invalid":
      return "UPSTREAM_INVALID";
  }
}

function healthState(snapshot: OmniRouteMonitoringSnapshot) {
  if (snapshot.status === "unhealthy") return "down" as const;
  if (snapshot.status === "unknown") return "not_instrumented" as const;
  if (
    snapshot.partial ||
    snapshot.status === "degraded" ||
    (snapshot.breakers?.open ?? 0) > 0 ||
    (snapshot.breakers?.halfOpen ?? 0) > 0 ||
    (snapshot.breakers?.degraded ?? 0) > 0 ||
    (snapshot.providers.configured !== null &&
      snapshot.providers.active !== null &&
      snapshot.providers.active < snapshot.providers.configured)
  ) {
    return "degraded" as const;
  }
  return "operational" as const;
}

function providerState(state: string) {
  switch (state) {
    case "CLOSED":
      return "healthy" as const;
    case "DEGRADED":
    case "HALF_OPEN":
      return "degraded" as const;
    case "OPEN":
      return "down" as const;
    default:
      return "unknown" as const;
  }
}

function providerOf(modelId: string): string {
  if (!modelId.includes("/")) return "unscoped";
  const prefix = modelId.split("/", 1)[0]?.toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(prefix) ? prefix : "unscoped";
}

function defaultMonitor(environment: Readonly<Record<string, string | undefined>>) {
  try {
    const baseUrl = loadEnv(environment as Record<string, string | undefined>).OMNIROUTE_BASE_URL;
    return baseUrl ? createOmniRouteMonitor(baseUrl) : undefined;
  } catch {
    return undefined;
  }
}

function defaultModelListing(environment: Readonly<Record<string, string | undefined>>) {
  return async () => {
    const env = loadEnv(environment as Record<string, string | undefined>);
    if (!env.OMNIROUTE_BASE_URL || !env.OMNIROUTE_API_KEY) throw new Error("NOT_CONNECTED");
    return listOmniRouteModels({
      baseUrl: env.OMNIROUTE_BASE_URL,
      credential: env.OMNIROUTE_API_KEY,
      timeoutMs: MODELS_TIMEOUT_MS,
    });
  };
}

function defaultSpend(container: Container, now: Date) {
  if (!container.db) return undefined;
  return () =>
    readSpendFacts(container.db!, SPEND_LEDGER_TENANT_ID, new Date(now.getTime() - WINDOW_MS));
}

/**
 * Compose la façade OmniRoute en lecture seule. Les seuls appels amont sont des
 * GET serveur-à-serveur ; le credential du catalogue n'entre jamais dans la réponse.
 */
export async function readOmniRouteCockpit(
  container: Container,
  dependencies: OmniRouteCockpitDependencies = {},
): Promise<OmniRouteCockpitResponse> {
  const now = dependencies.now ?? new Date();
  const environment = dependencies.environment ?? process.env;
  const injectedSource = Boolean(
    dependencies.monitor || dependencies.listModels || dependencies.spend,
  );
  const configured =
    dependencies.configured ?? (injectedSource || isOmniRouteConfigured(environment));
  const absent: OmniRouteCockpitResponse = {
    schema: 1,
    generatedAt: now.toISOString(),
    readOnly: true,
    health: unavailable("NOT_CONNECTED"),
    providers: unavailable("NOT_CONNECTED"),
    models: unavailable("NOT_CONNECTED"),
    usage: unavailable("NOT_CONNECTED"),
    cost: unavailable("NOT_CONNECTED"),
    errors: { window: "24h", available: false, code: "NOT_INSTRUMENTED" },
    latency: { window: "24h", available: false, code: "NOT_INSTRUMENTED" },
  };
  if (!configured) return absent;

  const monitor = dependencies.monitor ?? defaultMonitor(environment);
  const listModels = dependencies.listModels ?? defaultModelListing(environment);
  const spend = dependencies.spend ?? defaultSpend(container, now);

  const monitoringPromise = monitor
    ? monitor.monitoringHealth(MONITORING_TIMEOUT_MS)
    : Promise.resolve(null);
  const modelsPromise = listModels().catch(() => null);
  const spendPromise = spend ? spend().catch(() => null) : Promise.resolve(null);
  const [monitoring, modelIds, spending] = await Promise.all([
    monitoringPromise,
    modelsPromise,
    spendPromise,
  ]);

  const response: OmniRouteCockpitResponse = { ...absent };
  if (monitoring === null) {
    response.health = unavailable("PROBE_MISSING");
    response.providers = unavailable("PROBE_MISSING");
  } else if (!monitoring.ok) {
    const code = monitoringCode(monitoring);
    response.health = unavailable(code);
    response.providers = unavailable(code);
  } else {
    const snapshot = monitoring.snapshot;
    const state = healthState(snapshot);
    response.health = available({
      state,
      detail:
        state === "operational"
          ? "OmniRoute répond et aucun signal de dégradation n'est mesuré."
          : "OmniRoute répond avec au moins un signal de dégradation ou un relevé incomplet.",
      checkedAt: now.toISOString(),
      latencyMs: monitoring.latencyMs,
    });
    response.providers = available({
      configured: snapshot.providers.configured,
      active: snapshot.providers.active,
      openBreakers: snapshot.breakers?.open ?? null,
      degradedBreakers:
        snapshot.breakers === null ? null : snapshot.breakers.degraded + snapshot.breakers.halfOpen,
      providers: Object.entries(snapshot.providerStates)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, entry]) => ({
          id,
          state: providerState(entry.state),
          failures: entry.failures,
        })),
    });
  }

  response.models = modelIds
    ? available({
        listed: modelIds.length,
        byProvider: modelIds.reduce<Record<string, number>>((counts, id) => {
          const provider = providerOf(id);
          counts[provider] = (counts[provider] ?? 0) + 1;
          return counts;
        }, {}),
      })
    : unavailable("READ_FAILED");

  if (spending) {
    response.usage = available({
      window: "24h",
      calls: spending.calls24h,
      meteredCalls: spending.metered24h,
      unmeteredCalls: spending.unmetered24h,
      tokens: spending.tokens24h,
      tokensUnknownCalls: spending.tokensUnknown24h,
      lastObservedAt: spending.lastObservedAt,
    });
    response.cost = available({
      window: "24h",
      status: priceStatusOf(spending),
      amount: spending.amount24h,
      currency: spending.currency,
      pricedCalls: spending.priced24h,
      freeTierCalls: spending.freeTier24h,
      unpricedCalls: spending.unpriced24h,
    });
  } else {
    response.usage = unavailable("READ_FAILED");
    response.cost = unavailable("READ_FAILED");
  }

  return response;
}
