import type { ServiceHealth } from "@/core/telemetry";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";

import { FUTURE_TOLERANCE_MS, isScopeRefused, latestOf, observe, type Observed } from "./observed";
import type { MissionWithTasks } from "./snapshot";
import { isReal, missing, type Truth } from "./truth";

/**
 * VUE LIVE DES CINQ SOURCES (mission COCKPIT-LIVE, D1). Fonction PURE.
 *
 * Reçoit des FAITS déjà lus (chacun une `Truth`), les projette en `Observed`
 * avec la fraîcheur par source, et ne calcule rien qui ne soit une agrégation
 * de ce qui a été lu. Aucune valeur par défaut : une source illisible reste
 * `unavailable`, une portée refusée reste `forbidden`, une sous-source illisible
 * rend la source `degraded` avec son code (jamais un zéro), un coût sans prix reste
 * `UNPRICED` (décisions 0066/0067/0078), une VRAM sans GPU reste `NO_TELEMETRY`.
 */

export const LIVE_SCHEMA = 1 as const;

/** Seuils de fraîcheur documentés par source (voir rapport D0 §5). */
export const LIVE_MAX_AGE_MS = {
  /** Balayage du scheduler durable : `probe_workers` toutes les ~30 s → 4 manques. */
  core3: 120_000,
  /** Horizon de validité de la preuve de sonde d'un worker (M5.2). */
  workers: 120_000,
  /**
   * Sondes de services : `observedAt` est l'heure d'ACQUISITION par ICOS (cache 15 s),
   * pas un horodatage émis par OmniRoute — frais par construction tant que la sonde tourne.
   */
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
  /** Jobs `dead` depuis toujours (historique). */
  dead: number;
  /** Jobs passés `dead` dans les dernières 24 h (seul compteur traité en incident). */
  dead24h: number;
  /** Dernière écriture du scheduler (max `updated_at`), null si table vide. */
  lastUpdatedAt: string | null;
}

/**
 * Faits de dépense sur 24 h, lus par `cost_kind` et devise (décisions 0067/0078) :
 * `COST` chiffré, `FREE_TIER` gratuité vérifiée, `UNPRICED` prix inconnu, `UNMETERED`
 * tokens inconnus. Le montant n'existe que si tout appel métré est `COST` en devise unique.
 */
export interface SpendFacts {
  calls24h: number;
  metered24h: number;
  unmetered24h: number;
  priced24h: number;
  freeTier24h: number;
  unpriced24h: number;
  /** Somme des tokens connus ; partielle si `tokensUnknown24h > 0`. */
  tokens24h: number;
  /** Appels sans total de tokens (NULL = inconnu, jamais 0 ; par schéma, les appels UNMETERED). */
  tokensUnknown24h: number;
  amount24h: number | null;
  currency: string | null;
  /** Devises distinctes parmi les appels chiffrés ou gratuits. */
  currencies: number;
  /** Dernier appel enregistré (max `observed_at`), null si aucun. */
  lastObservedAt: string | null;
  /** Tenant sous lequel le ledger est écrit (constante du writer), tel que filtré. */
  ledgerTenantId: string;
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
  /** null quand /proc/stat est illisible : jamais 0 vCPU. */
  cores: number | null;
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

/**
 * Statut de prix de la fenêtre. Un seul mot de prix inconnu, `UNPRICED` (décision 0067) ;
 * `FREE_TIER` est une gratuité vérifiée (0078) ; `MIXED_CURRENCY` et `NO_TRAFFIC` décrivent
 * la fenêtre, pas un prix.
 */
export type PriceStatus = "PRICED" | "FREE_TIER" | "UNPRICED" | "MIXED_CURRENCY" | "NO_TRAFFIC";

export interface Core3Summary {
  missions: { total: number; byStatus: Record<string, number> } | null;
  tasks: { total: number; byStatus: Record<string, number> } | null;
  missionsErrorCode?: string;
  /** Dispatches non terminaux des missions visibles ; null = illisibles (jamais 0). */
  attempts: { nonTerminal: number; byState: Record<string, number> } | null;
  attemptsErrorCode?: string;
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
  /** Workers actifs dont la preuve de sonde est absente ou plus vieille que l'horizon. */
  staleActive: number;
  /** Workers actifs dont la DERNIÈRE sonde, datée dans l'horizon, a échoué. */
  recentFailed: number;
  activeAssignments: number | null;
  activeAssignmentsErrorCode?: string;
  /** Sonde la plus récente de la flotte : vivacité du balayage, pas preuve de chaque worker. */
  lastProbeAt: string | null;
}

export interface OmniRouteSummary {
  health: Pick<ServiceHealth, "state" | "detail" | "checkedAt"> | null;
  healthErrorCode?: string;
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
  schema: typeof LIVE_SCHEMA;
  generatedAt: string;
  scope: "global" | "linked";
  sources: {
    core3: Observed<Core3Summary>;
    workers: Observed<WorkersSummary>;
    omniroute: Observed<OmniRouteSummary>;
    memory: Observed<MemorySummary>;
    vps: Observed<VpsFacts>;
  };
  /** Services sondés (postgres, omniroute, nemotron, temporal) en trois couches. */
  services: Observed<ServiceHealth[]>;
  /** Incidents CONFIRMÉS par une mesure fraîche (rouge) ; jamais déduits d'une absence. */
  incidents: LiveIncident[];
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return out;
}

export function priceStatusOf(spend: SpendFacts): PriceStatus {
  if (spend.calls24h === 0) return "NO_TRAFFIC";
  /* Un appel UNMETERED a un coût inconnu (cost_kind NULL par schéma) : la fenêtre n'est pas chiffrée. */
  if (
    spend.unpriced24h > 0 ||
    spend.unmetered24h > 0 ||
    (spend.priced24h === 0 && spend.freeTier24h === 0)
  )
    return "UNPRICED";
  if (spend.currencies > 1) return "MIXED_CURRENCY";
  if (spend.priced24h > 0) return "PRICED";
  return "FREE_TIER";
}

/**
 * Code de la sous-source manquante par ÉCHEC (lecture impossible, non composée). Un refus de
 * portée n'est pas un échec : la source parente reste `ok` sans cette sous-source.
 */
function failureCode(truth: Truth<unknown>): string | null {
  if (isReal(truth) || isScopeRefused(truth)) return null;
  return truth.kind === "not_connected" ? "NOT_CONNECTED" : "READ_FAILED";
}

const subCode = (truth: Truth<unknown>): string | undefined =>
  isReal(truth)
    ? undefined
    : isScopeRefused(truth)
      ? "FORBIDDEN_SCOPE"
      : (failureCode(truth) ?? undefined);

const byKey = (services: readonly ServiceHealth[], key: string) =>
  services.find((s) => s.key === key) ?? null;

const ageMs = (now: Date, iso: string | null): number | null =>
  iso === null ? null : now.getTime() - Date.parse(iso);

export function buildLiveOverview(input: LiveOverviewInputs): LiveOverview {
  const common = { collectedAt: input.now, tenantId: input.tenantId };

  // ── CORE3 : missions + tâches + dispatches + scheduler durable ────────────
  const core3Truth: Truth<Core3Summary> =
    !isReal(input.missions) && !isReal(input.scheduler)
      ? isScopeRefused(input.missions)
        ? input.missions
        : missing(input.missions.kind, input.missions.reason, input.missions.requirement)
      : {
          kind: "real",
          value: {
            missions: isReal(input.missions)
              ? {
                  total: input.missions.value.length,
                  byStatus: countBy(input.missions.value, (m) => m.mission.status),
                }
              : null,
            tasks: isReal(input.missions)
              ? {
                  total: input.missions.value.reduce((n, m) => n + m.tasks.length, 0),
                  byStatus: countBy(
                    input.missions.value.flatMap((m) => m.tasks),
                    (t) => t.status,
                  ),
                }
              : null,
            ...(isReal(input.missions) ? {} : { missionsErrorCode: subCode(input.missions) }),
            attempts: isReal(input.attempts)
              ? {
                  nonTerminal: input.attempts.value.length,
                  byState: countBy(input.attempts.value, (a) => a.state),
                }
              : null,
            ...(isReal(input.attempts) ? {} : { attemptsErrorCode: subCode(input.attempts) }),
            scheduler: isReal(input.scheduler) ? input.scheduler.value : null,
            ...(isReal(input.scheduler) ? {} : { schedulerErrorCode: subCode(input.scheduler) }),
          },
        };
  const core3 = observe({
    ...common,
    truth: core3Truth,
    maxAgeMs: LIVE_MAX_AGE_MS.core3,
    source:
      "missions, mission_tasks, dispatch_attempts, scheduled_jobs (PostgreSQL, lecture seule)",
    degradedCode:
      failureCode(input.missions) ?? failureCode(input.attempts) ?? failureCode(input.scheduler),
    observedAt: (v) =>
      latestOf([
        v.scheduler?.lastUpdatedAt ?? null,
        ...(isReal(input.missions) ? input.missions.value.map((m) => m.mission.updatedAt) : []),
        ...(isReal(input.attempts) ? input.attempts.value.map((a) => a.updatedAt) : []),
      ]),
    empty: (v) =>
      (v.missions?.total ?? 0) === 0 &&
      (v.scheduler === null ||
        Object.keys(v.scheduler.activeByKind).length + v.scheduler.dead === 0),
  });

  // ── Workers : registre durable + journal de dispatch ──────────────────────
  const horizon = LIVE_MAX_AGE_MS.workers;
  const workersTruth: Truth<WorkersSummary> = isReal(input.workers)
    ? {
        kind: "real",
        value: (() => {
          const all = input.workers.value;
          const active = all.filter((w) => w.status === "active");
          /* Dans l'horizon ET pas dans le futur : une horloge en avance n'est pas une preuve. */
          const within = (w: WorkerRegistryEntry) => {
            const age = ageMs(input.now, w.lastProbeAt);
            return age !== null && age <= horizon && age >= -FUTURE_TOLERANCE_MS;
          };
          return {
            registered: all.length,
            active: active.length,
            routable: active.filter((w) => w.health === "healthy" && w.availability === "available")
              .length,
            byProbeOutcome: countBy(all, (w) => w.lastProbeOutcome),
            byHealth: countBy(all, (w) => w.health),
            staleActive: active.filter((w) => !within(w)).length,
            recentFailed: active.filter((w) => w.lastProbeOutcome === "failed" && within(w)).length,
            activeAssignments: isReal(input.activeAssignments)
              ? input.activeAssignments.value.length
              : null,
            ...(isReal(input.activeAssignments)
              ? {}
              : { activeAssignmentsErrorCode: subCode(input.activeAssignments) }),
            lastProbeAt: latestOf(all.map((w) => w.lastProbeAt)),
          };
        })(),
      }
    : input.workers;
  const workers = observe({
    ...common,
    truth: workersTruth,
    maxAgeMs: horizon,
    source: "workers.last_probe_at (preuve de sonde) + dispatch_attempts non terminaux",
    degradedCode:
      failureCode(input.activeAssignments) ??
      (isReal(workersTruth) && workersTruth.value.staleActive > 0 ? "STALE_WORKER_EVIDENCE" : null),
    observedAt: (v) => v.lastProbeAt,
    empty: (v) => v.registered === 0,
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
            ...(omniHealth
              ? {}
              : {
                  healthErrorCode: isReal(input.services)
                    ? "PROBE_MISSING"
                    : subCode(input.services),
                }),
            nemotron: (() => {
              const n = services ? byKey(services, "nemotron") : null;
              return n ? { state: n.state, detail: n.detail } : null;
            })(),
            spend: isReal(input.spend)
              ? { ...input.spend.value, priceStatus: priceStatusOf(input.spend.value) }
              : null,
            ...(isReal(input.spend) ? {} : { spendErrorCode: subCode(input.spend) }),
          },
        };
  /* Pas d'estampille tenant de surface : le ledger est écrit sous son propre tenant (`spend.ledgerTenantId`). */
  const omniroute = observe({
    collectedAt: input.now,
    truth: omniTruth,
    maxAgeMs: LIVE_MAX_AGE_MS.omniroute,
    source:
      "GET /api/monitoring/health d'OmniRoute (sans clé, heure d'acquisition) + spend_ledger 24 h",
    degradedCode:
      (isReal(input.services) && !omniHealth ? "GATEWAY_PROBE_MISSING" : null) ??
      (!isReal(input.services) && !isScopeRefused(input.services) ? "GATEWAY_UNAVAILABLE" : null) ??
      (failureCode(input.spend) ? "LEDGER_UNAVAILABLE" : null),
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
    empty: (v) => v.records === 0,
  });

  // ── VPS ───────────────────────────────────────────────────────────────────
  const vps = observe({
    ...common,
    truth: input.vps,
    maxAgeMs: LIVE_MAX_AGE_MS.vps,
    source: "/proc, /sys et statfs de l'hôte icos-web (lecture seule)",
    observedAt: (v) => v.sampledAt,
    degradedCode: isReal(input.vps) && input.vps.value.cores === null ? "CPU_COUNT_UNKNOWN" : null,
  });

  const servicesObserved = observe({
    ...common,
    truth: input.services,
    maxAgeMs: LIVE_MAX_AGE_MS.omniroute,
    source:
      "sondes de services (SELECT 1, GET /api/monitoring/health), heure d'acquisition, cache 15 s",
    observedAt: (v) => latestOf(v.map((s) => s.checkedAt ?? null)),
    empty: (v) => v.length === 0,
  });

  // ── Incidents confirmés : seulement sur une mesure FRAÎCHE ────────────────
  const incidents: LiveIncident[] = [];
  const fresh = (o: Observed<unknown>) => o.state === "ok";
  if (fresh(vps) && vps.data?.overall === "incident")
    incidents.push({ source: "vps", code: "HOST_SATURATED", detail: "Saturation hôte mesurée." });
  if (fresh(servicesObserved) && omniHealth?.availability.state === "down")
    incidents.push({ source: "omniroute", code: "OMNIROUTE_DOWN", detail: omniHealth.detail });
  if (fresh(servicesObserved) && pg?.availability.state === "down")
    incidents.push({ source: "memory", code: "POSTGRES_DOWN", detail: pg.detail });
  /* Une sonde échouée DATÉE dans l'horizon est une mesure, même si un autre worker est périmé. */
  const recentFailed = workers.data?.recentFailed ?? 0;
  if ((workers.state === "ok" || workers.state === "degraded") && recentFailed > 0)
    incidents.push({
      source: "workers",
      code: "WORKER_PROBE_FAILED",
      detail: `${recentFailed} worker(s) actif(s) avec une sonde récente en échec.`,
    });
  const dead24h = core3.data?.scheduler?.dead24h ?? 0;
  if ((core3.state === "ok" || core3.state === "degraded") && dead24h > 0)
    incidents.push({
      source: "core3",
      code: "SCHEDULER_DEAD_JOBS",
      detail: `${dead24h} job(s) du scheduler passé(s) dead dans les dernières 24 h.`,
    });

  return {
    schema: LIVE_SCHEMA,
    generatedAt: input.now.toISOString(),
    scope: input.scope,
    sources: { core3, workers, omniroute, memory, vps },
    services: servicesObserved,
    incidents,
  };
}
