import { describe, expect, it, vi } from "vitest";

import { createOmniRouteMonitor, fetchOmniRouteMonitoring } from "./omniroute-monitoring";
import { parseOmniRouteMonitoring } from "./omniroute-monitoring";

/** Forme relevée sur l'instance OmniRoute du VPS (valeurs sensibles remplacées). */
const REAL_SHAPE = {
  status: "healthy",
  timestamp: "2026-10-17T10:00:00.000Z",
  system: { version: "3.8.49", nodeVersion: "v24", uptime: 3600, pid: 1, platform: "linux" },
  uptime: 7200.5,
  activeConnections: 0,
  circuitBreakers: { open: 0, halfOpen: 0, degraded: 2, closed: 5, total: 7 },
  providerHealth: {
    nvidia: { state: "CLOSED", failures: 0, lastFailure: null, retryAfterMs: 0 },
    "duckduckgo-web": {
      state: "DEGRADED",
      failures: 6,
      lastFailure: "upstream said: secret-ish text",
      retryAfterMs: 0,
    },
    "Bad Id!": { state: "CLOSED", failures: 0 },
  },
  providerSummary: { catalogCount: 299, configuredCount: 14, activeCount: 7, monitoredCount: 7 },
  credentialHealth: { anything: "never read" },
  sessions: [{ id: "never read" }],
};

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const config = { baseUrl: "http://omniroute.test/", defaultTimeoutMs: 1000, maxTimeoutMs: 1000 };

describe("parseOmniRouteMonitoring", () => {
  it("n'extrait que la liste blanche (jamais lastFailure, credentials ni sessions)", () => {
    const snapshot = parseOmniRouteMonitoring(REAL_SHAPE);
    expect(snapshot).toEqual({
      status: "healthy",
      partial: false,
      uptimeSeconds: 7200.5,
      breakers: { open: 0, halfOpen: 0, degraded: 2, closed: 5, total: 7 },
      providers: { configured: 14, active: 7 },
      providerStates: {
        nvidia: { state: "CLOSED", failures: 0 },
        "duckduckgo-web": { state: "DEGRADED", failures: 6 },
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|never read|lastFailure/);
  });

  it("signale le relevé partiel renvoyé par OmniRoute quand son auto-diagnostic échoue", () => {
    // Forme du repli d'OmniRoute 3.8.49 (toujours HTTP 200).
    const snapshot = parseOmniRouteMonitoring({
      status: "degraded",
      error: "Health check partially unavailable",
      providerHealth: {},
    });
    expect(snapshot).toMatchObject({ status: "degraded", partial: true, providerStates: {} });
  });

  it("normalise un état inconnu et rejette une forme hors contrat", () => {
    expect(parseOmniRouteMonitoring({ status: "weird" })?.status).toBe("unknown");
    expect(parseOmniRouteMonitoring("<html>")).toBeNull();
    expect(parseOmniRouteMonitoring({ nope: true })).toBeNull();
  });
});

describe("fetchOmniRouteMonitoring", () => {
  it("appelle la route native, sans clé ni corps, et parse la réponse", async () => {
    const fetchFn = vi.fn(async () => json(REAL_SHAPE));
    const result = await fetchOmniRouteMonitoring(
      config.baseUrl,
      1000,
      fetchFn as unknown as typeof fetch,
    );
    expect(result.ok).toBe(true);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://omniroute.test/api/monitoring/health");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|bearer|api[_-]?key/i);
  });

  it("le port composé réutilise le même client", async () => {
    const fetchFn = vi.fn(async () => json(REAL_SHAPE));
    const monitor = createOmniRouteMonitor(config.baseUrl, fetchFn as unknown as typeof fetch);
    expect((await monitor.monitoringHealth(1000)).ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("classe les échecs : HTTP, HTML (faux positif de /status), trop volumineux, injoignable, délai", async () => {
    const probe = (impl: () => Promise<Response>, timeoutMs = 1000) =>
      fetchOmniRouteMonitoring(config.baseUrl, timeoutMs, vi.fn(impl) as unknown as typeof fetch);

    expect(await probe(async () => new Response("x", { status: 503 }))).toMatchObject({
      ok: false,
      error: "http",
      httpStatus: 503,
    });
    expect(
      await probe(async () => new Response("<!doctype html><html></html>", { status: 200 })),
    ).toMatchObject({ ok: false, error: "invalid" });
    expect(await probe(async () => json("<!doctype html><html></html>"))).toMatchObject({
      ok: false,
      error: "invalid",
    });
    expect(await probe(async () => json("x".repeat(70 * 1024)))).toMatchObject({
      ok: false,
      error: "too_large",
    });
    expect(
      await probe(async () => {
        throw new TypeError("fetch failed");
      }),
    ).toMatchObject({ ok: false, error: "unreachable" });

    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("t", "TimeoutError"))),
      )) as unknown as typeof fetch;
    expect(await fetchOmniRouteMonitoring(config.baseUrl, 20, hanging)).toMatchObject({
      ok: false,
      error: "timeout",
    });
  });
});
