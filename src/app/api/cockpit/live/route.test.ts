import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { LiveOverview } from "@/features/cockpit/live-overview";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { hermesWorker, openhandsWorker } from "@/server/services/worker-registry/fixtures";
import {
  HostTelemetrySampler,
  setHostTelemetrySamplerForTests,
  type HostSource,
  type ProcPath,
} from "@/server/telemetry/host-sampler";
import {
  resetTelemetryRateLimiterForTests,
  TELEMETRY_RATE_LIMIT,
} from "@/server/telemetry/rate-limit";
import { ServiceProbes, setServiceProbesForTests } from "@/server/telemetry/service-probes";

import { GET } from "./route";

const CONTAINER_KEY = "__icosContainerPromise__";
const URL_ = "http://localhost/api/cockpit/live";
const COOKIE = "icos.session_token=opaque-test-value";

function authGateway(value: AuthenticatedSession | null): AuthGateway {
  return {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => value?.user ?? null,
    readHumanUserByEmail: async () => value?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => value),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
    readSessionEvidence: async () =>
      value ? { sessionId: "sess-1", userId: value.user.id, issuedAt: new Date() } : null,
    verifyPassword: async () => false,
  };
}

function install(role: Role | null): Container {
  const base = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const session: AuthenticatedSession | null =
    role === null
      ? null
      : { user: { id: "human-1", email: "h@icos.test", status: "active" }, roles: [role] };
  const container: Container = {
    ...base,
    auth: authGateway(session),
    // Même service de portée qu'en production (owner/admin → global, sinon liée, sans agent lié).
    operationalAccess: new OperationalAccessService({
      listAgentIdsForHuman: async () => new Set<string>(),
    } as never),
  };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  return container;
}

const PROC: Partial<Record<ProcPath, string>> = {
  "/proc/stat": "cpu  10 0 0 90 0 0 0 0 0 0\ncpu0 10 0 0 90 0 0 0 0 0 0\n",
  "/proc/meminfo": "MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n",
  "/proc/loadavg": "0.10 0.20 0.30 1/10 1\n",
  "/proc/uptime": "10.0 5.0\n",
  "/proc/net/dev": "h\nh\n  eth0: 1 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0\n",
};
const fakeSource: HostSource = {
  readProc: async (path) => PROC[path] ?? null,
  readCgroup: async () => null,
  containerMarker: async () => false,
  processUsage: () => ({ rssBytes: 1, heapUsedBytes: 1, cpuMicros: 0 }),
  diskUsage: async () => ({ total: 100, available: 50 }),
  linkSpeed: async () => null,
  hostname: () => "vps-test",
  now: () => Date.now(),
  sleep: async () => {},
};

function installInfra() {
  setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));
  const monitoringHealth = vi.fn(async () => ({
    ok: true as const,
    latencyMs: 12,
    snapshot: {
      status: "healthy" as const,
      partial: false,
      uptimeSeconds: 100,
      breakers: { open: 0, halfOpen: 0, degraded: 0, closed: 3, total: 3 },
      providers: { configured: 3, active: 3 },
      providerStates: { nvidia: { state: "CLOSED" as const, failures: 0 } },
    },
  }));
  setServiceProbesForTests(new ServiceProbes({ omniRoute: { monitoringHealth } }));
  return monitoringHealth;
}

const get = (authenticated = true) =>
  GET(new Request(URL_, { headers: authenticated ? { cookie: COOKIE } : undefined }));

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  setHostTelemetrySamplerForTests(null);
  setServiceProbesForTests(null);
  resetTelemetryRateLimiterForTests();
  vi.restoreAllMocks();
});

describe("GET /api/cockpit/live", () => {
  it("401 sans session, refus audité, aucune sonde émise", async () => {
    const container = install(null);
    const monitoringHealth = installInfra();
    const res = await get(false);
    expect(res.status).toBe(401);
    const entries = await container.audit.query({ eventType: "auth.access.denied" });
    expect(entries.at(-1)?.details).toMatchObject({
      route: "api.cockpit.live",
      reason: "missing_session",
    });
    expect(monitoringHealth).not.toHaveBeenCalled();
  });

  it("viewer (portée liée) : CORE3 lisible, sources tenant-wide forbidden, aucune sonde d'infrastructure", async () => {
    install("viewer");
    const monitoringHealth = installInfra();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = (await res.json()) as LiveOverview;
    expect(body.scope).toBe("linked");
    for (const key of ["workers", "omniroute", "memory", "vps"] as const) {
      expect(body.sources[key]).toMatchObject({
        state: "forbidden",
        data: null,
        errorCode: "FORBIDDEN_SCOPE",
      });
    }
    expect(body.sources.core3.data?.missions?.total).toBe(0);
    expect(body.schema).toBe(1);
    expect(monitoringHealth).not.toHaveBeenCalled();
  });

  it("owner (portée globale, backend mémoire) : registre réel, infra sondée, base durable absente dite telle quelle", async () => {
    const container = install("owner");
    installInfra();
    await container.workerRegistryStore.upsert(hermesWorker);
    await container.workerRegistryStore.upsert(openhandsWorker);

    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as LiveOverview;
    expect(body.scope).toBe("global");
    expect(body.sources.workers).toMatchObject({
      // Enregistrés mais jamais sondés : lus, non prouvés → degraded, pas « 2 workers vivants ».
      state: "degraded",
      errorCode: "STALE_WORKER_EVIDENCE",
      data: {
        registered: 2,
        routable: 0,
        staleActive: 2,
        byProbeOutcome: { never: 2 },
        activeAssignments: 0,
      },
      tenantId: "default",
    });
    // Passerelle sondée mais ledger sans base : la source n'est pas « LIVE », elle est dégradée.
    expect(body.sources.omniroute).toMatchObject({
      state: "degraded",
      errorCode: "LEDGER_UNAVAILABLE",
      data: { health: { state: "operational" }, spend: null, spendErrorCode: "NOT_CONNECTED" },
    });
    expect(body.sources.memory).toMatchObject({
      state: "unavailable",
      data: null,
      errorCode: "NOT_CONNECTED",
    });
    expect(body.sources.core3).toMatchObject({ state: "degraded", errorCode: "NOT_CONNECTED" });
    expect(body.sources.core3.data).toMatchObject({
      scheduler: null,
      schedulerErrorCode: "NOT_CONNECTED",
    });
    expect(body.sources.vps).toMatchObject({
      state: "ok",
      data: { hostname: "vps-test", cores: 1, vram: "NO_TELEMETRY" },
    });
    expect(Date.parse(body.sources.vps.observedAt ?? "")).not.toBeNaN();

    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(
      /postgres:\/\/|password|secret|bearer|api[_-]?key|session_token|DATABASE_URL|127\.0\.0\.1/i,
    );
    expect(raw).not.toMatch(/"amount24h":0\b/);
  });

  it("limite la fréquence par utilisateur (429 + Retry-After)", async () => {
    install("viewer");
    installInfra();
    const statuses: number[] = [];
    for (let i = 0; i < TELEMETRY_RATE_LIMIT.limit; i += 1) statuses.push((await get()).status);
    expect(statuses.every((s) => s === 200)).toBe(true);
    const refused = await get();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
  });

  it("un paramètre client ne change ni la portée ni le tenant", async () => {
    install("viewer");
    installInfra();
    const res = await GET(
      new Request(`${URL_}?tenantId=other&scope=global`, {
        headers: { cookie: COOKIE, "x-tenant-id": "other" },
      }),
    );
    const body = (await res.json()) as LiveOverview;
    expect(body.scope).toBe("linked");
    expect(body.sources.workers.state).toBe("forbidden");
    expect(body.sources.core3.tenantId).toBe("default");
  });
});
