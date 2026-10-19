import {
  capacityOf,
  measured,
  unavailable,
  unwiredAiExtensions,
  type HostTelemetrySnapshot,
} from "@/core/telemetry";

const GiB = 1024 ** 3;

/**
 * Instantané de référence pour les tests du cockpit (valeurs relevées sur le
 * VPS le 2026-10-17). Jamais utilisé en exécution : l'interface ne lit que l'API.
 */
export function telemetryFixture(
  overrides: Partial<HostTelemetrySnapshot> = {},
): HostTelemetrySnapshot {
  return {
    schema: 1,
    hostname: measured("vps-test"),
    sampleIntervalSeconds: 10,
    current: {
      at: "2026-10-17T11:00:00.000Z",
      cpu: {
        cores: 8,
        usage: measured(0.14),
        perCore: measured([0.15, 0.12, 0.1, 0.31, 0.15, 0.12, 0.08, 0.04]),
        iowait: measured(0),
        load: measured({ one: 1.96, five: 2.3, fifteen: 2.3 }),
      },
      memory: measured(capacityOf(24 * GiB, 16 * GiB)),
      swap: measured(capacityOf(0, 0)),
      disks: [{ mount: "/", capacity: measured(capacityOf(290 * GiB, 227 * GiB)) }],
      network: {
        rxBytesPerSec: measured(1129),
        txBytesPerSec: measured(800),
        interfaces: [
          {
            name: "eth0",
            rxBytesPerSec: measured(1129),
            txBytesPerSec: measured(800),
            linkSpeedBitsPerSec: unavailable("Débit de lien non annoncé par le noyau (VM)."),
          },
        ],
      },
      uptimeSeconds: measured(90_000),
      pressure: { cpu: measured(0.16), memory: measured(0), io: measured(0.006) },
      processes: {
        runnable: measured(8),
        total: measured(1329),
        icos: measured({
          rssBytes: 300 * 1024 ** 2,
          heapUsedBytes: 120 * 1024 ** 2,
          cpuRatio: 0.01,
        }),
      },
      container: {
        inContainer: false,
        memoryLimitBytes: measured(null),
        memoryUsedBytes: measured(2 * GiB),
        cpuLimitCores: measured(null),
        differsFromHost: false,
      },
    },
    history: [
      {
        at: "2026-10-17T10:59:50.000Z",
        cpu: 0.12,
        memory: 0.33,
        swap: null,
        disk: 0.22,
        rxBytesPerSec: 1000,
        txBytesPerSec: 700,
      },
      {
        at: "2026-10-17T11:00:00.000Z",
        cpu: 0.14,
        memory: 0.33,
        swap: null,
        disk: 0.22,
        rxBytesPerSec: 1129,
        txBytesPerSec: 800,
      },
    ],
    overall: "degraded",
    signals: [
      { key: "cpu", tone: "ok", message: "CPU 14 %" },
      { key: "pressure", tone: "degraded", message: "Pression CPU 16 %" },
    ],
    recommendations: [],
    headroom: {
      idleVcpu: measured(6.88),
      memoryAvailableBytes: measured(16 * GiB),
    },
    services: [
      {
        key: "cockpit-api",
        label: "API Cockpit ICOS",
        state: "operational",
        detail: "OK",
        source: "ce processus Next.js",
        process: { state: "operational", detail: "Processus serveur ICOS en cours d'exécution." },
        availability: { state: "operational", detail: "OK" },
        mission: null,
        checkedAt: "2026-10-17T11:00:00.000Z",
      },
      {
        key: "postgres",
        label: "PostgreSQL",
        state: "operational",
        detail: "Requête exécutée.",
        source: "SELECT 1 sur le pool partagé du container (lecture seule)",
        process: null,
        availability: { state: "operational", detail: "Requête exécutée.", latencyMs: 3 },
        mission: {
          state: "operational",
          detail: "Authentification, rôles et audit servis par ce pool.",
        },
        checkedAt: "2026-10-17T11:00:00.000Z",
      },
      {
        key: "core3",
        label: "CORE3",
        state: "not_instrumented",
        detail: "Aucune sonde.",
        source: "aucune sonde disponible sur main",
        process: { state: "not_instrumented", detail: "Aucune sonde." },
        availability: { state: "not_instrumented", detail: "Aucune sonde." },
        mission: { state: "not_instrumented", detail: "Aucune sonde." },
      },
    ],
    workers: {
      activeJobs: measured(0),
      jobSlots: measured(100),
      perWorkerFootprint: unavailable("Empreinte CPU/RAM d'un worker jamais mesurée."),
      additionalWorkers: unavailable(
        "Consommation CPU/RAM réelle d'un worker non mesurée : aucune estimation publiée.",
      ),
    },
    extensions: unwiredAiExtensions(),
    ...overrides,
  };
}
