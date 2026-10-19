import type { HealthTone, Measured, ServiceState } from "@/core/telemetry";

/** Libellé affiché pour toute métrique non mesurée — jamais de valeur fictive. */
export const UNAVAILABLE_LABEL = "Indisponible";
export const NOT_INSTRUMENTED_LABEL = "Non instrumentée";

const BYTE_UNITS = ["o", "Kio", "Mio", "Gio", "Tio"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return UNAVAILABLE_LABEL;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(".", ",")} ${BYTE_UNITS[unit]}`;
}

/** Débit réseau : octets/s affichés en bits/s (convention réseau). */
export function formatBitRate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return UNAVAILABLE_LABEL;
  const bits = bytesPerSecond * 8;
  const units = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"] as const;
  let value = bits;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace(".", ",")} ${units[unit]}`;
}

export function formatPercent(ratio: number, digits = 0): string {
  if (!Number.isFinite(ratio)) return UNAVAILABLE_LABEL;
  return `${(ratio * 100).toFixed(digits).replace(".", ",")} %`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return UNAVAILABLE_LABEL;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

export function formatClock(iso: string | number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE_LABEL;
  return date.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Valeur formatée ou « Indisponible » — point unique du rendu d'une mesure. */
export function show<T>(m: Measured<T>, format: (value: T) => string): string {
  return m.available ? format(m.value) : UNAVAILABLE_LABEL;
}

export const TONE_LABEL: Record<HealthTone, string> = {
  ok: "Normal",
  degraded: "Avertissement",
  incident: "Incident",
  improve: "Recommandation",
};

/** Icône textuelle : l'état n'est jamais porté par la seule couleur. */
export const TONE_ICON: Record<HealthTone, string> = {
  ok: "●",
  degraded: "▲",
  incident: "■",
  improve: "◆",
};

export const SERVICE_LABEL: Record<ServiceState, string> = {
  operational: "Opérationnel",
  degraded: "Dégradé",
  down: "Indisponible",
  not_instrumented: "Non instrumenté",
  not_connected: "Environnement non connecté",
};

export const SERVICE_TONE: Record<ServiceState, HealthTone | "muted"> = {
  operational: "ok",
  degraded: "degraded",
  down: "incident",
  not_instrumented: "muted",
  not_connected: "muted",
};
