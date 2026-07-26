// ─────────────────────────────────────
// Format utilities — pure functions, no dependencies
// ─────────────────────────────────────

/**
 * Format bytes to a human-readable string.
 * Uses binary units (KiB, MiB) displayed as "Ko", "Mo" (French convention).
 *
 * @param bytes - raw byte count (non-negative integer)
 * @returns formatted string, e.g. "3.2 Ko", "1.1 Mo"
 */
export function formatSizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 o";
  if (bytes === 0) return "0 o";

  const units = ["o", "Ko", "Mo", "Go", "To"];
  const base = 1024;
  let unitIndex = 0;
  let value = bytes;

  while (value >= base && unitIndex < units.length - 1) {
    value /= base;
    unitIndex++;
  }

  // Display: integer for bytes, 1 decimal for KiB+ and < 10, else 0 decimals
  if (unitIndex === 0) {
    return `${Math.round(value)} o`;
  }
  if (value < 10) {
    return `${value.toFixed(1)} ${units[unitIndex]}`;
  }
  return `${Math.round(value)} ${units[unitIndex]}`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Output is in French: "2 min 30", "12 s", "1 h 5 min".
 *
 * @param ms - duration in milliseconds (non-negative)
 * @returns formatted string
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 s";

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds === 0) return "0 s";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours} h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes} min`);
  }
  if (seconds > 0 && hours === 0) {
    // Only show seconds when total < 1 hour
    parts.push(`${seconds} s`);
  }

  return parts.join(" ") || "0 s";
}

/**
 * Format an ISO 8601 timestamp as a relative time string in French.
 * Uses `Intl.RelativeTimeFormat` with `{ numeric: "auto" }`.
 *
 * @param isoString - ISO 8601 datetime string
 * @returns relative time string, e.g. "il y a 1 heure", "il y a 30 s"
 */
export function formatRelativeTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "";

  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSeconds = Math.floor(Math.abs(diffMs) / 1000);

  const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });

  if (diffSeconds < 60) {
    return rtf.format(-diffSeconds, "seconds");
  }
  if (diffSeconds < 3600) {
    return rtf.format(-Math.floor(diffSeconds / 60), "minutes");
  }
  if (diffSeconds < 86400) {
    return rtf.format(-Math.floor(diffSeconds / 3600), "hours");
  }
  if (diffSeconds < 2592000) {
    return rtf.format(-Math.floor(diffSeconds / 86400), "days");
  }
  if (diffSeconds < 31536000) {
    return rtf.format(-Math.floor(diffSeconds / 2592000), "months");
  }
  return rtf.format(-Math.floor(diffSeconds / 31536000), "years");
}

/**
 * Format a step count as "N/M étapes".
 *
 * @param completed - number of completed steps
 * @param total - total number of steps
 * @returns formatted string, e.g. "3/5 étapes"
 */
export function formatStepCount(completed: number, total: number): string {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return "";
  const c = Math.max(0, Math.min(completed, total));
  return `${c}/${total} étapes`;
}
