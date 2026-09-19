import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { TaskExecutionResult } from "@/core/contracts/task-execution";
import type { MissionMemoryInputRaw, ProceduralObservationRaw } from "@/core/memory";

/**
 * Mappers PURS des contrats existants vers des entrées mémoire. Aucun I/O, aucune
 * dépendance au Scheduler : n'importe quel composant (QC, mission service, futur
 * scheduler 7A) peut les appeler puis passer le résultat aux stores.
 *
 * Minimisation : on ne recopie JAMAIS `artifacts[].metadata`, ni les query strings d'URL
 * (URL signées), ni le `result` complet (résumé tronqué).
 */

const SUMMARY_MAX = 500;
const trunc = (s: string, n = SUMMARY_MAX) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const OBSERVED = { value: 1, basis: "observed" as const };

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export function executionResultToMissionMemory(
  missionId: string,
  missionTaskId: string | undefined,
  r: TaskExecutionResult,
): MissionMemoryInputRaw[] {
  const base = {
    missionId,
    ...(missionTaskId ? { missionTaskId } : {}),
    provenance: { sourceType: "execution_result" as const, sourceId: r.id },
    occurredAt: r.completedAt,
    confidence: OBSERVED,
  };
  const findings = { PASS: 0, WARN: 0, BLOCK: 0 };
  for (const f of r.findings ?? []) findings[f.severity]++;
  const common = {
    workerKind: r.workerKind ?? null,
    capability: r.capability ?? null,
    workflowId: r.workflowId,
  };

  const entries: MissionMemoryInputRaw[] =
    r.outcome === "success"
      ? [
          {
            ...base,
            kind: "result",
            title: trunc(`${r.capability ?? "task"} succeeded`, 200),
            summary: trunc(r.result?.trim() || "Execution succeeded"),
            payload: { outcome: "success", ...common, findings },
          },
        ]
      : [
          {
            ...base,
            kind: "error",
            title: trunc(`${r.capability ?? "task"} failed: ${r.error?.code ?? "UNKNOWN"}`, 200),
            summary: trunc(r.error?.message ?? "Execution failed"),
            payload: {
              outcome: "failure",
              code: r.error?.code ?? "INTERNAL_ERROR",
              ...common,
              findings,
            },
          },
        ];

  if (r.artifacts?.length) {
    entries.push({
      ...base,
      kind: "artifact",
      title: trunc(`${r.artifacts.length} artifact(s) produced`, 200),
      summary: trunc(r.artifacts.map((a) => a.type).join(", ")),
      payload: {
        artifacts: r.artifacts.map((a) => ({
          type: a.type,
          ...(a.path ? { path: a.path } : {}),
          ...(a.url ? { url: stripQuery(a.url) } : {}),
        })),
      },
    });
  }
  return entries;
}

export function reviewDecisionToMissionMemory(
  d: ReviewDecisionRecord,
  missionTaskId?: string,
): MissionMemoryInputRaw[] {
  const base = {
    missionId: d.missionId,
    ...(missionTaskId ? { missionTaskId } : {}),
    provenance: { sourceType: "review_decision" as const, sourceId: d.id },
    occurredAt: d.createdAt,
    confidence: { value: d.confidence ?? 1, basis: "observed" as const },
  };
  const entries: MissionMemoryInputRaw[] = [
    {
      ...base,
      kind: "review",
      title: trunc(`Review: ${d.decision}`, 200),
      summary: trunc(d.reasons.join("; ")),
      payload: {
        decision: d.decision,
        reviewerKind: d.reviewerKind,
        severity: d.severity,
        reasons: d.reasons,
        policyRefs: d.policyRefs ?? [],
        taskId: d.taskId,
        workflowId: d.workflowId,
      },
    },
  ];
  if (d.decision === "RETRY") {
    entries.push({
      ...base,
      kind: "retry",
      title: "Retry requested by review",
      summary: trunc(d.reasons.join("; ")),
      payload: { taskId: d.taskId, workflowId: d.workflowId, reasons: d.reasons },
    });
  }
  return entries;
}

export function missionObjectiveToMemory(m: {
  id: string;
  title: string;
  objective: string;
  createdAt: string;
}): MissionMemoryInputRaw {
  return {
    missionId: m.id,
    kind: "objective",
    title: trunc(m.title, 200),
    summary: trunc(m.objective, 2_000),
    payload: {},
    provenance: { sourceType: "mission", sourceId: m.id },
    occurredAt: m.createdAt,
    confidence: OBSERVED,
  };
}

export function missionPlanToMemory(
  missionId: string,
  planId: string,
  at: string,
  tasks: readonly {
    id: string;
    title: string;
    dependsOn: readonly string[];
    capability?: string | null;
    workerKind?: string | null;
  }[],
): MissionMemoryInputRaw {
  return {
    missionId,
    kind: "plan",
    title: `Plan ${planId}`,
    summary: trunc(tasks.map((t) => t.title).join(" → "), 2_000),
    payload: {
      taskCount: tasks.length,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dependsOn: [...t.dependsOn],
        capability: t.capability ?? null,
        workerKind: t.workerKind ?? null,
      })),
    },
    provenance: { sourceType: "mission_plan", sourceId: planId },
    occurredAt: at,
    confidence: OBSERVED,
  };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function terminalStateToMemory(a: {
  missionId: string;
  status: string;
  at: string;
  sourceId: string;
}): MissionMemoryInputRaw {
  if (!TERMINAL.has(a.status)) throw new RangeError(`statut non terminal : ${a.status}`);
  return {
    missionId: a.missionId,
    kind: "terminal_state",
    title: `Mission ${a.status}`,
    summary: `Mission reached terminal state '${a.status}'`,
    payload: { status: a.status },
    provenance: { sourceType: "mission", sourceId: a.sourceId },
    occurredAt: a.at,
    confidence: OBSERVED,
  };
}

/** Observations procédurales dérivées d'un résultat d'exécution (stratégie + erreur récurrente). */
export function executionResultToObservations(
  missionId: string,
  r: TaskExecutionResult,
): ProceduralObservationRaw[] {
  const scope = r.capability
    ? { scope: "capability" as const, scopeKey: r.capability }
    : r.workerKind
      ? { scope: "worker_kind" as const, scopeKey: r.workerKind }
      : undefined;
  if (!scope) return [];
  const signature = `${r.capability ?? "*"}|${r.workerKind ?? "unknown"}`;
  const base = {
    ...scope,
    outcome: r.outcome,
    provenance: { sourceType: "execution_result" as const, sourceId: r.id },
    missionId,
    occurredAt: r.completedAt,
  };
  const out: ProceduralObservationRaw[] = [
    {
      ...base,
      kind: "strategy",
      signature,
      title: trunc(`${r.capability ?? r.workerKind} via ${r.workerKind ?? "unknown"}`, 200),
      summary: `Observed ${r.outcome} for ${signature}`,
      payload: { capability: r.capability ?? null, workerKind: r.workerKind ?? null },
    },
  ];
  if (r.outcome === "failure" && r.error) {
    out.push({
      ...base,
      kind: "recurring_error",
      signature: `${signature}|${r.error.code}`,
      title: trunc(`${signature} fails with ${r.error.code}`, 200),
      summary: trunc(r.error.message),
      payload: { code: r.error.code },
    });
  }
  return out;
}
