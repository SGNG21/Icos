import { access, readFile, statfs } from "node:fs/promises";
import { hostname } from "node:os";

import {
  capacityOf,
  classifyHostSample,
  computeHeadroom,
  estimateAdditionalWorkers,
  measured,
  unavailable,
  unwiredAiExtensions,
  type ContainerSample,
  type DiskSample,
  type HostHistoryPoint,
  type HostSample,
  type HostTelemetrySnapshot,
  type Measured,
  type NetworkInterfaceSample,
  type ProcessSample,
  type ServiceHealth,
} from "@/core/telemetry";

import {
  busyRatio,
  iowaitRatio,
  isPhysicalInterface,
  parseCgroupBytes,
  parseCgroupV2Path,
  parseCpuMax,
  parseLoadAvg,
  parseLoadAvgTasks,
  parseMemInfo,
  parseNetDev,
  parsePressureSome,
  parseProcStat,
  parseUptime,
  ratePerSecond,
  type MemInfo,
  type NetCounters,
  type ProcStat,
} from "./proc-parsers";

/** Fichiers noyau lus — liste FERMÉE, jamais dérivée d'une entrée client. */
export type ProcPath =
  | "/proc/stat"
  | "/proc/meminfo"
  | "/proc/loadavg"
  | "/proc/uptime"
  | "/proc/net/dev"
  | "/proc/pressure/cpu"
  | "/proc/pressure/memory"
  | "/proc/pressure/io";

/** Fichiers cgroup v2 lus dans le cgroup du processus — liste FERMÉE. */
export type CgroupFile = "memory.max" | "memory.current" | "cpu.max";

export interface ProcessUsage {
  rssBytes: number;
  heapUsedBytes: number;
  /** Temps CPU cumulé user + system du processus, en microsecondes. */
  cpuMicros: number;
}

/** Port d'accès système, injectable pour les tests. */
export interface HostSource {
  readProc(path: ProcPath): Promise<string | null>;
  /** Contenu d'un fichier du cgroup v2 du processus ; null si absent. */
  readCgroup(file: CgroupFile): Promise<string | null>;
  /** Vrai si un marqueur de conteneur est présent. */
  containerMarker(): Promise<boolean>;
  /** Capacité d'un point de montage en octets (sémantique `df`). */
  diskUsage(mount: string): Promise<{ total: number; available: number } | null>;
  /** Débit de lien en bits/s, null si inconnu (VM, interface virtuelle). */
  linkSpeed(iface: string): Promise<number | null>;
  processUsage(): ProcessUsage | null;
  hostname(): string | null;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const IFACE_NAME = /^[A-Za-z0-9_.-]{1,15}$/;

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

export const nodeHostSource: HostSource = {
  readProc: readTextOrNull,
  async readCgroup(file) {
    const self = await readTextOrNull("/proc/self/cgroup");
    const path = self === null ? null : parseCgroupV2Path(self);
    if (path === null) return null;
    return readTextOrNull(`/sys/fs/cgroup${path}/${file}`);
  },
  async containerMarker() {
    for (const marker of ["/.dockerenv", "/run/.containerenv"]) {
      try {
        await access(marker);
        return true;
      } catch {
        // marqueur absent
      }
    }
    return false;
  },
  async diskUsage(mount) {
    try {
      const s = await statfs(mount);
      // Même sémantique que `df` : les blocs réservés root ne sont pas « disponibles ».
      const used = (s.blocks - s.bfree) * s.bsize;
      const available = s.bavail * s.bsize;
      return { total: used + available, available };
    } catch {
      return null;
    }
  },
  async linkSpeed(iface) {
    if (!IFACE_NAME.test(iface)) return null;
    const text = await readTextOrNull(`/sys/class/net/${iface}/speed`);
    const mbps = Number(text?.trim());
    return text !== null && Number.isFinite(mbps) && mbps > 0 ? mbps * 1_000_000 : null;
  },
  processUsage() {
    try {
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        cpuMicros: cpu.user + cpu.system,
      };
    } catch {
      return null;
    }
  },
  hostname() {
    try {
      return hostname();
    } catch {
      return null;
    }
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface HostSamplerOptions {
  source?: HostSource;
  mounts?: readonly string[];
  /** Cadence attendue côté client ; sert aussi de fraîcheur maximale du cache. */
  sampleIntervalSeconds?: number;
  /** Nombre de points d'historique conservés en mémoire. */
  historySize?: number;
  /** Délai entre les deux relevés du tout premier échantillon (calcul de deltas). */
  warmupMs?: number;
}

interface RawReading {
  at: number;
  stat: ProcStat | null;
  net: NetCounters[];
  process: ProcessUsage | null;
}

/**
 * Échantillonneur hôte, local au processus. Mesure à la demande (pas de
 * minuterie de fond) avec un cache de fraîcheur : N lecteurs simultanés ne
 * déclenchent qu'une lecture /proc par intervalle.
 */
export class HostTelemetrySampler {
  private readonly source: HostSource;
  private readonly mounts: readonly string[];
  private readonly intervalSeconds: number;
  private readonly historySize: number;
  private readonly warmupMs: number;
  private previous: RawReading | null = null;
  private latest: HostSample | null = null;
  private latestAt = 0;
  private readonly history: HostHistoryPoint[] = [];
  private inFlight: Promise<HostSample> | null = null;

  constructor(options: HostSamplerOptions = {}) {
    this.source = options.source ?? nodeHostSource;
    this.mounts = options.mounts ?? ["/"];
    this.intervalSeconds = options.sampleIntervalSeconds ?? 10;
    this.historySize = options.historySize ?? 90;
    this.warmupMs = options.warmupMs ?? 500;
  }

  async snapshot(): Promise<HostTelemetrySnapshot> {
    const current = await this.freshSample();
    const { overall, signals, recommendations } = classifyHostSample(current);
    const name = this.source.hostname();
    const headroom = computeHeadroom(current);
    return {
      schema: 1,
      hostname: name ? measured(name) : unavailable("Nom d'hôte illisible."),
      sampleIntervalSeconds: this.intervalSeconds,
      current,
      history: [...this.history],
      overall,
      signals,
      recommendations,
      headroom,
      services: localServices(current),
      workers: {
        activeJobs: unavailable("Runtime cockpit non inspecté."),
        jobSlots: unavailable("Runtime cockpit non inspecté."),
        perWorkerFootprint: unavailable("Empreinte CPU/RAM d'un worker jamais mesurée."),
        additionalWorkers: estimateAdditionalWorkers(
          headroom,
          unavailable("Empreinte CPU/RAM d'un worker jamais mesurée."),
        ),
      },
      extensions: unwiredAiExtensions(),
    };
  }

  private async freshSample(): Promise<HostSample> {
    // Une demi-période de fraîcheur : un client à 10 s obtient toujours une
    // nouvelle mesure, deux onglets ne doublent pas la cadence de lecture.
    const maxAgeMs = (this.intervalSeconds * 1000) / 2;
    if (this.latest && this.source.now() - this.latestAt < maxAgeMs) return this.latest;
    if (!this.inFlight) {
      this.inFlight = this.takeSample().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async readRaw(): Promise<RawReading> {
    const [statText, netText] = await Promise.all([
      this.source.readProc("/proc/stat"),
      this.source.readProc("/proc/net/dev"),
    ]);
    return {
      at: this.source.now(),
      stat: statText ? parseProcStat(statText) : null,
      net: netText ? parseNetDev(netText).filter((c) => isPhysicalInterface(c.name)) : [],
      process: this.source.processUsage(),
    };
  }

  private async takeSample(): Promise<HostSample> {
    if (!this.previous) {
      this.previous = await this.readRaw();
      await this.source.sleep(this.warmupMs);
    }
    const previous = this.previous;
    const [raw, memText, loadText, uptimeText, disks, psiCpu, psiMem, psiIo] = await Promise.all([
      this.readRaw(),
      this.source.readProc("/proc/meminfo"),
      this.source.readProc("/proc/loadavg"),
      this.source.readProc("/proc/uptime"),
      Promise.all(this.mounts.map((mount) => this.diskSample(mount))),
      this.source.readProc("/proc/pressure/cpu"),
      this.source.readProc("/proc/pressure/memory"),
      this.source.readProc("/proc/pressure/io"),
    ]);
    this.previous = raw;
    const mem = memText ? parseMemInfo(memText) : null;
    const cpu = this.cpuSample(previous, raw, loadText);

    const noPsi = "PSI indisponible (noyau sans /proc/pressure).";
    const sample: HostSample = {
      at: new Date(raw.at).toISOString(),
      cpu,
      ...memorySample(mem),
      disks,
      network: await this.networkSample(previous, raw),
      uptimeSeconds: optional(
        uptimeText ? parseUptime(uptimeText) : null,
        "/proc/uptime illisible.",
      ),
      pressure: {
        cpu: optional(psiCpu ? parsePressureSome(psiCpu) : null, noPsi),
        memory: optional(psiMem ? parsePressureSome(psiMem) : null, noPsi),
        io: optional(psiIo ? parsePressureSome(psiIo) : null, noPsi),
      },
      processes: processSample(previous, raw, loadText, cpu.cores),
      container: await this.containerSample(mem, cpu.cores),
    };

    this.latest = sample;
    this.latestAt = raw.at;
    this.history.push(historyPoint(sample));
    if (this.history.length > this.historySize) {
      this.history.splice(0, this.history.length - this.historySize);
    }
    return sample;
  }

  private cpuSample(
    previous: RawReading,
    raw: RawReading,
    loadText: string | null,
  ): HostSample["cpu"] {
    const load = loadText ? parseLoadAvg(loadText) : null;
    const loadMeasure = optional(load, "/proc/loadavg illisible.");
    if (!raw.stat) {
      const reason = "/proc/stat illisible.";
      return {
        cores: 0,
        usage: unavailable(reason),
        perCore: unavailable(reason),
        iowait: unavailable(reason),
        load: loadMeasure,
      };
    }
    const cores = raw.stat.cores.length;
    const before = previous.stat;
    if (!before) {
      const reason = "Premier relevé : delta CPU indisponible.";
      return {
        cores,
        usage: unavailable(reason),
        perCore: unavailable(reason),
        iowait: unavailable(reason),
        load: loadMeasure,
      };
    }
    const noDelta = "Compteurs CPU inchangés depuis le relevé précédent.";
    const perCore = raw.stat.cores.map((core, i) => {
      const prev = before.cores[i];
      return prev ? busyRatio(prev, core) : null;
    });
    return {
      cores,
      usage: optional(busyRatio(before.aggregate, raw.stat.aggregate), noDelta),
      perCore: perCore.every((v) => v !== null)
        ? measured(perCore as number[])
        : unavailable(noDelta),
      iowait: optional(iowaitRatio(before.aggregate, raw.stat.aggregate), noDelta),
      load: loadMeasure,
    };
  }

  private async diskSample(mount: string): Promise<DiskSample> {
    const usage = await this.source.diskUsage(mount);
    return {
      mount,
      capacity: usage
        ? measured(capacityOf(usage.total, usage.available))
        : unavailable(`Point de montage ${mount} illisible.`),
    };
  }

  private async containerSample(mem: MemInfo | null, hostCores: number): Promise<ContainerSample> {
    const [inContainer, maxText, currentText, cpuText] = await Promise.all([
      this.source.containerMarker(),
      this.source.readCgroup("memory.max"),
      this.source.readCgroup("memory.current"),
      this.source.readCgroup("cpu.max"),
    ]);
    const noCgroup = "cgroup v2 du processus illisible.";
    const memoryLimitBytes = cgroupMeasure(
      maxText ? parseCgroupBytes(maxText) : undefined,
      noCgroup,
    );
    const used = currentText ? parseCgroupBytes(currentText) : undefined;
    const memoryUsedBytes: Measured<number> =
      typeof used === "number" ? measured(used) : unavailable(noCgroup);
    const cpuLimitCores = cgroupMeasure(cpuText ? parseCpuMax(cpuText) : undefined, noCgroup);

    const memoryBounded =
      memoryLimitBytes.available &&
      memoryLimitBytes.value !== null &&
      mem !== null &&
      memoryLimitBytes.value < mem.memTotal;
    const cpuBounded =
      cpuLimitCores.available && cpuLimitCores.value !== null && cpuLimitCores.value < hostCores;
    return {
      inContainer,
      memoryLimitBytes,
      memoryUsedBytes,
      cpuLimitCores,
      differsFromHost: Boolean(memoryBounded || cpuBounded),
    };
  }

  private async networkSample(
    previous: RawReading,
    raw: RawReading,
  ): Promise<HostSample["network"]> {
    const seconds = (raw.at - previous.at) / 1000;
    const before = new Map(previous.net.map((c) => [c.name, c]));
    const noDelta = "Premier relevé ou compteur réinitialisé.";
    const interfaces: NetworkInterfaceSample[] = await Promise.all(
      raw.net.map(async (counter) => {
        const prev = before.get(counter.name);
        const speed = await this.source.linkSpeed(counter.name);
        return {
          name: counter.name,
          rxBytesPerSec: optional(
            prev ? ratePerSecond(prev.rxBytes, counter.rxBytes, seconds) : null,
            noDelta,
          ),
          txBytesPerSec: optional(
            prev ? ratePerSecond(prev.txBytes, counter.txBytes, seconds) : null,
            noDelta,
          ),
          linkSpeedBitsPerSec: optional(speed, "Débit de lien non annoncé par le noyau (VM)."),
        };
      }),
    );
    if (interfaces.length === 0) {
      const reason = "Aucune interface physique lisible dans /proc/net/dev.";
      return {
        rxBytesPerSec: unavailable(reason),
        txBytesPerSec: unavailable(reason),
        interfaces,
      };
    }
    return {
      rxBytesPerSec: sumMeasured(
        interfaces.map((i) => i.rxBytesPerSec),
        noDelta,
      ),
      txBytesPerSec: sumMeasured(
        interfaces.map((i) => i.txBytesPerSec),
        noDelta,
      ),
      interfaces,
    };
  }
}

function memorySample(mem: MemInfo | null): Pick<HostSample, "memory" | "swap"> {
  if (!mem) {
    const reason = "/proc/meminfo illisible.";
    return { memory: unavailable(reason), swap: unavailable(reason) };
  }
  return {
    memory: measured(capacityOf(mem.memTotal, mem.memAvailable)),
    swap: measured(capacityOf(mem.swapTotal, mem.swapFree)),
  };
}

function processSample(
  previous: RawReading,
  raw: RawReading,
  loadText: string | null,
  cores: number,
): ProcessSample {
  const tasks = loadText ? parseLoadAvgTasks(loadText) : null;
  const noTasks = "/proc/loadavg illisible.";
  let icos: ProcessSample["icos"] = unavailable("Mesure du processus ICOS indisponible.");
  if (raw.process) {
    const elapsedMicros = (raw.at - previous.at) * 1000;
    const cpuRatio =
      previous.process && elapsedMicros > 0 && cores > 0
        ? Math.min(
            1,
            Math.max(
              0,
              (raw.process.cpuMicros - previous.process.cpuMicros) / (elapsedMicros * cores),
            ),
          )
        : null;
    icos = measured({
      rssBytes: raw.process.rssBytes,
      heapUsedBytes: raw.process.heapUsedBytes,
      cpuRatio,
    });
  }
  return {
    runnable: optional(tasks?.runnable ?? null, noTasks),
    total: optional(tasks?.total ?? null, noTasks),
    icos,
  };
}

/**
 * Services observables depuis ce processus même. Les dépendances externes
 * (PostgreSQL, OmniRoute, runtime…) sont sondées par `service-probes`.
 */
function localServices(sample: HostSample): ServiceHealth[] {
  const core = [
    sample.cpu.usage,
    sample.memory,
    sample.swap,
    sample.uptimeSeconds,
    ...sample.disks.map((d) => d.capacity),
  ];
  const unreadable = core.filter((m) => !m.available).length;
  const at = sample.at;
  const collector =
    unreadable === 0
      ? {
          state: "operational" as const,
          detail: "Toutes les sources noyau essentielles sont lisibles.",
        }
      : {
          state: "degraded" as const,
          detail: `${unreadable} source(s) noyau illisible(s) : voir les métriques indisponibles.`,
        };
  return [
    {
      key: "cockpit-api",
      label: "API Cockpit ICOS",
      state: "operational",
      detail: "A servi cette mesure à une session authentifiée.",
      source: "ce processus Next.js",
      process: { state: "operational", detail: "Processus serveur ICOS en cours d'exécution." },
      availability: {
        state: "operational",
        detail: "A servi cette mesure à une session authentifiée.",
      },
      mission: null,
      checkedAt: at,
    },
    {
      key: "telemetry",
      label: "Collecteur de télémétrie",
      ...collector,
      source: "/proc, /sys et statfs (lecture seule)",
      process: { state: "operational", detail: "Collecteur intégré au processus ICOS." },
      availability: collector,
      mission: null,
      checkedAt: at,
    },
  ];
}

function cgroupMeasure(value: number | null | undefined, reason: string): Measured<number | null> {
  return value === undefined ? unavailable(reason) : measured(value);
}

function optional<T>(value: T | null, reason: string): Measured<T> {
  return value === null ? unavailable(reason) : measured(value);
}

function sumMeasured(values: Measured<number>[], reason: string): Measured<number> {
  if (!values.every((v) => v.available)) return unavailable(reason);
  return measured(values.reduce((acc, v) => acc + (v.available ? v.value : 0), 0));
}

function valueOr<T>(m: Measured<T>): T | null {
  return m.available ? m.value : null;
}

function historyPoint(sample: HostSample): HostHistoryPoint {
  const root = sample.disks[0]?.capacity;
  return {
    at: sample.at,
    cpu: valueOr(sample.cpu.usage),
    memory: sample.memory.available ? sample.memory.value.ratio : null,
    swap: sample.swap.available && sample.swap.value.total > 0 ? sample.swap.value.ratio : null,
    disk: root?.available ? root.value.ratio : null,
    rxBytesPerSec: valueOr(sample.network.rxBytesPerSec),
    txBytesPerSec: valueOr(sample.network.txBytesPerSec),
  };
}

const SAMPLER_KEY = "__icosHostTelemetrySampler__";

type GlobalWithSampler = typeof globalThis & { [SAMPLER_KEY]?: HostTelemetrySampler };

/** Instance unique par processus (survit au rechargement à chaud de Next). */
export function getHostTelemetrySampler(): HostTelemetrySampler {
  const globalRef = globalThis as GlobalWithSampler;
  globalRef[SAMPLER_KEY] ??= new HostTelemetrySampler();
  return globalRef[SAMPLER_KEY];
}

export function setHostTelemetrySamplerForTests(sampler: HostTelemetrySampler | null): void {
  const globalRef = globalThis as GlobalWithSampler;
  if (sampler) globalRef[SAMPLER_KEY] = sampler;
  else delete globalRef[SAMPLER_KEY];
}
