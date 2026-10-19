import {
  estimateAdditionalWorkers,
  measured,
  unavailable,
  type HostTelemetrySnapshot,
  type ProbeLayer,
  type ServiceHealth,
  type WorkerCapacity,
} from "@/core/telemetry";
import { loadEnv } from "@/config/env";
import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import type { DatabaseHealthPort, DatabasePing } from "@/server/database/health";

import {
  createOmniRouteMonitor,
  type OmniRouteMonitoringResult,
  type OmniRouteMonitorPort,
} from "./omniroute-monitoring";

/**
 * Sondes de santé des services ICOS. Principes :
 * - uniquement des mécanismes EXISTANTS (pool PostgreSQL du container,
 *   route native de monitoring d'OmniRoute, registre durable des workers) ;
 * - aucune inférence, aucune écriture, aucun démarrage de worker ;
 * - délai garanti par sonde, cache de fraîcheur (une sonde réseau par
 *   service et par intervalle, quel que soit le nombre de clients) ;
 * - un service sans sonde est « Non instrumenté », jamais « Opérationnel ».
 */

export interface ServiceProbeDependencies {
  database?: DatabaseHealthPort;
  omniRoute?: OmniRouteMonitorPort;
  /**
   * false = aucune adresse OmniRoute configurée pour cet environnement : rien
   * n'est sondé (pas de repli vers l'adresse par défaut ni vers la production).
   */
  omniRouteConnected?: boolean;
  now?: () => number;
  /** Fraîcheur maximale d'un résultat de sonde réseau (ms). */
  ttlMs?: number;
  databaseTimeoutMs?: number;
  omniRouteTimeoutMs?: number;
}

export interface ServiceProbeReport {
  services: ServiceHealth[];
}

/** Latence au-delà de laquelle une réponse correcte est jugée dégradée. */
export const SLOW_PROBE_MS = { database: 500, omniRoute: 1_000 } as const;

/** Fournisseur OmniRoute qui sert Nemotron (NVIDIA). */
const NEMOTRON_PROVIDER = "nvidia";

interface CacheEntry<T> {
  at: number;
  value?: T;
  inFlight?: Promise<T>;
}

export class ServiceProbes {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly databaseTimeoutMs: number;
  private readonly omniRouteTimeoutMs: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();

  constructor(private readonly deps: ServiceProbeDependencies) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? 15_000;
    this.databaseTimeoutMs = deps.databaseTimeoutMs ?? 2_000;
    this.omniRouteTimeoutMs = deps.omniRouteTimeoutMs ?? 2_500;
  }

  async collect(): Promise<ServiceProbeReport> {
    const [db, omni] = await Promise.all([this.databaseProbe(), this.omniRouteProbe()]);
    return {
      services: [
        postgresService(db),
        omniRouteService(omni),
        notInstrumented(
          "temporal",
          "Temporal",
          "Aucune sonde de joignabilité en lecture seule n'est composée pour le dispatcher Temporal : la connexion n'est pas échantillonnée.",
        ),
        nemotronService(omni),
      ],
    };
  }

  private databaseProbe(): Promise<ProbeOutcome<DatabasePing>> {
    const database = this.deps.database;
    if (!database) return Promise.resolve({ kind: "absent" });
    const timeoutMs = this.databaseTimeoutMs;
    return this.cached("postgres", () =>
      withDeadline(database.ping(timeoutMs), timeoutMs + 500, {
        ok: false as const,
        latencyMs: timeoutMs,
        error: "timeout" as const,
      }),
    );
  }

  private omniRouteProbe(): Promise<ProbeOutcome<OmniRouteMonitoringResult>> {
    if (this.deps.omniRouteConnected === false) return Promise.resolve({ kind: "not_connected" });
    const omniRoute = this.deps.omniRoute;
    if (!omniRoute) return Promise.resolve({ kind: "absent" });
    const timeoutMs = this.omniRouteTimeoutMs;
    return this.cached("omniroute", () =>
      withDeadline(omniRoute.monitoringHealth(timeoutMs), timeoutMs + 500, {
        ok: false as const,
        latencyMs: timeoutMs,
        error: "timeout" as const,
      }),
    );
  }

  /** Cache de fraîcheur + vol unique : au plus une sonde par clé et par TTL. */
  private async cached<T>(key: string, run: () => Promise<T>): Promise<ProbeOutcome<T>> {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (entry?.value !== undefined && this.now() - entry.at < this.ttlMs) {
      return { kind: "result", value: entry.value, at: entry.at };
    }
    if (entry?.inFlight) {
      const value = await entry.inFlight;
      return { kind: "result", value, at: (this.cache.get(key) as CacheEntry<T>).at };
    }
    const inFlight = run();
    this.cache.set(key, { at: entry?.at ?? 0, value: entry?.value, inFlight });
    try {
      const value = await inFlight;
      const at = this.now();
      this.cache.set(key, { at, value });
      return { kind: "result", value, at };
    } catch {
      this.cache.delete(key);
      throw new Error("La sonde a échoué de manière inattendue.");
    }
  }
}

type ProbeOutcome<T> =
  { kind: "absent" } | { kind: "not_connected" } | { kind: "result"; value: T; at: number };

function withDeadline<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function layer(state: ProbeLayer["state"], detail: string, latencyMs?: number): ProbeLayer {
  return latencyMs === undefined
    ? { state, detail }
    : { state, detail, latencyMs: Math.round(latencyMs) };
}

const OMNI_NOT_CONNECTED =
  "Aucune adresse OmniRoute configurée pour cet environnement (OMNIROUTE_BASE_URL absent) : rien n'est sondé, sans repli vers une instance par défaut ou de production.";

function notConnected(key: string, label: string, detail: string, source: string): ServiceHealth {
  const off = layer("not_connected", detail);
  return {
    key,
    label,
    state: "not_connected",
    detail,
    source,
    process: off,
    availability: off,
    mission: off,
  };
}

function notInstrumented(key: string, label: string, detail: string): ServiceHealth {
  const off = layer("not_instrumented", detail);
  return {
    key,
    label,
    state: "not_instrumented",
    detail,
    source: "aucune sonde composée dans ce processus",
    process: off,
    availability: off,
    mission: off,
  };
}

function summarize(
  key: string,
  label: string,
  source: string,
  layers: Pick<ServiceHealth, "process" | "availability" | "mission">,
  at?: number,
): ServiceHealth {
  return {
    key,
    label,
    state: layers.availability.state,
    detail: layers.availability.detail,
    source,
    ...layers,
    ...(at === undefined ? {} : { checkedAt: new Date(at).toISOString() }),
  };
}

function postgresService(outcome: ProbeOutcome<DatabasePing>): ServiceHealth {
  if (outcome.kind !== "result") {
    return notInstrumented(
      "postgres",
      "PostgreSQL",
      "Backend mémoire : ce processus n'utilise pas de pool PostgreSQL.",
    );
  }
  const ping = outcome.value;
  const source = "SELECT 1 sur le pool partagé du container (lecture seule)";
  if (!ping.ok) {
    const detail =
      ping.error === "timeout"
        ? `Pas de réponse en ${Math.round(ping.latencyMs)} ms (requête annulée).`
        : "Requête refusée ou connexion impossible (détail du driver masqué).";
    return summarize(
      "postgres",
      "PostgreSQL",
      source,
      {
        process: null,
        availability: layer("down", detail, ping.latencyMs),
        mission: layer("down", "Authentification, rôles et audit indisponibles."),
      },
      outcome.at,
    );
  }
  const slow = ping.latencyMs > SLOW_PROBE_MS.database;
  return summarize(
    "postgres",
    "PostgreSQL",
    source,
    {
      process: null,
      availability: layer(
        slow ? "degraded" : "operational",
        slow ? `Réponse lente : ${Math.round(ping.latencyMs)} ms.` : "Requête exécutée.",
        ping.latencyMs,
      ),
      mission: layer(
        slow ? "degraded" : "operational",
        "Authentification, rôles et audit servis par ce pool.",
      ),
    },
    outcome.at,
  );
}

const OMNI_ERROR: Record<Exclude<OmniRouteMonitoringResult, { ok: true }>["error"], string> = {
  timeout: "Pas de réponse dans le délai imparti.",
  unreachable: "Aucun processus ne répond à l'adresse configurée.",
  http: "Réponse HTTP en erreur.",
  too_large: "Réponse de monitoring trop volumineuse : ignorée.",
  invalid: "Réponse de monitoring non conforme.",
};

function omniRouteService(outcome: ProbeOutcome<OmniRouteMonitoringResult>): ServiceHealth {
  const source = "GET /api/monitoring/health d'OmniRoute (aucune inférence, aucune clé)";
  if (outcome.kind === "not_connected") {
    return notConnected("omniroute", "OmniRoute", OMNI_NOT_CONNECTED, source);
  }
  if (outcome.kind === "absent") {
    const detail = "Configuration OmniRoute invalide : adaptateur non composé, aucune sonde émise.";
    return summarize("omniroute", "OmniRoute", source, {
      process: layer("not_instrumented", "Adresse inutilisable : processus non sondé."),
      availability: layer("down", detail),
      mission: layer("down", "Aucune inférence possible : configuration à corriger."),
    });
  }
  const result = outcome.value;
  if (!result.ok) {
    const detail =
      result.error === "http" && result.httpStatus
        ? `${OMNI_ERROR.http} (HTTP ${result.httpStatus})`
        : OMNI_ERROR[result.error];
    const processDown = result.error === "unreachable" || result.error === "timeout";
    return summarize(
      "omniroute",
      "OmniRoute",
      source,
      {
        process: processDown
          ? layer("down", detail, result.latencyMs)
          : layer("operational", "Le processus répond.", result.latencyMs),
        availability: layer("down", detail, result.latencyMs),
        mission: layer("down", "Aucune inférence possible via OmniRoute."),
      },
      outcome.at,
    );
  }
  const s = result.snapshot;
  const breakers = s.breakers;
  const breakerText = breakers
    ? `Disjoncteurs : ${breakers.closed} fermé(s), ${breakers.degraded} dégradé(s), ${breakers.halfOpen} semi-ouvert(s), ${breakers.open} ouvert(s).`
    : "Disjoncteurs non publiés.";
  const troubled = breakers ? breakers.open + breakers.halfOpen + breakers.degraded > 0 : false;
  // `status` vaut "healthy" en dur dans OmniRoute : seul il ne prouve rien.
  const availabilityState: ProbeLayer["state"] =
    s.status === "unhealthy" || s.status === "unknown"
      ? "down"
      : s.status === "healthy" &&
          !s.partial &&
          !troubled &&
          s.providers.active !== 0 &&
          result.latencyMs <= SLOW_PROBE_MS.omniRoute
        ? "operational"
        : "degraded";
  const statusText = {
    healthy: "sain",
    degraded: "dégradé",
    unhealthy: "en échec",
    unknown: "non reconnu",
  }[s.status];
  const ready =
    availabilityState === "down"
      ? 0
      : Object.values(s.providerStates).filter((p) => p.state === "CLOSED").length;
  return summarize(
    "omniroute",
    "OmniRoute",
    source,
    {
      process: layer(
        "operational",
        s.uptimeSeconds === null
          ? "Le processus répond."
          : `Le processus répond (en service depuis ${Math.floor(s.uptimeSeconds / 3600)} h).`,
        result.latencyMs,
      ),
      availability: layer(
        availabilityState,
        `État annoncé : ${statusText}${s.partial ? " (auto-diagnostic partiel)" : ""}. ${breakerText}`,
        result.latencyMs,
      ),
      mission: layer(
        ready > 0 ? "operational" : "down",
        ready > 0
          ? `${ready} fournisseur(s) au disjoncteur fermé${s.providers.active === null ? "" : ` sur ${s.providers.active} actif(s)`} — capacité déduite, aucune inférence de test.`
          : "Aucun fournisseur au disjoncteur fermé : inférence improbable.",
      ),
    },
    outcome.at,
  );
}

function nemotronService(outcome: ProbeOutcome<OmniRouteMonitoringResult>): ServiceHealth {
  const label = "Nemotron (NVIDIA via OmniRoute)";
  if (outcome.kind === "not_connected") {
    return notConnected(
      "nemotron",
      label,
      "Dépend d'OmniRoute, non connecté dans cet environnement.",
      "disjoncteur du fournisseur nvidia dans le monitoring OmniRoute",
    );
  }
  if (outcome.kind === "absent" || !outcome.value.ok) {
    return notInstrumented(
      "nemotron",
      label,
      "Dépend du monitoring OmniRoute, actuellement illisible.",
    );
  }
  const provider = outcome.value.snapshot.providerStates[NEMOTRON_PROVIDER];
  if (!provider) {
    return notInstrumented("nemotron", label, "Fournisseur NVIDIA absent du monitoring OmniRoute.");
  }
  const state: ProbeLayer["state"] =
    provider.state === "CLOSED" ? "operational" : provider.state === "OPEN" ? "down" : "degraded";
  const failures = provider.failures === null ? "" : `, ${provider.failures} échec(s) récent(s)`;
  return summarize(
    "nemotron",
    label,
    "disjoncteur du fournisseur nvidia dans le monitoring OmniRoute",
    {
      process: null,
      availability: layer(state, `Disjoncteur ${provider.state}${failures}.`),
      mission: layer(
        "not_instrumented",
        "Quota et modèle Nemotron non exposés : aptitude mission non vérifiable sans inférence.",
      ),
    },
    outcome.at,
  );
}

/**
 * Faits de flotte lus dans le registre durable des workers et le journal de
 * dispatch (jamais déduits d'une session ou d'un processus).
 */
export interface FleetFacts {
  /** Workers enregistrés, tous états confondus. */
  workers: readonly Pick<WorkerRegistryEntry, "status" | "maxConcurrency">[];
  /** Un identifiant de worker par dispatch non terminal qui le détient. */
  activeAssignments: readonly string[];
}

/** Compteur de capacité des workers, sans aucune estimation théorique. */
export function workerCapacity(
  headroom: HostTelemetrySnapshot["headroom"],
  fleet: FleetFacts | null,
  footprint: WorkerCapacity["perWorkerFootprint"] = unavailable(
    "Empreinte CPU/RAM d'un worker jamais mesurée : instrumentation de l'exécution réelle à brancher.",
  ),
): WorkerCapacity {
  const noFleet = "Registre des workers ou journal de dispatch illisible.";
  return {
    activeJobs: fleet ? measured(fleet.activeAssignments.length) : unavailable(noFleet),
    jobSlots: fleet
      ? measured(
          fleet.workers
            .filter((w) => w.status === "active")
            .reduce((sum, w) => sum + Math.max(0, w.maxConcurrency), 0),
        )
      : unavailable(noFleet),
    perWorkerFootprint: footprint,
    additionalWorkers: estimateAdditionalWorkers(headroom, footprint),
  };
}

/**
 * L'environnement est-il relié à une instance OmniRoute ? Seule une adresse
 * explicitement configurée compte : la valeur par défaut de `loadEnv` n'est
 * pas une connexion (l'aperçu local reste ainsi isolé de la production).
 */
export function isOmniRouteConfigured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(environment.OMNIROUTE_BASE_URL?.trim());
}

function defaultOmniRoute(): OmniRouteMonitorPort | undefined {
  try {
    const baseUrl = loadEnv().OMNIROUTE_BASE_URL;
    return baseUrl ? createOmniRouteMonitor(baseUrl) : undefined;
  } catch {
    return undefined;
  }
}

const PROBES_KEY = "__icosServiceProbes__";

type GlobalWithProbes = typeof globalThis & { [PROBES_KEY]?: ServiceProbes };

/**
 * Instance unique par processus. La sonde PostgreSQL utilise le pool du
 * container fourni au premier appel ; OmniRoute utilise la même adresse que
 * le runtime (`loadEnv().OMNIROUTE_BASE_URL`), sans clé.
 */
export function getServiceProbes(database: DatabaseHealthPort | undefined): ServiceProbes {
  const globalRef = globalThis as GlobalWithProbes;
  const omniRouteConnected = isOmniRouteConfigured();
  globalRef[PROBES_KEY] ??= new ServiceProbes({
    database,
    omniRouteConnected,
    omniRoute: omniRouteConnected ? defaultOmniRoute() : undefined,
  });
  return globalRef[PROBES_KEY];
}

export function setServiceProbesForTests(probes: ServiceProbes | null): void {
  const globalRef = globalThis as GlobalWithProbes;
  if (probes) globalRef[PROBES_KEY] = probes;
  else delete globalRef[PROBES_KEY];
}
