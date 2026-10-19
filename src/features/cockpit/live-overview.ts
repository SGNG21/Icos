import type { ServiceHealth } from "@/core/telemetry";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

import { latestOf, observe, type Observed } from "./observed";
import type { MissionWithTasks } from "./snapshot";
import { isReal, missing, type Truth } from "./truth";

/**
 * VUE LIVE DES CINQ SOURCES (mission COCKPIT-LIVE, D1). Fonction PURE.
 *
 * Reçoit des FAITS déjà lus (chacun une `Truth`), les projette en `Observed`
 * avec la fraîcheur par source, et ne calcule rien qui ne soit une agrégation
 * de ce qui a été lu. Aucune valeur par défaut : une source illisible reste
 * `unavailable`, une portée refusée reste `forbidden`, un coût sans prix reste
 * `UNPRICED` (décisions 0066/0067/0078), une VRAM sans GPU reste `NO_TELEMETRY`.
 */

/** Seuils de fraîcheur documentés par source (voir rapport D0 §5). */
export const LIVE_MAX_AGE_MS = {
  /** Balayage du scheduler durable : `probe_workers` toutes les ~30 s → 4 manques. */
  core3: 120_000,
  /** Horizon de validité de la preuve de sonde d'un worker (M5.2). */
  workers: 120_000,
  /** Cache des sondes de services 15 s → 2 manques. */
  omniroute: 30_000,
  /** Journal durable append-only : l'âge de la dernière écriture n'est pas une panne. */
  memory: null,
  /** Échantillon /proc toutes les 10 s → 3 manques. */
  vps: 30_000,
} as const satisfies Record<string, number | null>;

export interface SchedulerFacts {
  /** Jobs `scheduled`/`running` par kind. */
  activeByKind: Record<string, number>;
  /** Jobs dont la lease est encore détenue (fencing en cours). */
  leased: number;
  dead: number;
  /** Dernière écriture du scheduler (max `updated_at`), null si table vide. */
  lastUpdatedAt: string | null;
}

export interface SpendFacts {
  calls24h: number;
  tokens24h: number;
  unpriced24h: number;
  amount24h: number | null;
  currency: string | null;
  /** Dernier appel enregistré (max `observed_at`), null si aucun. */
  lastObservedAt: string | null;
}

export interface MemoryFacts {
  records: number;
  active: number;
  retrievals24h: number;
  entities: number;
  relations: number;
  /** Dernière écriture (max `updated_at` des records), null si aucune. */
  lastWriteAt: string | null;
}

export interface VpsFacts {
  hostname: string | null;
  sampledAt: string;
  overall: "ok" | "degraded" | "incident";
  cores: number;
  cpuUsage: number | null;
  load1: number | null;
  memoryRatio: number | null;
  diskRatio: number | null;
  /** Toujours NO_TELEMETRY tant qu'aucun GPU ni télémétrie VRAM n'est présent. */
  vram: "NO_TELEMETRY";
}

export interface LiveOverviewInputs {
  now: Date;
  scope: "global" | "linked";
  tenantId?: string;
  missions: Truth<MissionWithTasks[]>;
  attempts: Truth<DispatchAttempt[]>;
  scheduler: Truth<SchedulerFacts>;
  workers: Truth<WorkerRegistryEntry[]>;
  activeAssignments: Truth<string[]>;
  spend: Truth<SpendFacts>;
  /** Santé des services sondés (postgres, omniroute, nemotron, temporal). */
  services: Truth<ServiceHealth[]>;
  memory: Truth<MemoryFacts>;
  vps: Truth<VpsFacts>;
}

export type PriceStatus = "PRICED" | "UNPRICED" | "UNKNOWN";

export interface Core3Summary {
  missions: { total: number; byStatus: Record<string, number> };
  tasks: { total: number; byStatus: Record<string, number> };
  /** Dispatches non terminaux des missions visibles. */
  attempts: { nonTerminal: number; byState: Record<string, number> };
  scheduler: SchedulerFacts | null;
  /** Explique pourquoi le scheduler manque quand `scheduler` est null. */
  schedulerErrorCode?: string;
}

export interface WorkersSummary {
  registered: number;
  active: number;
  routable: number;
  byProbeOutcome: Record<string, number>;
  byHealth: Record<string, number>;
  activeAssignments: number | null;
  lastProbeAt: string | null;
}

export interface OmniRouteSummary {
  health: Pick<ServiceHealth, "state" | "detail" | "checkedAt"> | null;
  nemotron: Pick<ServiceHealth, "state" | "detail"> | null;
  spend: (SpendFacts & { priceStatus: PriceStatus }) | null;
  spendErrorCode?: string;
}

export interface MemorySummary extends MemoryFacts {
  postgres: Pick<ServiceHealth, "state" | "detail" | "checkedAt"> | null;
}

export interface LiveIncident {
  source: keyof LiveOverview["sources"];
  code: string;
  detail: string;
}

export interface LiveOverview {
  generatedAt: string;
  scope: "global" | "linked";
  sources: {
    core3: Observed<Core3Summary>;
    workers: Observed<WorkersSummary>;
    omniroute: Observed<OmniRouteSummary>;
    memory: Observed<MemorySummary>;
    vps: Observed<VpsFacts>;
  };
  /** Incidents CONFIRMÉS par une mesure (rouge) ; jamais déduits d'une absence. */
  incidents: LiveIncident[];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export function priceStatusOf(spend: SpendFacts): PriceStatus {
  if (spend.calls24h === 0) return "UNKNOWN";
  if (spend.unpriced24h === 0 && spend.amount24h !== null) return "PRICED";
  return "UNPRICED";
}

const byKey = (services: readonly ServiceHealth[], key: string) =>
  services.find((s) => s.key === key) ?? null;

export function buildLiveOverview(input: LiveOverviewInputs): LiveOverview {
  const common = { collectedAt: input.now, tenantId: input.tenantId };

  // ── CORE3 : missions + tâches + dispatches + scheduler durable ────────────
  const core3Truth: Truth<Core3Summary> = isReal(input.missions)
    ? {
        kind: "real",
        value: {
          missions: {
            total: input.missions.value.length,
            byStatus: countBy(input.missions.value, (m) => m.mission.status),
          },
          tasks: {
            total: input.missions.value.reduce((n, m) => n + m.tasks.length, 0),
            byStatus: countBy(
              input.missions.value.flatMap((m) => m.tasks),
              (t) => t.status,
            ),
          },
          attempts: isReal(input.attempts)
            ? {
                nonTerminal: input.attempts.value.length,
                byState: countBy(input.attempts.value, (a) => a.state),
              }
            : { nonTerminal: 0, byState: {} },
          scheduler: isReal(input.scheduler) ? input.scheduler.value : null,
          ...(isReal(input.scheduler)
            ? {}
            : { schedulerErrorCode: input.scheduler.kind.toUpperCase() }),
        },
      }
    : input.missions;
  const core3 = observe({
    ...common,
    truth: core3Truth,
    maxAgeMs: LIVE_MAX_AGE_MS.core3,
    source:
      "missions, mission_tasks, dispatch_attempts, scheduled_jobs (PostgreSQL, lecture seule)",
    observedAt: (v) =>
      latestOf([
        v.scheduler?.lastUpdatedAt ?? null,
        ...(isReal(input.missions) ? input.missions.value.map((m) => m.mission.updatedAt) : []),
        ...(isReal(input.attempts) ? input.attempts.value.map((a) => a.updatedAt) : []),
      ]),
  });

  // ── Workers : registre durable + journal de dispatch ──────────────────────
  const workersTruth: Truth<WorkersSummary> = isReal(input.workers)
    ? {
        kind: "real",
        value: {
          registered: input.workers.value.length,
          active: input.workers.value.filter((w) => w.status === "active").length,
          routable: input.workers.value.filter(
            (w) =>
              w.status === "active" && w.health === "healthy" && w.availability === "available",
          ).length,
          byProbeOutcome: countBy(input.workers.value, (w) => w.lastProbeOutcome),
          byHealth: countBy(input.workers.value, (w) => w.health),
          activeAssignments: isReal(input.activeAssignments)
            ? input.activeAssignments.value.length
            : null,
          lastProbeAt: latestOf(input.workers.value.map((w) => w.lastProbeAt)),
        },
      }
    : input.workers;
  const workers = observe({
    ...common,
    truth: workersTruth,
    maxAgeMs: LIVE_MAX_AGE_MS.workers,
    source: "workers.last_probe_at (preuve de sonde) + dispatch_attempts non terminaux",
    observedAt: (v) => v.lastProbeAt,
  });

  // ── OmniRoute : santé native + ledger de dépense ──────────────────────────
  const services = isReal(input.services) ? input.services.value : null;
  const omniHealth = services ? byKey(services, "omniroute") : null;
  const omniTruth: Truth<OmniRouteSummary> =
    !isReal(input.services) && !isReal(input.spend)
      ? missing(input.services.kind, input.services.reason, input.services.requirement)
      : {
          kind: "real",
          value: {
            health: omniHealth
              ? {
                  state: omniHealth.state,
                  detail: omniHealth.detail,
                  checkedAt: omniHealth.checkedAt,
                }
              : null,
            nemotron: (() => {
              const n = services ? byKey(services, "nemotron") : null;
              return n ? { state: n.state, detail: n.detail } : null;
            })(),
            spend: isReal(input.spend)
              ? { ...input.spend.value, priceStatus: priceStatusOf(input.spend.value) }
              : null,
            ...(isReal(input.spend) ? {} : { spendErrorCode: input.spend.kind.toUpperCase() }),
          },
        };
  const omniroute = observe({
    ...common,
    truth: omniTruth,
    maxAgeMs: LIVE_MAX_AGE_MS.omniroute,
    source: "GET /api/monitoring/health d'OmniRoute (sans clé) + spend_ledger 24 h",
    observedAt: (v) => v.health?.checkedAt ?? null,
  });

  // ── PostgreSQL / mémoire durable ──────────────────────────────────────────
  const pg = services ? byKey(services, "postgres") : null;
  const memoryTruth: Truth<MemorySummary> = isReal(input.memory)
    ? {
        kind: "real",
        value: {
          ...input.memory.value,
          postgres: pg ? { state: pg.state, detail: pg.detail, checkedAt: pg.checkedAt } : null,
        },
      }
    : input.memory;
  const memory = observe({
    ...common,
    truth: memoryTruth,
    maxAgeMs: LIVE_MAX_AGE_MS.memory,
    source: "memory_records, memory_entities, memory_relations, memory_retrieval_log + SELECT 1",
    observedAt: (v) => v.lastWriteAt,
  });

  // ── VPS ───────────────────────────────────────────────────────────────────
  const vps = observe({
    ...common,
    truth: input.vps,
    maxAgeMs: LIVE_MAX_AGE_MS.vps,
    source: "/proc, /sys et statfs de l'hôte icos-web (lecture seule)",
    observedAt: (v) => v.sampledAt,
  });

  // ── Incidents confirmés ───────────────────────────────────────────────────
  const incidents: LiveIncident[] = [];
  if (vps.data?.overall === "incident")
    incidents.push({ source: "vps", code: "HOST_SATURATED", detail: "Saturation hôte mesurée." });
  if (omniHealth?.availability.state === "down")
    incidents.push({ source: "omniroute", code: "OMNIROUTE_DOWN", detail: omniHealth.detail });
  if (pg?.availability.state === "down")
    incidents.push({ source: "memory", code: "POSTGRES_DOWN", detail: pg.detail });
  const failedProbes = workers.data?.byProbeOutcome.failed ?? 0;
  if (failedProbes > 0)
    incidents.push({
      source: "workers",
      code: "WORKER_PROBE_FAILED",
      detail: `${failedProbes} worker(s) avec une sonde en échec datée.`,
    });
  if ((core3.data?.scheduler?.dead ?? 0) > 0)
    incidents.push({
      source: "core3",
      code: "SCHEDULER_DEAD_JOBS",
      detail: `${core3.data?.scheduler?.dead} job(s) du scheduler en état dead.`,
    });

  return {
    generatedAt: input.now.toISOString(),
    scope: input.scope,
    sources: { core3, workers, omniroute, memory, vps },
    incidents,
  };
}
