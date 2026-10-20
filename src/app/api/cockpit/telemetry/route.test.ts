import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import type { ServiceHealth } from "@/core/telemetry";
import { OperationalAccessService } from "@/server/administration/operational-access-service";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { hermesWorker, openhandsWorker } from "@/server/services/worker-registry/fixtures";
import type { OmniRouteMonitoringResult } from "@/server/telemetry/omniroute-monitoring";
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

import { telemetrySnapshotSchema } from "@/server/telemetry/telemetry-contract";

import { GET } from "./route";

const CONTAINER_KEY = "__icosContainerPromise__";
const URL_ = "http://localhost/api/cockpit/telemetry";
const SESSION_COOKIE = "icos.session_token=opaque-test-value";

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

function installSession(role: Role | null): Container {
  const base = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
  const session: AuthenticatedSession | null =
    role === null
      ? null
      : {
          user: { id: "trusted-human", email: "human@icos.test", name: "Human", status: "active" },
          roles: [role],
        };
  const container: Container = {
    ...base,
    auth: authGateway(session),
    // Même service de portée qu'en production : owner/admin → globale, sinon liée.
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
  now: () => 0,
  sleep: async () => {},
};

function request(authenticated = true): Request {
  return new Request(URL_, { headers: authenticated ? { cookie: SESSION_COOKIE } : undefined });
}

/** Sondes sans réseau : PostgreSQL absent (backend mémoire), OmniRoute injoignable. */
function installProbes() {
  const monitoringHealth = vi.fn(async () => ({
    ok: false as const,
    latencyMs: 1,
    error: "unreachable" as const,
  }));
  setServiceProbesForTests(new ServiceProbes({ omniRoute: { monitoringHealth } }));
  return monitoringHealth;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CONTAINER_KEY];
  setHostTelemetrySamplerForTests(null);
  setServiceProbesForTests(null);
  resetTelemetryRateLimiterForTests();
});

describe("GET /api/cockpit/telemetry", () => {
  it("refuse sans session et audite le refus", async () => {
    const container = installSession(null);
    setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));

    const response = await GET(request(false));
    expect(response.status).toBe(401);
    const entries = await container.audit.query({ eventType: "auth.access.denied" });
    expect(entries.at(-1)?.details).toMatchObject({
      route: "api.cockpit.telemetry",
      role: "operator",
      reason: "missing_session",
    });
  });

  it("refuse un simple lecteur du cockpit et audite le refus", async () => {
    const container = installSession("viewer");
    setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));

    const response = await GET(request());
    expect(response.status).toBe(403);
    const entries = await container.audit.query({ eventType: "auth.access.denied" });
    expect(entries.at(-1)?.details).toMatchObject({
      route: "api.cockpit.telemetry",
      role: "operator",
      reason: "forbidden",
    });
  });

  it("refuse un opérateur en portée liée (403 audité) : l'infrastructure exige la portée owner/admin", async () => {
    const container = installSession("operator");
    installProbes();
    setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden");
    const entries = await container.audit.query({ eventType: "auth.access.denied" });
    expect(entries.at(-1)?.details).toMatchObject({
      route: "api.cockpit.telemetry",
      role: "operator",
      reason: "forbidden",
    });
  });

  it("sert un instantané à un owner (portée globale), sans cache et sans secret", async () => {
    installSession("owner");
    installProbes();
    setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));

    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as { telemetry: Record<string, unknown> };
    expect(body.telemetry).toMatchObject({
      schema: 1,
      sampleIntervalSeconds: 10,
      overall: "ok",
      current: { cpu: { cores: 1 }, memory: { available: true, value: { ratio: 0.5 } } },
      extensions: { concurrentWorkers: { available: false } },
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(
      /\.slice|\.scope|sys\/fs|cookie|password|secret|bearer|api[_-]?key|session_token|DATABASE_URL/i,
    );
    expect(telemetrySnapshotSchema.safeParse(body.telemetry).success).toBe(true);
  });

  it("joint la santé des services en trois couches et le compteur workers du registre durable", async () => {
    const container = installSession("owner");
    setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));
    installProbes();
    // Deux workers enregistrés (jamais sondés), 1 + 1 emplacement, aucun dispatch en cours.
    await container.workerRegistryStore.upsert(hermesWorker);
    await container.workerRegistryStore.upsert(openhandsWorker);

    const body = (await (await GET(request())).json()) as {
      telemetry: {
        services: {
          key: string;
          state: string;
          process: unknown;
          availability: { state: string };
        }[];
        workers: Record<string, { available: boolean }>;
      };
    };
    const states = Object.fromEntries(body.telemetry.services.map((s) => [s.key, s.state]));
    expect(states).toEqual({
      "cockpit-api": "operational",
      // La source factice renvoie deux fois les mêmes compteurs CPU : delta
      // indisponible, le collecteur se déclare donc honnêtement dégradé.
      telemetry: "degraded",
      postgres: "not_instrumented", // backend mémoire : aucun pool à sonder
      omniroute: "down",
      temporal: "not_instrumented",
      nemotron: "not_instrumented",
    });
    expect(body.telemetry.workers).toMatchObject({
      activeJobs: { available: true, value: 0 },
      jobSlots: { available: true, value: 2 },
      perWorkerFootprint: { available: false },
      additionalWorkers: { available: false },
    });
    expect(telemetrySnapshotSchema.safeParse(body.telemetry).success).toBe(true);
  });

  it("limite la fréquence par utilisateur (429 + Retry-After) sans sonder au-delà", async () => {
    installSession("owner");
    setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));
    const monitoringHealth = installProbes();

    const statuses: number[] = [];
    for (let i = 0; i < TELEMETRY_RATE_LIMIT.limit; i += 1) {
      statuses.push((await GET(request())).status);
    }
    expect(statuses.every((s) => s === 200)).toBe(true);
    const refused = await GET(request());
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("rate_limited");
    // Cache de 15 s : 61 requêtes → une seule sonde OmniRoute.
    expect(monitoringHealth).toHaveBeenCalledTimes(1);
  });

  it("le sondage à 10 s de plusieurs onglets n'est jamais bridé ni bloqué, OmniRoute muet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
      installSession("owner");
      setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));
      // OmniRoute qui ne répond pas : l'adaptateur abandonne à son délai.
      const monitoringHealth = vi.fn(
        (timeoutMs: number) =>
          new Promise<OmniRouteMonitoringResult>((resolve) =>
            setTimeout(
              () => resolve({ ok: false, latencyMs: timeoutMs, error: "timeout" }),
              timeoutMs,
            ),
          ),
      );
      setServiceProbesForTests(
        new ServiceProbes({ omniRoute: { monitoringHealth }, omniRouteTimeoutMs: 5 }),
      );
      const statuses = new Set<number>();
      let slowest = 0;
      // 10 minutes, 8 onglets du même opérateur, une lecture toutes les 10 s
      // + une reprise immédiate par minute (retour d'onglet).
      for (let tick = 0; tick < 60; tick += 1) {
        const tabs = tick % 6 === 0 ? 9 : 8;
        for (let tab = 0; tab < tabs; tab += 1) {
          const started = performance.now();
          const response = await GET(request());
          slowest = Math.max(slowest, performance.now() - started);
          statuses.add(response.status);
          if (response.status === 200) {
            const body = (await response.json()) as { telemetry: { services: ServiceHealth[] } };
            const omni = body.telemetry.services.find((service) => service.key === "omniroute");
            expect(omni?.availability.state).toBe("down");
          }
        }
        vi.setSystemTime(Date.now() + 10_000);
      }
      expect([...statuses]).toEqual([200]);
      expect(slowest).toBeLessThan(2_000);
      // Cache de 15 s : au plus une sonde toutes les deux lectures de 10 s.
      expect(monitoringHealth.mock.calls.length).toBeLessThanOrEqual(31);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aperçu sans adresse OmniRoute : « Environnement non connecté », aucune sonde par défaut", async () => {
    vi.stubEnv("OMNIROUTE_BASE_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      installSession("owner");
      setHostTelemetrySamplerForTests(new HostTelemetrySampler({ source: fakeSource }));
      const response = await GET(request());
      expect(response.status).toBe(200);
      const body = (await response.json()) as { telemetry: { services: ServiceHealth[] } };
      const byKey = Object.fromEntries(body.telemetry.services.map((x) => [x.key, x]));
      expect(byKey.omniroute?.state).toBe("not_connected");
      expect(byKey.nemotron?.state).toBe("not_connected");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
