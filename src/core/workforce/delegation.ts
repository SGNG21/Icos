import type {
  AgentRole,
  PerformanceObservation,
  ReviewOutcome,
  SkillDefinition,
  WorkAssignment,
  WorkforceAgent,
  WorkRequest,
} from "./contracts";
import {
  authorizeAssignment,
  isActive,
  isAssignmentTerminal,
  isAssignmentTransitionAllowed,
  scopeCovers,
  type GovernanceViolation,
  type Principal,
} from "./governance";

/**
 * GOVERNED DELEGATION (decision 0057).
 *
 *   mission → supervisor → capability decomposition → assignment → specialist execution
 *           → independent review → result → supervisor synthesis
 *
 * Pure transitions over `WorkAssignment`. Every step keeps mission/task/parent lineage, the
 * agent, the executing worker and its model/provider, the permissions held, the evidence and
 * the review. No anonymous work: an execution without a worker id does not parse.
 */

export type DelegationError =
  | GovernanceViolation
  | "INVALID_TRANSITION"
  | "APPROVAL_PENDING"
  | "APPROVER_NOT_AUTHORIZED"
  | "REVIEWER_NOT_INDEPENDENT"
  | "REVIEWER_NOT_QUALIFIED"
  | "NOT_THE_SUPERVISOR"
  | "CHILDREN_NOT_SETTLED"
  /* A withdrawal must say why: an unexplained cancellation is indistinguishable from a bug. */
  | "CANCELLATION_REASON_REQUIRED"
  | "NOTHING_TO_SYNTHESIZE";

export type Step<T> = { ok: true; value: T } | { ok: false; errors: DelegationError[] };
const fail = <T>(...errors: DelegationError[]): Step<T> => ({ ok: false, errors });

const RISK_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;

/** Capability that makes an agent eligible to review someone else's work. */
export const INDEPENDENT_REVIEW_CAPABILITY = "independent_review";

export interface OrgView {
  agents: readonly WorkforceAgent[];
  roles: readonly AgentRole[];
  skills: readonly SkillDefinition[];
  assignments: readonly WorkAssignment[];
}

export interface PlannedAssignment {
  request: WorkRequest;
  assigneeAgentId: string;
  skillId: string;
  requiresApproval: boolean;
  approvalReasons: string[];
  /** Why this assignee: open load, then agent id — stated, not scored. */
  reason: string;
  rejected: { agentId: string; violations: GovernanceViolation[] }[];
}

export interface DelegationGap {
  request: WorkRequest;
  /** No direct report can take it: spawn a specialist or compose a role (human decision). */
  reason: "NO_ELIGIBLE_REPORT";
  rejected: { agentId: string; violations: GovernanceViolation[] }[];
}

const openLoad = (agentId: string, assignments: readonly WorkAssignment[]) =>
  assignments.filter(
    (a) =>
      a.assigneeAgentId === agentId && !isAssignmentTerminal(a.status) && a.status !== "accepted",
  ).length;

/**
 * Plans delegation of `requests` to the supervisor's DIRECT reports. Each candidate goes
 * through `authorizeAssignment`; the first allowed one in (open load, agentId) order wins.
 */
export function planDelegation(input: {
  supervisor: WorkforceAgent;
  requests: readonly WorkRequest[];
  org: OrgView;
  now: string;
}): { planned: PlannedAssignment[]; gaps: DelegationGap[] } {
  const { supervisor, requests, org, now } = input;
  const planned: PlannedAssignment[] = [];
  const gaps: DelegationGap[] = [];
  // Load grows as we plan so one call does not pile everything on the same report.
  const pending: WorkAssignment[] = [...org.assignments];

  for (const request of requests) {
    const reports = org.agents
      .filter(
        (a) =>
          a.supervisorAgentId === supervisor.agentId &&
          a.tenantId === supervisor.tenantId &&
          /*
           * RÉDUCTION SEULE (verrou C6). Quand le Chief a nommé un cerveau, il est le SEUL
           * candidat — mais il subit ensuite exactement les mêmes contrôles de gouvernance
           * que tout le monde. Nommer restreint, n'autorise jamais : un nommé refusé
           * devient un gap, pas un remplacement discret.
           */
          (request.requiredAgentId === undefined || a.agentId === request.requiredAgentId),
      )
      .sort(
        (a, b) =>
          openLoad(a.agentId, pending) - openLoad(b.agentId, pending) ||
          a.agentId.localeCompare(b.agentId),
      );
    const rejected: { agentId: string; violations: GovernanceViolation[] }[] = [];
    let chosen: PlannedAssignment | null = null;

    for (const assignee of reports) {
      const role =
        org.roles.find((r) => r.roleId === assignee.roleId && r.version === assignee.roleVersion) ??
        null;
      const skill =
        org.skills
          .filter((s) => role?.skills.includes(s.skillId))
          // Lowest-risk covering skill first: fewer approval gates for the same capability.
          .sort(
            (a, b) => RISK_RANK[a.risk] - RISK_RANK[b.risk] || a.skillId.localeCompare(b.skillId),
          )
          .find((s) => request.requiredCapabilities.every((c) => s.capabilities.includes(c))) ??
        null;
      const verdict = authorizeAssignment({
        supervisor,
        assignee,
        role,
        skill,
        request,
        assigneeAssignments: pending.filter((a) => a.assigneeAgentId === assignee.agentId),
        now,
      });
      if (!verdict.allowed) {
        rejected.push({ agentId: assignee.agentId, violations: verdict.violations });
        continue;
      }
      chosen = {
        request,
        assigneeAgentId: assignee.agentId,
        skillId: skill!.skillId,
        requiresApproval: verdict.requiresApproval,
        approvalReasons: verdict.approvalReasons,
        reason: `open load ${openLoad(assignee.agentId, pending)}, then agent id`,
        rejected,
      };
      break;
    }

    if (!chosen) {
      gaps.push({ request, reason: "NO_ELIGIBLE_REPORT", rejected });
      continue;
    }
    planned.push(chosen);
    pending.push(placeholderLoad(chosen, supervisor));
  }
  return { planned, gaps };
}

function placeholderLoad(p: PlannedAssignment, supervisor: WorkforceAgent): WorkAssignment {
  return {
    assignmentId: `planned-${p.request.taskId}`,
    tenantId: supervisor.tenantId,
    missionId: p.request.missionId,
    taskId: p.request.taskId,
    parentAssignmentId: null,
    supervisorAgentId: supervisor.agentId,
    assigneeAgentId: p.assigneeAgentId,
    skillId: p.skillId,
    requiredCapabilities: [...p.request.requiredCapabilities],
    scope: { ...p.request.scope },
    computeUnits: p.request.computeUnits,
    permissionsSnapshot: { autonomyLevel: 0, toolIds: [] },
    status: "assigned",
    approval: { required: p.requiresApproval, reasons: p.approvalReasons },
    correctionCount: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    version: 1,
  };
}

/** Builds the assignment record for an AUTHORIZED plan item. */
export function buildAssignment(input: {
  assignmentId: string;
  plan: PlannedAssignment;
  supervisor: WorkforceAgent;
  assignee: WorkforceAgent;
  parentAssignmentId: string | null;
  now: string;
}): WorkAssignment {
  const { assignmentId, plan, supervisor, assignee, parentAssignmentId, now } = input;
  return {
    ...placeholderLoad(plan, supervisor),
    assignmentId,
    parentAssignmentId,
    permissionsSnapshot: {
      autonomyLevel: assignee.policy.autonomyLevel,
      toolIds: assignee.policy.toolGrants.map((g) => g.toolId).sort(),
    },
    createdAt: now,
    updatedAt: now,
  };
}

function move(
  a: WorkAssignment,
  to: WorkAssignment["status"],
  now: string,
  patch: Partial<WorkAssignment> = {},
) {
  return { ...a, ...patch, status: to, updatedAt: now, version: a.version + 1 };
}

/** A human holding `approvals.decide` (existing permission) releases a gated assignment. */
/**
 * The SUPERVISOR withdraws work it delegated.
 *
 * Only the delegant — a brain may not cancel its own assignment to escape review, and a
 * stranger may not cancel someone else's. Terminal stays terminal, so this is idempotent
 * in the way that matters: cancelling twice is refused, never silently re-applied.
 */
export function cancelAssignment(
  a: WorkAssignment,
  canceller: Principal,
  reason: string,
  now: string,
): Step<WorkAssignment> {
  if (canceller.tenantId !== a.tenantId) return fail("ACTOR_NOT_AUTHORIZED");
  if (canceller.kind !== "agent" || canceller.id !== a.supervisorAgentId) {
    return fail("NOT_THE_SUPERVISOR");
  }
  if (isAssignmentTerminal(a.status)) return fail("TERMINAL_STATUS");
  if (!reason.trim()) return fail("CANCELLATION_REASON_REQUIRED");
  return {
    ok: true,
    value: {
      ...a,
      status: "cancelled",
      updatedAt: now,
      version: a.version + 1,
    },
  };
}

export function approveAssignment(
  a: WorkAssignment,
  approver: Principal,
  now: string,
): Step<WorkAssignment> {
  if (
    approver.kind !== "human" ||
    !approver.permissions.includes("approvals.decide") ||
    approver.tenantId !== a.tenantId
  ) {
    return fail("APPROVER_NOT_AUTHORIZED");
  }
  if (isAssignmentTerminal(a.status)) return fail("TERMINAL_STATUS");
  return {
    ok: true,
    value: {
      ...a,
      approval: { ...a.approval, approvedBy: { kind: "human", id: approver.id }, approvedAt: now },
      updatedAt: now,
      version: a.version + 1,
    },
  };
}

export function startExecution(a: WorkAssignment, now: string): Step<WorkAssignment> {
  if (!isAssignmentTransitionAllowed(a.status, "executing")) return fail("INVALID_TRANSITION");
  if (a.approval.required && !a.approval.approvedBy) return fail("APPROVAL_PENDING");
  return { ok: true, value: move(a, "executing", now) };
}

export function recordExecution(
  a: WorkAssignment,
  execution: NonNullable<WorkAssignment["execution"]>,
  now: string,
): Step<WorkAssignment> {
  const to = execution.result === "succeeded" ? "in_review" : "assigned";
  if (!isAssignmentTransitionAllowed(a.status, to)) return fail("INVALID_TRANSITION");
  return { ok: true, value: move(a, to, now, { execution }) };
}

/**
 * A review reported by a CORE3 reviewer WORKER (not a workforce agent). Independence at this
 * boundary: the reviewing worker is not the worker that executed.
 */
export function recordWorkerReview(input: {
  assignment: WorkAssignment;
  reviewerWorkerId: string;
  outcome: ReviewOutcome;
  notes?: string;
  now: string;
}): Step<WorkAssignment> {
  const { assignment: a, reviewerWorkerId, outcome, notes, now } = input;
  if (a.status !== "in_review") return fail("INVALID_TRANSITION");
  if (reviewerWorkerId === a.execution?.workerId) return fail("REVIEWER_NOT_INDEPENDENT");
  const review = { reviewerWorkerId, outcome, reviewedAt: now, ...(notes ? { notes } : {}) };
  return applyReview(a, review, outcome, now);
}

function applyReview(
  a: WorkAssignment,
  review: NonNullable<WorkAssignment["review"]>,
  outcome: ReviewOutcome,
  now: string,
): Step<WorkAssignment> {
  if (outcome === "APPROVE") return { ok: true, value: move(a, "accepted", now, { review }) };
  if (outcome === "BLOCK") return { ok: true, value: move(a, "blocked", now, { review }) };
  return {
    ok: true,
    value: move(a, "changes_requested", now, { review, correctionCount: a.correctionCount + 1 }),
  };
}

/**
 * Independent review. The reviewer is an active agent of the same tenant, holding the
 * `independent_review` capability through its role, and is neither the assignee nor the agent
 * standing for the executing worker. BLOCK is terminal.
 */
export function recordReview(input: {
  assignment: WorkAssignment;
  reviewer: WorkforceAgent;
  reviewerCapabilities: readonly string[];
  outcome: ReviewOutcome;
  notes?: string;
  now: string;
}): Step<WorkAssignment> {
  const { assignment: a, reviewer, reviewerCapabilities, outcome, notes, now } = input;
  const errors: DelegationError[] = [];
  if (a.status !== "in_review") errors.push("INVALID_TRANSITION");
  if (
    reviewer.agentId === a.assigneeAgentId ||
    (reviewer.workerId !== undefined && reviewer.workerId === a.execution?.workerId)
  ) {
    errors.push("REVIEWER_NOT_INDEPENDENT");
  }
  if (!isActive(reviewer, now) || reviewer.tenantId !== a.tenantId) errors.push("AGENT_NOT_ACTIVE");
  // Reviewing means reading the work: the reviewer must hold the work's client/project scope.
  if (!scopeCovers(reviewer.scope, a.scope)) errors.push("SCOPE_ESCAPE");
  if (!reviewerCapabilities.includes(INDEPENDENT_REVIEW_CAPABILITY))
    errors.push("REVIEWER_NOT_QUALIFIED");
  if (errors.length > 0) return { ok: false, errors };

  const review = {
    reviewerAgentId: reviewer.agentId,
    outcome,
    reviewedAt: now,
    ...(notes ? { notes } : {}),
  };
  return applyReview(a, review, outcome, now);
}

/**
 * Supervisor synthesis. Only the supervisor that delegated the children; only once every child
 * is accepted or blocked (BLOCK is respected — a blocked child is reported, never re-run).
 * `parent` is the supervisor's own assignment (null at the mission root).
 */
export function synthesize(input: {
  actorAgentId: string;
  parent: WorkAssignment | null;
  children: readonly WorkAssignment[];
  summary: string;
  now: string;
}): Step<{ parent: WorkAssignment | null; children: WorkAssignment[]; blockedChildIds: string[] }> {
  const { actorAgentId, parent, children, summary, now } = input;
  if (children.length === 0) return fail("NOTHING_TO_SYNTHESIZE");
  if (children.some((c) => c.supervisorAgentId !== actorAgentId)) return fail("NOT_THE_SUPERVISOR");
  if (parent && (parent.assigneeAgentId !== actorAgentId || parent.status !== "executing")) {
    return fail("NOT_THE_SUPERVISOR");
  }
  if (children.some((c) => c.parentAssignmentId !== (parent?.assignmentId ?? null)))
    return fail("NOT_THE_SUPERVISOR");
  if (children.some((c) => c.status !== "accepted" && c.status !== "blocked"))
    return fail("CHILDREN_NOT_SETTLED");

  const synthesis = { summary, childAssignmentIds: children.map((c) => c.assignmentId).sort() };
  return {
    ok: true,
    value: {
      parent: parent ? { ...parent, synthesis, updatedAt: now, version: parent.version + 1 } : null,
      children: children.map((c) => (c.status === "accepted" ? move(c, "synthesized", now) : c)),
      blockedChildIds: children.filter((c) => c.status === "blocked").map((c) => c.assignmentId),
    },
  };
}

/** The empirical fact a review — or a failed execution — produces. Facts only; no score. */
export function observationFromReview(input: {
  observationId: string;
  assignment: WorkAssignment;
  roleId: string;
  taskType: string;
  now: string;
}): PerformanceObservation {
  const { observationId, assignment: a, roleId, taskType, now } = input;
  const ex = a.execution;
  const latencyMs = ex
    ? Math.max(0, Date.parse(ex.finishedAt) - Date.parse(ex.startedAt))
    : undefined;
  return {
    observationId,
    tenantId: a.tenantId,
    agentId: a.assigneeAgentId,
    roleId,
    skillId: a.skillId,
    taskType,
    assignmentId: a.assignmentId,
    success: ex?.result === "succeeded" && a.review?.outcome === "APPROVE",
    ...(a.review ? { reviewOutcome: a.review.outcome } : {}),
    correctionCount: a.correctionCount,
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(ex?.costCents !== undefined ? { costCents: ex.costCents } : {}),
    ...(ex?.selected?.modelKey ? { selectedModelKey: ex.selected.modelKey } : {}),
    // Never inferred from the selection: unknown effective compute stays absent.
    ...(ex?.effective?.modelKey ? { effectiveModelKey: ex.effective.modelKey } : {}),
    ...(ex?.result === "failed"
      ? { failureClass: ex.failureClass }
      : a.review?.outcome === "BLOCK"
        ? { failureClass: "REVIEW_BLOCKED" }
        : {}),
    source: ex?.source ?? "NOT_CONNECTED",
    observedAt: now,
  };
}
