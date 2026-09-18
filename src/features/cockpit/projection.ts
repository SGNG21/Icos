import type { Agent, Task, TaskExecutionResult, TaskStatus } from "@/core/contracts";

/**
 * Projection MÉTIER d'une tâche pour le Cockpit. Ne contient aucune mécanique
 * Temporal au premier plan : `workflowId` est relégué au diagnostic.
 */
export interface TaskProjection {
  task: Task;
  agentName: string | null;
  execution: TaskExecutionResult | null;
  /** Résumé court affichable en liste (résultat ou erreur). */
  summary: string | null;
  /** Vrai si la tâche exige une attention humaine (échec ou approbation). */
  needsAttention: boolean;
}

/** Regroupement opérationnel du Cockpit. */
export interface CockpitProjection {
  activeWork: TaskProjection[];
  attentionRequired: TaskProjection[];
  recentResults: TaskProjection[];
  counts: Record<TaskStatus, number>;
}

const ACTIVE_STATUSES: readonly TaskStatus[] = [
  "queued",
  "running",
  "review_pending",
  "awaiting_approval",
];
const TERMINAL_STATUSES: readonly TaskStatus[] = ["succeeded", "failed", "cancelled"];

/** Réduit un texte long à un résumé affichable, sans couper un mot brutalement. */
export function summarize(text: string, maxLength = 160): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function projectTask(
  task: Task,
  agents: readonly Agent[],
  executions: ReadonlyMap<string, TaskExecutionResult>,
): TaskProjection {
  const execution = executions.get(task.id) ?? null;
  const agent = task.assignedAgentId
    ? (agents.find((candidate) => candidate.id === task.assignedAgentId) ?? null)
    : null;

  let summary: string | null = null;
  if (execution?.outcome === "failure" && execution.error) {
    summary = summarize(execution.error.message);
  } else if (execution?.result) {
    summary = summarize(execution.result);
  }

  return {
    task,
    agentName: agent?.name ?? null,
    execution,
    summary,
    needsAttention: task.status === "failed" || task.status === "awaiting_approval",
  };
}

/**
 * Construit la projection du Cockpit à partir de l'état canonique ICOS.
 * Tri déterministe : plus récemment mis à jour en premier.
 */
export function buildCockpitProjection(input: {
  tasks: readonly Task[];
  agents: readonly Agent[];
  executions: readonly TaskExecutionResult[];
}): CockpitProjection {
  const byTask = new Map(input.executions.map((record) => [record.taskId, record]));
  const projections = input.tasks
    .map((task) => projectTask(task, input.agents, byTask))
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));

  const counts = {
    draft: 0,
    queued: 0,
    awaiting_approval: 0,
    running: 0,
    review_pending: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  } satisfies Record<TaskStatus, number>;
  for (const projection of projections) {
    counts[projection.task.status] += 1;
  }

  return {
    activeWork: projections.filter((p) => ACTIVE_STATUSES.includes(p.task.status)),
    attentionRequired: projections.filter((p) => p.needsAttention),
    recentResults: projections
      .filter((p) => TERMINAL_STATUSES.includes(p.task.status))
      .slice(0, 10),
    counts,
  };
}
