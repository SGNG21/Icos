import type { PerformanceObservation } from "./contracts";

/**
 * EMPIRICAL PERFORMANCE (decision 0057). Transparent aggregates only — no opaque ranking.
 * Every summary names the observations it was computed from, so any use of it in an
 * assignment decision can be audited back to facts. SIMULATED / NOT_CONNECTED facts are
 * excluded unless explicitly requested.
 */

export interface PerformanceFilter {
  agentId?: string;
  roleId?: string;
  skillId?: string;
  taskType?: string;
  includeNonReal?: boolean;
}

export interface PerformanceSummary {
  count: number;
  successes: number;
  successRate: number | null;
  firstPassApprovals: number;
  meanCorrections: number | null;
  meanLatencyMs: number | null;
  totalCostCents: number | null;
  failureClasses: Record<string, number>;
  observationIds: string[];
}

const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

export function summarizePerformance(
  observations: readonly PerformanceObservation[],
  filter: PerformanceFilter = {},
): PerformanceSummary {
  const rows = observations.filter(
    (o) =>
      (filter.includeNonReal || o.source === "REAL") &&
      (!filter.agentId || o.agentId === filter.agentId) &&
      (!filter.roleId || o.roleId === filter.roleId) &&
      (!filter.skillId || o.skillId === filter.skillId) &&
      (!filter.taskType || o.taskType === filter.taskType),
  );
  const costs = rows.flatMap((o) => (o.costCents === undefined ? [] : [o.costCents]));
  const failureClasses: Record<string, number> = {};
  for (const o of rows)
    if (o.failureClass) failureClasses[o.failureClass] = (failureClasses[o.failureClass] ?? 0) + 1;
  const successes = rows.filter((o) => o.success).length;
  return {
    count: rows.length,
    successes,
    // Unknown stays unknown: no rows → null, never 0 or 1.
    successRate: rows.length === 0 ? null : successes / rows.length,
    firstPassApprovals: rows.filter((o) => o.success && o.correctionCount === 0).length,
    meanCorrections: mean(rows.map((o) => o.correctionCount)),
    meanLatencyMs: mean(rows.flatMap((o) => (o.latencyMs === undefined ? [] : [o.latencyMs]))),
    // Cost is only summed when every row reports it; a partial sum would under-report.
    totalCostCents:
      rows.length > 0 && costs.length === rows.length ? costs.reduce((a, b) => a + b, 0) : null,
    failureClasses,
    observationIds: rows.map((o) => o.observationId).sort(),
  };
}
