import type { AuditEntry } from "@/core/contracts/audit";
import type { DispatchAttemptRepository } from "@/core/contracts/dispatch-attempt";
import type { QualityControlRepository } from "@/core/contracts/quality-control";
import type { MissionRepository } from "@/server/mission/ports";
import { SPEND_LEDGER_TENANT_ID } from "@/server/budget/compose-spend";
import { PostgresSpendLedger, type MissionSpend } from "@/server/budget/postgres-spend-ledger";
import type { Container } from "@/server/container";
import type {
  AuditRepository,
  GoalRepository,
  TaskExecutionResultRepository,
} from "@/server/repositories/ports";
import type { ReviewDecisionRepository } from "@/server/review/review-decision-repository";
import { RISK_GATE_DETAILS_KEY } from "@/server/supervisor/task-risk-gate";
import type { Workspace } from "@/server/workspace-manager/types";

/**
 * MISSION TRACE — the ordered decision history of ONE mission and the cost spent for it.
 *
 * READ-ONLY. It composes the existing repositories (no new table, no second registry) and
 * writes nothing: the audit journal, the dispatch ledger, the execution results, the review
 * decisions, the QC jobs, the workspace registry and the spend ledger are each asked what
 * THEY recorded, and the answers are merged on their own timestamps.
 *
 * Steps, by kind:
 *   goal.approval      the human approval recorded on the goal (`metadata.approvedBy`)
 *   task.created       a canonical task of the plan
 *   risk-gate          a task parked by the dispatch risk gate (verdict, classes, policy)
 *   approval           a human released a parked task (fingerprint-bound)
 *   dispatch           a dispatch attempt (worker, state, failure class)
 *   execution          the worker's durable result (outcome, actual model)
 *   review             the canonical review decision (decision, reviewer kind/model)
 *   qc                 the QC job's applied action / escalation
 *   gate               the governed workspace's gate/integration state
 *   task.settled       a task's terminal transition (succeeded/failed/cancelled/escalated)
 *   mission.settled    the mission's terminal transition
 *   task.transitioned  any other audited task transition
 *
 * An absent source is reported as such (`sources`), never as an empty history.
 */

export type MissionTraceStepKind =
  | "goal.approval"
  | "task.created"
  | "risk-gate"
  | "approval"
  | "dispatch"
  | "execution"
  | "review"
  | "qc"
  | "gate"
  | "task.settled"
  | "mission.settled"
  | "task.transitioned"
  | "audit";

export interface MissionTraceStep {
  readonly at: string;
  readonly kind: MissionTraceStepKind;
  readonly taskId?: string;
  readonly workflowId?: string;
  /** One line, for humans. */
  readonly summary: string;
  readonly details: Record<string, unknown>;
}

export interface MissionTrace {
  readonly mission: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly goalId: string | null;
  };
  readonly tasks: ReadonlyArray<{
    readonly missionTaskId: string;
    readonly taskId: string;
    readonly title: string;
    readonly status: string;
  }>;
  readonly steps: readonly MissionTraceStep[];
  readonly cost: MissionSpend | { readonly unavailable: string };
  /** Which sources were read. A missing one is named here rather than silently empty. */
  readonly sources: Record<string, "read" | "unavailable">;
}

export interface MissionTraceDeps {
  missions: Pick<MissionRepository, "findById" | "listTasks">;
  audit: Pick<AuditRepository, "query">;
  dispatchAttempts?: Pick<DispatchAttemptRepository, "listByMission">;
  executionResults?: Pick<TaskExecutionResultRepository, "listByTaskIds">;
  reviewDecisions?: Pick<ReviewDecisionRepository, "listByMissionId">;
  qualityControl?: Pick<QualityControlRepository, "getByWorkflowId">;
  goals?: Pick<GoalRepository, "getById">;
  workspaces?: { list(): Promise<Workspace[]> };
  spend?: {
    listForMission(missionId: string, options?: { goalId?: string | null }): Promise<MissionSpend>;
  };
}

/** Steps sharing a timestamp keep the causal order of the pipeline. */
const KIND_RANK: Record<MissionTraceStepKind, number> = {
  "goal.approval": 0,
  "task.created": 1,
  "risk-gate": 2,
  approval: 3,
  "task.transitioned": 4,
  dispatch: 5,
  execution: 6,
  review: 7,
  qc: 8,
  gate: 9,
  "task.settled": 10,
  "mission.settled": 11,
  audit: 12,
};

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

function auditStep(entry: AuditEntry): MissionTraceStep {
  const d = entry.details as Record<string, unknown>;
  const base = {
    at: entry.occurredAt,
    ...(entry.taskId ? { taskId: entry.taskId } : {}),
    ...(typeof d.workflowId === "string" ? { workflowId: d.workflowId } : {}),
    details: { ...d, actor: entry.actor, auditId: entry.id },
  };
  const gate = d[RISK_GATE_DETAILS_KEY] as Record<string, unknown> | undefined;

  if (entry.eventType === "mission.transitioned") {
    return {
      ...base,
      kind: "mission.settled",
      summary: `mission ${d.from} → ${d.to} (${d.cause ?? "?"})`,
    };
  }
  if (entry.eventType === "task.created") {
    return { ...base, kind: "task.created", summary: "task created" };
  }
  if (entry.eventType === "task.execution.completed") {
    return { ...base, kind: "audit", summary: `execution callback recorded (${d.outcome})` };
  }
  if (entry.eventType === "task.transitioned") {
    /* The park writes draft→queued→awaiting_approval, both carrying the verdict: one verdict. */
    if (gate && gate.decision === "APPROVAL_REQUIRED" && d.to === "awaiting_approval") {
      return {
        ...base,
        kind: "risk-gate",
        summary: `risk gate: APPROVAL_REQUIRED (${String(gate.riskClass ?? "unclassified")})`,
      };
    }
    if (gate && gate.decision === "APPROVED") {
      return {
        ...base,
        kind: "approval",
        summary: `approved by ${entry.actor.kind}:${entry.actor.id}`,
      };
    }
    if (d.terminal === true) {
      return {
        ...base,
        kind: "task.settled",
        summary: `task ${d.from} → ${d.to} [${d.outcome ?? d.to}]${d.cause ? ` (${d.cause})` : ""}`,
      };
    }
    return { ...base, kind: "task.transitioned", summary: `task ${d.from} → ${d.to}` };
  }
  return { ...base, kind: "audit", summary: entry.eventType };
}

/**
 * The ordered decision history and attributed cost of `missionId`, or `null` if no such mission.
 */
export async function getMissionTrace(
  deps: MissionTraceDeps,
  missionId: string,
): Promise<MissionTrace | null> {
  const mission = await deps.missions.findById(missionId);
  if (!mission) return null;

  const missionTasks = await deps.missions.listTasks(missionId);
  const taskIds = [...new Set(missionTasks.map((t) => t.taskId))];
  const sources: Record<string, "read" | "unavailable"> = { audit: "read" };
  const steps: MissionTraceStep[] = [];

  /* Goal approval: what lets `always` cover the goal's reversible work (risk gate). */
  if (mission.goalId && deps.goals) {
    sources.goal = "read";
    const goal = await deps.goals.getById(mission.goalId);
    const approvedBy = goal?.goal.metadata?.approvedBy;
    if (goal && typeof approvedBy === "string" && approvedBy.length > 0) {
      steps.push({
        at: iso(goal.goal.createdAt),
        kind: "goal.approval",
        summary: `goal approved by ${approvedBy}`,
        details: {
          goalId: mission.goalId,
          approvedBy,
          humanApprovalPolicy: goal.goal.humanApprovalPolicy,
          riskLevel: goal.goal.riskLevel,
        },
      });
    }
  } else if (mission.goalId) {
    sources.goal = "unavailable";
  }

  /* The audit journal: per task, plus the mission's own entries. Deduplicated by id. */
  const seen = new Set<string>();
  const entries: AuditEntry[] = [];
  for (const batch of [
    await deps.audit.query({ missionId }),
    ...(await Promise.all(taskIds.map((taskId) => deps.audit.query({ taskId })))),
  ]) {
    for (const entry of batch) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  steps.push(...entries.map(auditStep));

  /* Dispatch attempts: every attempt, every state. */
  const workflowIds: string[] = [];
  if (deps.dispatchAttempts?.listByMission) {
    sources.dispatchAttempts = "read";
    for (const a of await deps.dispatchAttempts.listByMission(missionId)) {
      workflowIds.push(a.workflowId);
      steps.push({
        at: iso(a.dispatchedAt ?? a.createdAt),
        kind: "dispatch",
        taskId: a.taskId,
        workflowId: a.workflowId,
        summary: `dispatch attempt ${a.attempt} → ${a.workerId ?? a.workerKind ?? "unrouted"} [${a.state}]`,
        details: {
          attempt: a.attempt,
          state: a.state,
          workerKind: a.workerKind ?? null,
          workerId: a.workerId ?? null,
          capability: a.capability ?? null,
          failureClass: a.failureClass ?? null,
          lastError: a.lastError ?? null,
          routingDecision: a.routingDecision ?? null,
        },
      });
    }
  } else {
    sources.dispatchAttempts = "unavailable";
  }

  /* Durable execution results. */
  if (deps.executionResults && taskIds.length > 0) {
    sources.executionResults = "read";
    for (const r of await deps.executionResults.listByTaskIds(taskIds)) {
      if (!workflowIds.includes(r.workflowId)) workflowIds.push(r.workflowId);
      steps.push({
        at: r.completedAt,
        kind: "execution",
        taskId: r.taskId,
        workflowId: r.workflowId,
        summary: `execution ${r.outcome}${r.actualModel ? ` (${r.actualModel})` : ""}`,
        details: {
          outcome: r.outcome,
          workerKind: r.workerKind ?? null,
          actualExecutor: r.actualExecutor ?? null,
          actualProvider: r.actualProvider ?? null,
          actualModel: r.actualModel ?? null,
          errorCode: r.error?.code ?? null,
          startedAt: r.startedAt ?? null,
          recordedAt: r.recordedAt,
        },
      });
    }
  } else if (!deps.executionResults) {
    sources.executionResults = "unavailable";
  }

  /* Canonical review decisions (the reviewer's verdicts). */
  if (deps.reviewDecisions) {
    sources.reviewDecisions = "read";
    for (const r of await deps.reviewDecisions.listByMissionId(missionId)) {
      steps.push({
        at: r.createdAt,
        kind: "review",
        taskId: r.taskId,
        workflowId: r.workflowId,
        summary: `review ${r.decision} by ${r.reviewerKind}${r.providerMetadata?.model ? ` (${r.providerMetadata.model})` : ""}`,
        details: {
          decisionId: r.id,
          decision: r.decision,
          reviewerKind: r.reviewerKind,
          severity: r.severity,
          reasons: r.reasons,
          confidence: r.confidence ?? null,
          reviewerModel: r.providerMetadata?.model ?? null,
          reviewerProvider: r.providerMetadata?.provider ?? null,
        },
      });
    }
  } else {
    sources.reviewDecisions = "unavailable";
  }

  /* QC jobs, one per executed workflow. */
  if (deps.qualityControl) {
    sources.qualityControl = "read";
    for (const workflowId of workflowIds) {
      const job = await deps.qualityControl.getByWorkflowId(workflowId);
      if (!job) continue;
      steps.push({
        at: iso(job.updatedAt),
        kind: "qc",
        taskId: job.taskId,
        workflowId,
        summary: `qc ${job.action ?? "pending"} [${job.state}]`,
        details: {
          state: job.state,
          action: job.action ?? null,
          reviewDecisionId: job.reviewDecisionId ?? null,
          executionAttempt: job.executionAttempt,
          reviewAttemptCount: job.reviewAttemptCount,
          lastError: job.lastError ?? null,
        },
      });
    }
  } else {
    sources.qualityControl = "unavailable";
  }

  /* Governed workspaces: what the gate/integration left durably. */
  if (deps.workspaces) {
    sources.workspaces = "read";
    for (const ws of (await deps.workspaces.list()).filter((w) => w.missionId === missionId)) {
      steps.push({
        at: ws.releasedAt ?? ws.updatedAt,
        kind: "gate",
        ...(ws.taskId ? { taskId: ws.taskId } : {}),
        ...(ws.workflowId ? { workflowId: ws.workflowId } : {}),
        summary: `workspace ${ws.status}${ws.releasedAt ? " (released)" : ""}`,
        details: {
          workspaceId: ws.workspaceId,
          status: ws.status,
          branch: ws.branch,
          baseCommit: ws.baseCommit,
          sourceCommit: ws.sourceCommit,
          releasedAt: ws.releasedAt,
        },
      });
    }
  } else {
    sources.workspaces = "unavailable";
  }

  const ordered = steps
    .map((step, index) => ({ step, index }))
    .sort(
      (a, b) =>
        Date.parse(a.step.at) - Date.parse(b.step.at) ||
        KIND_RANK[a.step.kind] - KIND_RANK[b.step.kind] ||
        a.index - b.index,
    )
    .map(({ step }) => step);

  let cost: MissionTrace["cost"];
  if (deps.spend) {
    sources.spend = "read";
    cost = await deps.spend.listForMission(missionId, { goalId: mission.goalId ?? null });
  } else {
    sources.spend = "unavailable";
    cost = { unavailable: "NO_DURABLE_SPEND_LEDGER" };
  }

  return {
    mission: {
      id: mission.id,
      title: mission.title,
      status: mission.status,
      goalId: mission.goalId ?? null,
    },
    tasks: missionTasks.map((t) => ({
      missionTaskId: t.id,
      taskId: t.taskId,
      title: t.title,
      status: t.status,
    })),
    steps: ordered,
    cost,
    sources,
  };
}

/**
 * The trace's dependencies, from a composed container: the SAME repositories the runtime
 * writes through, and the durable spend ledger of the single tenant. Read-only use only.
 */
export function missionTraceDepsFromContainer(container: Container): MissionTraceDeps {
  return {
    missions: container.mission,
    audit: container.audit,
    dispatchAttempts: container.dispatchAttempts,
    executionResults: container.executionResults,
    reviewDecisions: container.reviewDecisions,
    qualityControl: container.qualityControlJobs,
    goals: container.goalRepository,
    ...(container.workspaceManager ? { workspaces: container.workspaceManager } : {}),
    ...(container.db
      ? {
          spend: new PostgresSpendLedger({
            db: container.db,
            tenantId: SPEND_LEDGER_TENANT_ID,
            /* Never consulted: the trace only READS the ledger. Refuses if it ever were. */
            caps: async () => {
              throw new Error("MISSION_TRACE_IS_READ_ONLY");
            },
          }),
        }
      : {}),
  };
}

/** The trace as a human-readable timeline (the `pnpm mission:trace` default output). */
export function formatMissionTrace(trace: MissionTrace): string {
  const lines: string[] = [];
  const m = trace.mission;
  lines.push(`mission ${m.id} [${m.status}] ${m.title}${m.goalId ? ` (goal ${m.goalId})` : ""}`);
  for (const t of trace.tasks) lines.push(`  task ${t.taskId} [${t.status}] ${t.title}`);
  lines.push("decisions:");
  for (const s of trace.steps) {
    lines.push(`  ${s.at}  ${s.kind.padEnd(17)} ${s.taskId ? `${s.taskId} ` : ""}${s.summary}`);
  }
  lines.push("cost:");
  if ("unavailable" in trace.cost) {
    lines.push(`  unavailable: ${trace.cost.unavailable}`);
  } else {
    for (const e of trace.cost.entries) {
      const tokens = e.totalTokens === null ? "unmetered" : `${e.totalTokens} tokens`;
      const amount =
        e.amount === null ? (e.costKind ?? "no cost") : `${e.amount} ${e.currency ?? ""}`.trim();
      lines.push(`  ${e.observedAt}  ${e.scope.padEnd(11)} ${e.modelId}  ${tokens}  ${amount}`);
    }
    const t = trace.cost.total;
    lines.push(
      `  mission total: ${t.calls} calls, ${t.totalTokens} tokens (prompt ${t.promptTokens}, completion ${t.completionTokens}), ` +
        `${t.amount} ${t.currency} priced over ${t.pricedCalls} calls, ${t.unpricedCalls} unpriced, ${t.unmeteredCalls} unmetered`,
    );
    const g = trace.cost.goalShared;
    if (g.calls > 0) {
      lines.push(
        `  goal-shared (not attributable to this mission): ${g.calls} calls, ${g.totalTokens} tokens`,
      );
    }
  }
  const missing = Object.entries(trace.sources).filter(([, v]) => v === "unavailable");
  if (missing.length > 0) lines.push(`sources unavailable: ${missing.map(([k]) => k).join(", ")}`);
  return lines.join("\n");
}
