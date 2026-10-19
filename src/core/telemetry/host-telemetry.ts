/**
 * Contrat de télémétrie hôte (VPS) exposé au cockpit. Logique PURE : aucun
 * accès système ici — la collecte vit dans `src/server/telemetry`.
 *
 * Principes :
 * - une métrique non mesurée est `unavailable` avec une raison explicite ; on
 *   n'invente jamais de valeur ;
 * - les seuils de saturation sont centralisés ici pour que serveur, UI et
 *   tests partagent la même classification ;
 * - quatre tons : `ok` (vert), `degraded` (orange), `incident` (rouge),
 *   `improve` (violet, recommandation d'amélioration non bloquante).
 */

export type HealthTone = "ok" | "degraded" | "incident" | "improve";

export type Measured<T> = { available: true; value: T } | { available: false; reason: string };

export function measured<T>(value: T): Measured<T> {
  return { available: true, value };
}

export function unavailable<T = never>(reason: string): Measured<T> {
  return { available: false, reason };
}

/** Capacité totale / utilisée / disponible, en unités de base (octets). */
export interface Capacity {
  total: number;
  used: number;
  available: number;
  /** used / total, borné à [0, 1]. 0 si total = 0. */
  ratio: number;
}

export interface CpuSample {
  /** Nombre de vCPU logiques vus par le noyau. */
  cores: number;
  /** Utilisation globale [0, 1] sur l'intervalle depuis l'échantillon précédent. */
  usage: Measured<number>;
  /** Utilisation par vCPU [0, 1], même ordre que /proc/stat. */
  perCore: Measured<number[]>;
  /** Part d'attente I/O [0, 1] (signal de saturation disque). */
  iowait: Measured<number>;
  /** Moyennes de charge 1/5/15 min. */
  load: Measured<{ one: number; five: number; fifteen: number }>;
}

export interface NetworkInterfaceSample {
  name: string;
  rxBytesPerSec: Measured<number>;
  txBytesPerSec: Measured<number>;
  /** Débit de lien annoncé par le noyau (bits/s) ; souvent absent sur une VM. */
  linkSpeedBitsPerSec: Measured<number>;
}

export interface DiskSample {
  mount: string;
  capacity: Measured<Capacity>;
}

/**
 * Pression (PSI, /proc/pressure) : part du temps [0, 1] où au moins une tâche
 * a été retardée faute de ressource, moyenne glissante sur 10 s.
 */
export interface PressureSample {
  cpu: Measured<number>;
  memory: Measured<number>;
  io: Measured<number>;
}

export interface ProcessSample {
  /** Entités ordonnançables exécutables / totales (threads, champ 4 de /proc/loadavg). */
  runnable: Measured<number>;
  total: Measured<number>;
  /** Processus serveur ICOS lui-même. */
  icos: Measured<{ rssBytes: number; heapUsedBytes: number; cpuRatio: number | null }>;
}

/**
 * Limites du cgroup du processus ICOS. Elles ne diffèrent de l'hôte que dans
 * un conteneur ou une unité systemd bornée ; `null` = non borné.
 */
export interface ContainerSample {
  /** Vrai si un marqueur de conteneur (/.dockerenv, /run/.containerenv) est présent. */
  inContainer: boolean;
  memoryLimitBytes: Measured<number | null>;
  memoryUsedBytes: Measured<number>;
  cpuLimitCores: Measured<number | null>;
  /** Vrai si une limite effective est plus stricte que la capacité de l'hôte. */
  differsFromHost: boolean;
}

export interface HostSample {
  /** Horodatage ISO de la mesure. */
  at: string;
  cpu: CpuSample;
  memory: Measured<Capacity>;
  /** `value.total = 0` signifie « swap non configuré ». */
  swap: Measured<Capacity>;
  disks: DiskSample[];
  network: {
    rxBytesPerSec: Measured<number>;
    txBytesPerSec: Measured<number>;
    interfaces: NetworkInterfaceSample[];
  };
  uptimeSeconds: Measured<number>;
  pressure: PressureSample;
  processes: ProcessSample;
  container: ContainerSample;
}

/** Point compact d'historique court (sparkline). `null` = non mesuré. */
export interface HostHistoryPoint {
  at: string;
  cpu: number | null;
  memory: number | null;
  swap: number | null;
  disk: number | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
}

export type SignalKey =
  "cpu" | "load" | "iowait" | "memory" | "pressure" | "swap" | "disk" | "network" | "container";

export interface HealthSignal {
  key: SignalKey | "extension";
  tone: HealthTone;
  /** Message court, en français, sans donnée sensible. */
  message: string;
}

/**
 * Extensions IA prévues. Tant qu'aucune source réelle n'est câblée, elles
 * restent `unavailable` — la structure existe pour que l'UI les annonce
 * honnêtement.
 */
export interface AiCapacityExtensions {
  latencyMs: Measured<{ p50: number; p95: number }>;
  tokensPerSecond: Measured<number>;
  inferenceBudget: Measured<{ spent: number; limit: number; currency: string }>;
  concurrentWorkers: Measured<{ active: number; max: number }>;
}

/**
 * Marge brute de l'hôte pour de nouveaux workers. Le nombre de workers
 * supplémentaires relève de `WorkerCapacity` (empreinte mesurée requise).
 */
export interface HostHeadroom {
  /** vCPU inoccupés sur le dernier intervalle (cores × (1 − usage)). */
  idleVcpu: Measured<number>;
  /** RAM disponible effective (min hôte / limite cgroup). */
  memoryAvailableBytes: Measured<number>;
}

/**
 * `down` : sondé et indisponible. `not_instrumented` : aucune sonde n'existe.
 * `not_connected` : une sonde existe mais cet environnement n'est relié à
 * aucune instance (aucune adresse configurée) — rien n'est sondé, et l'on ne
 * se rabat jamais sur une adresse par défaut ou de production.
 */
export type ServiceState =
  "operational" | "degraded" | "down" | "not_instrumented" | "not_connected";

/** Résultat d'une couche de sonde. */
export interface ProbeLayer {
  state: ServiceState;
  /** Explication courte, sans hôte, port, identifiant ni message brut de driver. */
  detail: string;
  latencyMs?: number;
}

/**
 * Santé d'un service en trois couches distinctes :
 * - `process` : le processus/composant existe-t-il et répond-il ?
 * - `availability` : le service rend-il son service (sonde réelle) ?
 * - `mission` : ICOS peut-il s'en servir pour exécuter une mission maintenant ?
 * `null` = couche sans objet pour ce service.
 */
export interface ServiceHealth {
  key: string;
  label: string;
  /** Synthèse affichée : état de la couche `availability`. */
  state: ServiceState;
  /** Explication courte de l'état ou de l'absence de sonde. */
  detail: string;
  /** Mécanisme réellement utilisé (ou absent), pour la traçabilité. */
  source: string;
  process: ProbeLayer | null;
  availability: ProbeLayer;
  mission: ProbeLayer | null;
  /** Horodatage ISO de la sonde (cache inclus) ; absent si non instrumenté. */
  checkedAt?: string;
}

/**
 * Compteur de capacité des workers. Le nombre de workers supplémentaires
 * n'est calculé QUE si une empreinte réelle par worker a été mesurée ; tant
 * que ce n'est pas le cas, aucune estimation théorique n'est publiée.
 */
export interface WorkerCapacity {
  /** Jobs cockpit en file / en cours dans ce processus. */
  activeJobs: Measured<number>;
  /** Emplacements du registre de jobs (capacité de suivi, pas de calcul). */
  jobSlots: Measured<number>;
  /** Empreinte mesurée d'un worker (pic CPU en vCPU, pic RAM en octets). */
  perWorkerFootprint: Measured<{ cpuVcpu: number; memoryBytes: number; samples: number }>;
  additionalWorkers: Measured<number>;
}

export interface HostTelemetrySnapshot {
  /** Version du contrat, à incrémenter en cas de rupture. */
  schema: 1;
  hostname: Measured<string>;
  sampleIntervalSeconds: number;
  current: HostSample;
  history: HostHistoryPoint[];
  overall: Exclude<HealthTone, "improve">;
  signals: HealthSignal[];
  recommendations: HealthSignal[];
  headroom: HostHeadroom;
  services: ServiceHealth[];
  workers: WorkerCapacity;
  extensions: AiCapacityExtensions;
}

/** Seuils [degraded, incident] — ratios [0, 1] sauf `loadPerCore`. */
export const SATURATION_THRESHOLDS = {
  cpu: [0.75, 0.9],
  iowait: [0.1, 0.25],
  loadPerCore: [1, 2],
  memory: [0.8, 0.92],
  swap: [0.25, 0.6],
  disk: [0.8, 0.9],
  pressure: [0.1, 0.3],
} as const satisfies Record<string, readonly [number, number]>;

export function toneFor(
  value: number,
  [degraded, incident]: readonly [number, number],
): HealthTone {
  if (value >= incident) return "incident";
  if (value >= degraded) return "degraded";
  return "ok";
}

export function capacityOf(total: number, available: number): Capacity {
  const safeTotal = Math.max(0, total);
  const safeAvailable = Math.min(safeTotal, Math.max(0, available));
  const used = safeTotal - safeAvailable;
  return {
    total: safeTotal,
    used,
    available: safeAvailable,
    ratio: safeTotal === 0 ? 0 : used / safeTotal,
  };
}

const pct = (ratio: number) => `${Math.round(ratio * 100)} %`;

/**
 * Classe un échantillon : signaux de saturation (vert/orange/rouge) et
 * recommandations (violet). Ne produit aucun signal pour une métrique non
 * mesurée — l'absence de mesure n'est ni un succès ni un incident.
 */
export function classifyHostSample(sample: HostSample): {
  overall: Exclude<HealthTone, "improve">;
  signals: HealthSignal[];
  recommendations: HealthSignal[];
} {
  const signals: HealthSignal[] = [];
  const recommendations: HealthSignal[] = [];
  const t = SATURATION_THRESHOLDS;

  if (sample.cpu.usage.available) {
    const tone = toneFor(sample.cpu.usage.value, t.cpu);
    signals.push({ key: "cpu", tone, message: `CPU ${pct(sample.cpu.usage.value)}` });
  }
  if (sample.cpu.load.available && sample.cpu.cores > 0) {
    const perCore = sample.cpu.load.value.five / sample.cpu.cores;
    signals.push({
      key: "load",
      tone: toneFor(perCore, t.loadPerCore),
      message: `Charge 5 min ${sample.cpu.load.value.five.toFixed(2)} pour ${sample.cpu.cores} vCPU`,
    });
  }
  if (sample.cpu.iowait.available) {
    const tone = toneFor(sample.cpu.iowait.value, t.iowait);
    signals.push({ key: "iowait", tone, message: `Attente I/O ${pct(sample.cpu.iowait.value)}` });
  }
  if (sample.memory.available) {
    const m = sample.memory.value;
    signals.push({
      key: "memory",
      tone: toneFor(m.ratio, t.memory),
      message: `RAM ${pct(m.ratio)}`,
    });
  }
  const pressures = [
    ["memory", "mémoire", sample.pressure.memory],
    ["cpu", "CPU", sample.pressure.cpu],
    ["io", "I/O", sample.pressure.io],
  ] as const;
  for (const [, label, value] of pressures) {
    if (!value.available) continue;
    signals.push({
      key: "pressure",
      tone: toneFor(value.value, t.pressure),
      message: `Pression ${label} ${pct(value.value)}`,
    });
  }
  const c = sample.container;
  if (
    c.memoryLimitBytes.available &&
    c.memoryLimitBytes.value !== null &&
    c.memoryUsedBytes.available
  ) {
    const ratio =
      c.memoryLimitBytes.value === 0 ? 0 : c.memoryUsedBytes.value / c.memoryLimitBytes.value;
    signals.push({
      key: "container",
      tone: toneFor(ratio, t.memory),
      message: `Mémoire du cgroup ICOS ${pct(ratio)} de sa limite`,
    });
  }
  if (sample.swap.available) {
    const s = sample.swap.value;
    if (s.total === 0) {
      if (sample.memory.available && sample.memory.value.ratio >= t.memory[0]) {
        recommendations.push({
          key: "swap",
          tone: "improve",
          message:
            "Aucun swap configuré alors que la RAM est sous tension : envisager un swap de secours.",
        });
      }
    } else {
      signals.push({
        key: "swap",
        tone: toneFor(s.ratio, t.swap),
        message: `Swap ${pct(s.ratio)}`,
      });
      if (s.ratio > 0.05 && sample.memory.available && sample.memory.value.ratio < 0.5) {
        recommendations.push({
          key: "swap",
          tone: "improve",
          message: "Swap utilisé malgré une RAM disponible : vérifier vm.swappiness.",
        });
      }
    }
  }
  for (const disk of sample.disks) {
    if (!disk.capacity.available) continue;
    const ratio = disk.capacity.value.ratio;
    const tone = toneFor(ratio, t.disk);
    signals.push({ key: "disk", tone, message: `Disque ${disk.mount} ${pct(ratio)}` });
    if (tone === "ok" && ratio >= 0.7) {
      recommendations.push({
        key: "disk",
        tone: "improve",
        message: `Disque ${disk.mount} à ${pct(ratio)} : planifier un nettoyage (images, journaux).`,
      });
    }
  }

  const overall = signals.some((s) => s.tone === "incident")
    ? "incident"
    : signals.some((s) => s.tone === "degraded")
      ? "degraded"
      : "ok";

  return { overall, signals, recommendations };
}

/** vCPU inoccupés et RAM effective, en tenant compte des limites du cgroup. */
export function computeHeadroom(sample: HostSample): HostHeadroom {
  const { cpu, memory, container } = sample;
  let idleVcpu: Measured<number> = unavailable("Utilisation CPU non mesurée.");
  if (cpu.usage.available) {
    const hostIdle = cpu.cores * (1 - cpu.usage.value);
    const limit = container.cpuLimitCores.available ? container.cpuLimitCores.value : null;
    idleVcpu = measured(limit === null ? hostIdle : Math.min(hostIdle, limit));
  }
  let memoryAvailableBytes: Measured<number> = unavailable("Mémoire non mesurée.");
  if (memory.available) {
    let available = memory.value.available;
    const limit = container.memoryLimitBytes.available ? container.memoryLimitBytes.value : null;
    if (limit !== null && container.memoryUsedBytes.available) {
      available = Math.min(available, Math.max(0, limit - container.memoryUsedBytes.value));
    }
    memoryAvailableBytes = measured(available);
  }
  return {
    idleVcpu,
    memoryAvailableBytes,
  };
}

/** Nombre minimal d'échantillons d'empreinte avant toute estimation. */
export const MIN_FOOTPRINT_SAMPLES = 5;

/**
 * Workers supplémentaires possibles = min(vCPU libres / pic CPU, RAM
 * disponible / pic RAM), arrondi vers le bas. Indisponible tant que
 * l'empreinte n'est pas mesurée sur assez d'exécutions réelles.
 */
export function estimateAdditionalWorkers(
  headroom: HostHeadroom,
  footprint: WorkerCapacity["perWorkerFootprint"],
): Measured<number> {
  if (!footprint.available) {
    return unavailable(
      "Consommation CPU/RAM réelle d'un worker non mesurée : aucune estimation publiée.",
    );
  }
  const { cpuVcpu, memoryBytes, samples } = footprint.value;
  if (samples < MIN_FOOTPRINT_SAMPLES) {
    return unavailable(
      `Empreinte mesurée sur ${samples} exécution(s) seulement (minimum ${MIN_FOOTPRINT_SAMPLES}).`,
    );
  }
  if (cpuVcpu <= 0 || memoryBytes <= 0) return unavailable("Empreinte mesurée invalide.");
  if (!headroom.idleVcpu.available || !headroom.memoryAvailableBytes.available) {
    return unavailable("Marge CPU/RAM de l'hôte non mesurée.");
  }
  return measured(
    Math.max(
      0,
      Math.floor(
        Math.min(
          headroom.idleVcpu.value / cpuVcpu,
          headroom.memoryAvailableBytes.value / memoryBytes,
        ),
      ),
    ),
  );
}

/** Extensions IA non encore câblées : toutes explicitement indisponibles. */
export function unwiredAiExtensions(): AiCapacityExtensions {
  return {
    latencyMs: unavailable("Aucune source de latence d'inférence câblée au cockpit."),
    tokensPerSecond: unavailable("Aucun compteur de débit de tokens exposé."),
    inferenceBudget: unavailable("Budget d'inférence non relié à la télémétrie."),
    concurrentWorkers: unavailable("Registre des workers non relié à la télémétrie."),
  };
}
