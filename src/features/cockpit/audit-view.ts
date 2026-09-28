import type { AuditEntry } from "@/core/contracts";

import { toTimeline, type TimelineEntry, type Tone } from "./snapshot";

/**
 * Audit timeline query over the canonical audit log (already scope-filtered by
 * load.ts). Pagination keeps the page bounded however large the log grows.
 * ponytail: filters in memory after a full read; move to AuditRepository
 * cursor queries (BR-01) once the log is large.
 */
export interface AuditFilter {
  eventType?: string;
  actorKind?: string;
  taskId?: string;
  /** Canonical task ids of a mission (resolved by the caller). */
  missionTaskIds?: ReadonlySet<string>;
  tone?: Tone;
  page?: number;
}

export const AUDIT_PAGE_SIZE = 50;

export function queryAudit(
  entries: readonly AuditEntry[],
  filter: AuditFilter,
): { rows: TimelineEntry[]; total: number; page: number; pages: number; eventTypes: string[] } {
  const all = toTimeline(entries);
  const rows = all.filter(
    (e) =>
      (!filter.eventType || e.type === filter.eventType) &&
      (!filter.actorKind || e.actorKind === filter.actorKind) &&
      (!filter.taskId || e.taskId === filter.taskId) &&
      (!filter.missionTaskIds || (e.taskId !== null && filter.missionTaskIds.has(e.taskId))) &&
      (!filter.tone || e.tone === filter.tone),
  );
  const pages = Math.max(1, Math.ceil(rows.length / AUDIT_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.floor(filter.page ?? 1)), pages);
  return {
    rows: rows.slice((page - 1) * AUDIT_PAGE_SIZE, page * AUDIT_PAGE_SIZE),
    total: rows.length,
    page,
    pages,
    eventTypes: [...new Set(all.map((e) => e.type))].sort(),
  };
}
