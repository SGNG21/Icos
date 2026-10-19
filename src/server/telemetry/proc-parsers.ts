/**
 * Parseurs PURS des pseudo-fichiers Linux (/proc). Aucune commande shell : le
 * serveur lit des fichiers noyau en lecture seule, le navigateur ne reçoit que
 * des nombres agrégés.
 */

export interface CpuTimes {
  /** Jiffies totaux (hors guest, déjà inclus dans user/nice). */
  total: number;
  /** Jiffies inactifs (idle + iowait). */
  idle: number;
  iowait: number;
}

export interface ProcStat {
  aggregate: CpuTimes;
  cores: CpuTimes[];
}

function cpuTimesFrom(fields: number[]): CpuTimes {
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    fields;
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
    iowait,
  };
}

export function parseProcStat(text: string): ProcStat | null {
  let aggregate: CpuTimes | null = null;
  const cores: CpuTimes[] = [];
  for (const line of text.split("\n")) {
    const match = /^cpu(\d*)\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const fields = match[2]!.split(/\s+/).map(Number);
    if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) continue;
    const times = cpuTimesFrom(fields);
    if (match[1] === "") aggregate = times;
    else cores[Number(match[1])] = times;
  }
  if (!aggregate) return null;
  return { aggregate, cores: cores.filter(Boolean) };
}

/** Fraction occupée [0, 1] entre deux relevés ; null si le compteur n'a pas avancé. */
export function busyRatio(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  if (total <= 0) return null;
  const idle = current.idle - previous.idle;
  return clamp01(1 - idle / total);
}

export function iowaitRatio(previous: CpuTimes, current: CpuTimes): number | null {
  const total = current.total - previous.total;
  if (total <= 0) return null;
  return clamp01((current.iowait - previous.iowait) / total);
}

export interface MemInfo {
  memTotal: number;
  memAvailable: number;
  swapTotal: number;
  swapFree: number;
}

/** /proc/meminfo en octets. Exige MemAvailable (noyau ≥ 3.14). */
export function parseMemInfo(text: string): MemInfo | null {
  const values = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
    if (match) values.set(match[1]!, Number(match[2]) * 1024);
  }
  const memTotal = values.get("MemTotal");
  const memAvailable = values.get("MemAvailable");
  if (memTotal === undefined || memAvailable === undefined) return null;
  return {
    memTotal,
    memAvailable,
    swapTotal: values.get("SwapTotal") ?? 0,
    swapFree: values.get("SwapFree") ?? 0,
  };
}

export interface LoadAvg {
  one: number;
  five: number;
  fifteen: number;
}

export function parseLoadAvg(text: string): LoadAvg | null {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  if (![one, five, fifteen].every((n) => n !== undefined && Number.isFinite(n))) return null;
  return { one: one!, five: five!, fifteen: fifteen! };
}

export function parseUptime(text: string): number | null {
  const token = text.trim().split(/\s+/)[0];
  if (!token) return null;
  const seconds = Number(token);
  return Number.isFinite(seconds) ? seconds : null;
}

export interface NetCounters {
  name: string;
  rxBytes: number;
  txBytes: number;
}

/**
 * Interfaces virtuelles exclues du total : boucle locale, ponts/veth de
 * conteneurs et tunnels (Tailscale, WireGuard), qui re-comptent un trafic déjà
 * vu — encapsulé — sur l'interface physique.
 */
const VIRTUAL_INTERFACE =
  /^(lo|docker\d*|br-[0-9a-f]+|veth[0-9a-f]+|virbr\d+|cni\d*|flannel\.\d+|tailscale\d+|wg\d+)$/;

export function isPhysicalInterface(name: string): boolean {
  return !VIRTUAL_INTERFACE.test(name);
}

export function parseNetDev(text: string): NetCounters[] {
  const counters: NetCounters[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*([^:\s]+):\s*(.+)$/.exec(line);
    if (!match) continue;
    const fields = match[2]!.trim().split(/\s+/).map(Number);
    if (fields.length < 9) continue;
    const rxBytes = fields[0]!;
    const txBytes = fields[8]!;
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;
    counters.push({ name: match[1]!, rxBytes, txBytes });
  }
  return counters;
}

/** Débit en octets/s ; null si l'intervalle est nul ou si le compteur a été réinitialisé. */
export function ratePerSecond(previous: number, current: number, seconds: number): number | null {
  if (seconds <= 0 || current < previous) return null;
  return (current - previous) / seconds;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Ligne `some avg10=…` de /proc/pressure/* → ratio [0, 1]. */
export function parsePressureSome(text: string): number | null {
  const match = /^some\s+avg10=(\d+(?:\.\d+)?)/m.exec(text);
  if (!match) return null;
  return clamp01(Number(match[1]) / 100);
}

/** Champ 4 de /proc/loadavg : « exécutables/total ». */
export function parseLoadAvgTasks(text: string): { runnable: number; total: number } | null {
  const match = /^\S+\s+\S+\s+\S+\s+(\d+)\/(\d+)/.exec(text.trim());
  if (!match) return null;
  return { runnable: Number(match[1]), total: Number(match[2]) };
}

/**
 * Chemin cgroup v2 depuis /proc/self/cgroup (`0::/chemin`). Rejette tout
 * chemin non canonique : il sert à construire un chemin de lecture.
 */
export function parseCgroupV2Path(text: string): string | null {
  const match = /^0::(\/[A-Za-z0-9_.@:\/-]*)$/m.exec(text);
  if (!match) return null;
  const path = match[1]!;
  if (path.split("/").some((part) => part === "..")) return null;
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

/** `memory.max` / `memory.current` : octets, ou null pour « max ». */
export function parseCgroupBytes(text: string): number | null | undefined {
  const value = text.trim();
  if (value === "max") return null;
  if (!/^\d+$/.test(value)) return undefined;
  return Number(value);
}

/** `cpu.max` (« quota période ») → nombre de cœurs, ou null si non borné. */
export function parseCpuMax(text: string): number | null | undefined {
  const [quota, period] = text.trim().split(/\s+/);
  if (quota === "max") return null;
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0) return undefined;
  return q / p;
}
