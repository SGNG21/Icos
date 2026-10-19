import { describe, expect, it, vi } from "vitest";

import { capacityOf, measured, unavailable, type ServiceHealth } from "@/core/telemetry";
import type { DatabasePing } from "@/server/database/health";

import type { OmniRouteMonitoringResult } from "./omniroute-monitoring";
import {
  isOmniRouteConfigured,
  ServiceProbes,
  workerCapacity,
  type FleetFacts,
} from "./service-probes";

const healthyOmni: OmniRouteMonitoringResult = {
  ok: true,
  latencyMs: 20,
  snapshot: {
    status: "healthy",
    partial: false,
    uptimeSeconds: 7200,
    breakers: { open: 0, halfOpen: 0, degraded: 0, closed: 7, total: 7 },
    providers: { configured: 14, active: 7 },
    providerStates: {
      nvidia: { state: "CLOSED", failures: 0 },
      claude: { state: "CLOSED", failures: 0 },
    },
  },
};

const fleetOk: FleetFacts = {
  workers: [
    { status: "active", maxConcurrency: 2 },
    { status: "active", maxConcurrency: 1 },
    { status: "inactive", maxConcurrency: 4 },
  ],
  activeAssignments: ["w-1", "w-1"],
};

function probes(options: {
  db?: DatabasePing | "hang" | null;
  omni?: OmniRouteMonitoringResult | "hang" | null;
  now?: () => number;
  connected?: boolean;
}) {
  const ping = vi.fn(async () =>
    options.db === "hang" ? new Promise<DatabasePing>(() => {}) : (options.db as DatabasePing),
  );
  const monitoringHealth = vi.fn(async () =>
    options.omni === "hang"
      ? new Promise<OmniRouteMonitoringResult>(() => {})
      : (options.omni as OmniRouteMonitoringResult),
  );
  const instance = new ServiceProbes({
    database: options.db === null ? undefined : { ping },
    omniRoute: options.omni === null ? undefined : { monitoringHealth },
    omniRouteConnected: options.connected,
    now: options.now,
    databaseTimeoutMs: 20,
    omniRouteTimeoutMs: 20,
  });
  return { instance, ping, monitoringHealth };
}

const byKey = (services: ServiceHealth[]) =>
  Object.fromEntries(services.map((s) => [s.key, s])) as Record<string, ServiceHealth>;

describe("ServiceProbes", () => {
  it("sépare processus, disponibilité et capacité mission quand tout répond", async () => {
    const { instance } = probes({
      db: { ok: true, latencyMs: 3 },
      omni: healthyOmni,
    });
    const s = byKey((await instance.collect()).services);

    expect(s.postgres).toMatchObject({
      state: "operational",
      process: null,
      availability: { state: "operational", latencyMs: 3 },
      mission: { state: "operational" },
    });
    expect(s.omniroute).toMatchObject({
      state: "operational",
      process: { state: "operational" },
      mission: { state: "operational" },
    });
    expect(s.omniroute.mission?.detail).toContain("aucune inférence");
    expect(s.nemotron).toMatchObject({
      availability: { state: "operational" },
      mission: { state: "not_instrumented" },
    });
    expect(s.temporal).toMatchObject({
      state: "not_instrumented",
      process: { state: "not_instrumented" },
      availability: { state: "not_instrumented" },
      mission: { state: "not_instrumented" },
    });
    expect(Object.keys(s).sort()).toEqual(["nemotron", "omniroute", "postgres", "temporal"]);
  });

  it("n'affiche jamais « Opérationnel » sans sonde", async () => {
    const { instance } = probes({ db: null, omni: null });
    const s = byKey((await instance.collect()).services);
    for (const key of ["postgres", "nemotron", "temporal"]) {
      expect(s[key].state).toBe("not_instrumented");
    }
  });

  it("borne chaque sonde : un service qui ne répond pas devient « down » avec une erreur explicite", async () => {
    const { instance } = probes({ db: "hang", omni: "hang" });
    const started = Date.now();
    const s = byKey((await instance.collect()).services);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(s.postgres.availability).toMatchObject({
      state: "down",
      detail: expect.stringContaining("Pas de réponse"),
    });
    expect(s.omniroute).toMatchObject({
      process: { state: "down" },
      availability: { state: "down" },
    });
    expect(s.nemotron.state).toBe("not_instrumented");
  });

  it("met en cache 15 s et partage la sonde en vol entre clients simultanés", async () => {
    let now = 0;
    const { instance, ping, monitoringHealth } = probes({
      db: { ok: true, latencyMs: 1 },
      omni: healthyOmni,
      now: () => now,
    });
    await Promise.all([instance.collect(), instance.collect(), instance.collect()]);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(monitoringHealth).toHaveBeenCalledTimes(1);
    now = 14_999;
    await instance.collect();
    expect(ping).toHaveBeenCalledTimes(1);
    now = 15_000;
    await instance.collect();
    expect(ping).toHaveBeenCalledTimes(2);
    expect(monitoringHealth).toHaveBeenCalledTimes(2);
  });

  it("dégrade sur latence ou disjoncteurs ouverts", async () => {
    const troubled: OmniRouteMonitoringResult = {
      ...healthyOmni,
      snapshot: {
        ...(healthyOmni as Extract<OmniRouteMonitoringResult, { ok: true }>).snapshot,
        breakers: { open: 1, halfOpen: 0, degraded: 0, closed: 6, total: 7 },
        providerStates: { nvidia: { state: "OPEN", failures: 9 } },
      },
    };
    const { instance } = probes({
      db: { ok: true, latencyMs: 900 },
      omni: troubled,
    });
    const s = byKey((await instance.collect()).services);
    expect(s.postgres.availability.state).toBe("degraded");
    expect(s.omniroute.availability.state).toBe("degraded");
    expect(s.omniroute.mission?.state).toBe("down"); // aucun fournisseur au disjoncteur fermé
    expect(s.nemotron.availability).toMatchObject({
      state: "down",
      detail: "Disjoncteur OPEN, 9 échec(s) récent(s).",
    });
  });

  it("ne relaie aucune information de connexion", async () => {
    const { instance } = probes({
      db: { ok: false, latencyMs: 5, error: "error" },
      omni: { ok: false, latencyMs: 3, error: "unreachable" },
    });
    const raw = JSON.stringify(await instance.collect());
    expect(raw).not.toMatch(/127\.0\.0\.1|localhost|:\d{4,5}|postgres:\/\/|password|api[_-]?key/i);
  });
});

describe("ServiceProbes — OmniRoute, cas par cas", () => {
  const omni = async (options: Parameters<typeof probes>[0]) => {
    const built = probes({ db: null, ...options });
    return { ...built, s: byKey((await built.instance.collect()).services) };
  };

  it("sain : trois couches opérationnelles, runtime prêt", async () => {
    const { s } = await omni({ omni: healthyOmni });
    expect(s.omniroute).toMatchObject({
      state: "operational",
      process: { state: "operational" },
      availability: { state: "operational" },
      mission: { state: "operational" },
    });
  });

  it("« healthy » seul ne suffit pas : relevé partiel ou aucun fournisseur actif → dégradé", async () => {
    const base = (healthyOmni as Extract<OmniRouteMonitoringResult, { ok: true }>).snapshot;
    for (const snapshot of [
      { ...base, partial: true },
      { ...base, providers: { configured: 3, active: 0 } },
    ]) {
      const { s } = await omni({ omni: { ok: true, latencyMs: 5, snapshot } });
      expect(s.omniroute.availability.state).toBe("degraded");
    }
  });

  it("indisponible : aucun processus ne répond", async () => {
    const { s } = await omni({ omni: { ok: false, latencyMs: 2, error: "unreachable" } });
    expect(s.omniroute).toMatchObject({
      state: "down",
      process: { state: "down", detail: expect.stringContaining("Aucun processus") },
      mission: { state: "down" },
    });
  });

  it("timeout : délai borné, erreur explicite", async () => {
    const { s } = await omni({ omni: { ok: false, latencyMs: 2500, error: "timeout" } });
    expect(s.omniroute.availability).toMatchObject({
      state: "down",
      detail: "Pas de réponse dans le délai imparti.",
    });
  });

  it("réponse invalide : le processus répond mais le service n'est pas prouvé", async () => {
    const { s } = await omni({ omni: { ok: false, latencyMs: 4, error: "invalid" } });
    expect(s.omniroute).toMatchObject({
      process: { state: "operational" },
      availability: { state: "down", detail: "Réponse de monitoring non conforme." },
      mission: { state: "down" },
    });
    const unknown = await omni({
      omni: {
        ok: true,
        latencyMs: 4,
        snapshot: {
          ...(healthyOmni as Extract<OmniRouteMonitoringResult, { ok: true }>).snapshot,
          status: "unknown",
        },
      },
    });
    expect(unknown.s.omniroute.availability.state).toBe("down");
    expect(unknown.s.omniroute.mission?.state).toBe("down");
  });

  it("mauvaise configuration : adaptateur non composé → indisponible, sans sonde", async () => {
    const { s, monitoringHealth } = await omni({ omni: null });
    expect(monitoringHealth).not.toHaveBeenCalled();
    expect(s.omniroute).toMatchObject({
      state: "down",
      detail: expect.stringContaining("Configuration OmniRoute invalide"),
    });
  });

  it("environnement non connecté : aucun appel réseau, distinct de « Indisponible » et « Non instrumenté »", async () => {
    const { s, monitoringHealth } = await omni({ omni: healthyOmni, connected: false });
    expect(monitoringHealth).not.toHaveBeenCalled();
    for (const key of ["omniroute", "nemotron"]) {
      expect(s[key]).toMatchObject({
        state: "not_connected",
        process: { state: "not_connected" },
        availability: { state: "not_connected" },
        mission: { state: "not_connected" },
      });
    }
    expect(s.omniroute.detail).toContain("OMNIROUTE_BASE_URL");
  });

  it("seule une adresse explicitement configurée relie l'environnement", () => {
    expect(isOmniRouteConfigured({})).toBe(false);
    expect(isOmniRouteConfigured({ OMNIROUTE_BASE_URL: "  " })).toBe(false);
    expect(isOmniRouteConfigured({ OMNIROUTE_BASE_URL: "http://127.0.0.1:1" })).toBe(true);
  });
});

describe("workerCapacity", () => {
  const headroom = { idleVcpu: measured(6), memoryAvailableBytes: measured(16 * 1024 ** 3) };

  it("compte depuis le registre durable : emplacements des workers actifs, dispatches en cours", () => {
    const w = workerCapacity(headroom, fleetOk);
    expect(w.activeJobs).toEqual(measured(2));
    // 2 + 1 ; le worker inactif ne compte pas.
    expect(w.jobSlots).toEqual(measured(3));
    expect(w.perWorkerFootprint.available).toBe(false);
    expect(w.additionalWorkers).toMatchObject({
      available: false,
      reason: expect.stringContaining("non mesurée"),
    });
  });

  it("sans registre lisible : indisponible, jamais zéro", () => {
    const w = workerCapacity(headroom, null);
    expect(w.activeJobs.available).toBe(false);
    expect(w.jobSlots.available).toBe(false);
  });

  it("calcule seulement avec une empreinte mesurée sur assez d'exécutions", () => {
    expect(
      workerCapacity(
        headroom,
        fleetOk,
        measured({ cpuVcpu: 1.5, memoryBytes: 2 * 1024 ** 3, samples: 2 }),
      ).additionalWorkers.available,
    ).toBe(false);
    // min(6 / 1,5 = 4 ; 16 Gio / 2 Gio = 8) = 4
    expect(
      workerCapacity(
        headroom,
        fleetOk,
        measured({ cpuVcpu: 1.5, memoryBytes: 2 * 1024 ** 3, samples: 5 }),
      ).additionalWorkers,
    ).toEqual(measured(4));
    expect(
      workerCapacity(
        { ...headroom, idleVcpu: unavailable("x") },
        null,
        measured({ cpuVcpu: 1, memoryBytes: 1, samples: 9 }),
      ).additionalWorkers.available,
    ).toBe(false);
    void capacityOf;
  });
});
