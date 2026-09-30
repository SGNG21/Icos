import type { AuthorizationLevel } from "@/core/contracts/common";

import type { OrganizationBounds } from "./bootstrap";
import {
  TERMINAL_AGENT_STATUSES,
  TERMINAL_ASSIGNMENT_STATUSES,
  type AgentKind,
  type AgentPolicy,
  type AgentRole,
  type AssignmentStatus,
  type MemoryScope,
  type SkillDefinition,
  type SkillRisk,
  type ToolGrant,
  type WorkAssignment,
  type WorkforceAgent,
  type WorkforceAgentStatus,
  type WorkRequest,
  type WorkScope,
} from "./contracts";

/**
 * WORKFORCE GOVERNANCE (decision 0057). Pure: no I/O, no clock (`now` is data).
 *
 * Every check collects ALL violations instead of stopping at the first, so a refusal is
 * auditable evidence. Unknown is never a pass: a missing supervisor, role or skill denies.
 */

export type GovernanceViolation =
  | "ACTOR_NOT_AUTHORIZED"
  | "SELF_MODIFICATION"
  | "AUTONOMY_EXCEEDS_PARENT"
  | "AUTONOMY_EXCEEDS_ROLE_CEILING"
  | "TOOL_NOT_HELD_BY_PARENT"
  | "GRANT_NOT_FROM_PRINCIPAL"
  | "BUDGET_EXCEEDS_PARENT"
  | "BOUNDS_EXCEED_PARENT"
  | "SCOPE_ESCAPE"
  | "MEMORY_SCOPE_ESCAPE"
  | "SPAWN_KIND_FORBIDDEN"
  | "PARENT_NOT_ACTIVE"
  | "MAX_DEPTH"
  | "MAX_DESCENDANTS"
  | "MAX_AGENTS"
  | "EPHEMERAL_REQUIRES_MISSION_AND_EXPIRY"
  | "EXPIRY_AFTER_PARENT"
  | "ROLE_NOT_ACTIVE"
  | "ROLE_KIND_MISMATCH"
  | "AGENT_NOT_ACTIVE"
  | "AGENT_EXPIRED"
  | "SUPERVISOR_NOT_IN_CHAIN"
  | "SUPERVISOR_NOT_ACTIVE"
  | "SKILL_NOT_IN_ROLE"
  | "SKILL_NOT_ACTIVE"
  | "SKILL_KIND_MISMATCH"
  | "MISSING_CAPABILITY"
  | "MISSING_TOOL_GRANT"
  | "CONCURRENCY_LIMIT"
  | "COMPUTE_BUDGET_EXCEEDED"
  | "TERMINAL_STATUS";

export type Verdict = { allowed: true } | { allowed: false; violations: GovernanceViolation[] };

function verdict(violations: GovernanceViolation[]): Verdict {
  const unique = [...new Set(violations)];
  return unique.length === 0 ? { allowed: true } : { allowed: false, violations: unique };
}

/**
 * A human principal as the existing identity layer describes it. `agents.manage` is the
 * existing permission (core/identity/permissions.ts) for structure and policy changes.
 */
export interface Principal {
  kind: "human" | "agent" | "system";
  id: string;
  tenantId: string;
  permissions: readonly string[];
}

export const WORKFORCE_ADMIN_PERMISSION = "agents.manage";

/** Only a human holding `agents.manage` changes structure, roles, grants or autonomy. */
export function isWorkforceAdmin(principal: Principal): boolean {
  return principal.kind === "human" && principal.permissions.includes(WORKFORCE_ADMIN_PERMISSION);
}

/* ---------------------------------------------------------------------------------------- */
/* Risk → autonomy ceiling                                                                    */
/* ---------------------------------------------------------------------------------------- */

const CEILING_BY_RISK: Readonly<Record<SkillRisk, AuthorizationLevel>> = {
  LOW: 3,
  MEDIUM: 2,
  HIGH: 2,
  CRITICAL: 1,
};
const RISK_ORDER: readonly SkillRisk[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function maxRisk(skills: readonly Pick<SkillDefinition, "risk">[]): SkillRisk {
  return skills.reduce<SkillRisk>(
    (acc, s) => (RISK_ORDER.indexOf(s.risk) > RISK_ORDER.indexOf(acc) ? s.risk : acc),
    "LOW",
  );
}

/** The highest autonomy a role built from these skills may carry. */
export function ceilingForSkills(
  skills: readonly Pick<SkillDefinition, "risk">[],
): AuthorizationLevel {
  return CEILING_BY_RISK[maxRisk(skills)];
}

/* ---------------------------------------------------------------------------------------- */
/* Scope / grants / policy containment                                                       */
/* ---------------------------------------------------------------------------------------- */

const ALL = "*";

function listWithin(child: readonly string[], parent: readonly string[]): boolean {
  if (parent.includes(ALL)) return true;
  return !child.includes(ALL) && child.every((c) => parent.includes(c));
}

export function scopeWithin(child: WorkScope, parent: WorkScope): boolean {
  return (
    listWithin(child.clientIds, parent.clientIds) && listWithin(child.projectIds, parent.projectIds)
  );
}

/** Does `scope` cover one piece of work's client/project? */
export function scopeCovers(
  scope: WorkScope,
  work: { clientId?: string; projectId?: string },
): boolean {
  return (
    (!work.clientId || listWithin([work.clientId], scope.clientIds)) &&
    (!work.projectId || listWithin([work.projectId], scope.projectIds))
  );
}

/** Namespace containment: `a/b` is within `a`; `*` holds everything. */
function namespacesWithin(child: readonly string[], parent: readonly string[]): boolean {
  if (parent.includes(ALL)) return true;
  return child.every((c) => c !== ALL && parent.some((p) => c === p || c.startsWith(`${p}/`)));
}

const VISIBILITY_RANK = { private: 0, restricted: 1, tenant: 2 } as const;

/** Namespaces ⊆, visibility no broader, retention no longer (absent = unbounded). */
export function memoryScopeWithin(child: MemoryScope, parent: MemoryScope): boolean {
  const retentionOk =
    parent.retentionDays === undefined ||
    (child.retentionDays !== undefined && child.retentionDays <= parent.retentionDays);
  return (
    namespacesWithin(child.read, parent.read) &&
    namespacesWithin(child.write, parent.write) &&
    VISIBILITY_RANK[child.maxVisibility] <= VISIBILITY_RANK[parent.maxVisibility] &&
    retentionOk
  );
}

/** Does this namespace fall inside the allowed list (`a/b` inside `a`, `*` holds all)? */
export function namespaceAllowed(namespace: string, allowed: readonly string[]): boolean {
  return namespacesWithin([namespace], allowed);
}

/** Actions ⊆ the union of the parent's live grants for that tool (`*` only under `*`). */
function actionsWithin(child: readonly string[], held: readonly ToolGrant[]): boolean {
  const union = new Set(held.flatMap((g) => g.actions));
  if (union.has("*")) return true;
  return !child.includes("*") && child.every((a) => union.has(a));
}

export function isGrantLive(grant: ToolGrant, now: string): boolean {
  return !grant.expiresAt || Date.parse(grant.expiresAt) > Date.parse(now);
}

export function liveToolIds(policy: AgentPolicy, now: string): Set<string> {
  return new Set(policy.toolGrants.filter((g) => isGrantLive(g, now)).map((g) => g.toolId));
}

/**
 * Child policy ⊆ parent policy. A delegated grant must be one the parent holds live, from the
 * same human, expiring no later. Used for spawn, for durable creation and for policy change.
 */
export function policyWithin(
  child: AgentPolicy,
  parent: AgentPolicy,
  now: string,
): GovernanceViolation[] {
  const v: GovernanceViolation[] = [];
  if (child.autonomyLevel > parent.autonomyLevel) v.push("AUTONOMY_EXCEEDS_PARENT");
  for (const g of child.toolGrants) {
    const held = parent.toolGrants.filter((p) => p.toolId === g.toolId && isGrantLive(p, now));
    // A pass-down keeps its human origin: it must name a human who granted the parent this tool.
    const provenanceOk =
      g.delegatedBy === undefined || held.some((p) => p.grantedBy.id === g.grantedBy.id);
    const lastExpiry = held.some((p) => !p.expiresAt)
      ? Infinity
      : Math.max(-Infinity, ...held.map((p) => Date.parse(p.expiresAt!)));
    const childExpiry = g.expiresAt ? Date.parse(g.expiresAt) : Infinity;
    if (
      held.length === 0 ||
      !provenanceOk ||
      childExpiry > lastExpiry ||
      !actionsWithin(g.actions, held)
    )
      v.push("TOOL_NOT_HELD_BY_PARENT");
  }
  if (
    child.budget.computeUnits > parent.budget.computeUnits ||
    child.budget.financialCents > parent.budget.financialCents
  ) {
    v.push("BUDGET_EXCEEDS_PARENT");
  }
  if (
    child.bounds.maxDepth > parent.bounds.maxDepth ||
    child.bounds.maxDescendants > parent.bounds.maxDescendants ||
    child.bounds.maxConcurrentAssignments > parent.bounds.maxConcurrentAssignments
  ) {
    v.push("BOUNDS_EXCEED_PARENT");
  }
  return v;
}

function isOwnGrant(g: ToolGrant, principal: Principal): boolean {
  return g.grantedBy.id === principal.id && g.delegatedBy === undefined;
}

/**
 * Budgets are ALLOCATIONS from the supervisor: the active direct reports' budgets together
 * (this one included) never exceed the supervisor's. Per-child containment alone would let
 * ten children each hold the parent's full budget.
 */
export function exceedsAllocation(
  child: AgentPolicy,
  supervisor: WorkforceAgent,
  org: readonly WorkforceAgent[],
  childId: string,
  now: string,
): boolean {
  const others = org.filter(
    (a) => a.supervisorAgentId === supervisor.agentId && a.agentId !== childId && isActive(a, now),
  );
  const sum = (k: "computeUnits" | "financialCents") =>
    others.reduce((acc, a) => acc + a.policy.budget[k], child.budget[k]);
  return (
    sum("computeUnits") > supervisor.policy.budget.computeUnits ||
    sum("financialCents") > supervisor.policy.budget.financialCents
  );
}

/* ---------------------------------------------------------------------------------------- */
/* Agent creation / spawning                                                                  */
/* ---------------------------------------------------------------------------------------- */

const SPAWNABLE: Readonly<Record<AgentKind, readonly AgentKind[]>> = {
  DURABLE_AGENT: ["EPHEMERAL_SPECIALIST", "EXECUTION_WORKER"],
  EPHEMERAL_SPECIALIST: ["EXECUTION_WORKER"],
  EXECUTION_WORKER: [],
};

export function isActive(agent: WorkforceAgent, now: string): boolean {
  return (
    agent.status === "active" && (!agent.expiresAt || Date.parse(agent.expiresAt) > Date.parse(now))
  );
}

/** Active transitive descendants by spawn/supervision lineage. */
export function activeDescendantCount(
  agentId: string,
  org: readonly WorkforceAgent[],
  now: string,
): number {
  const children = new Map<string, string[]>();
  for (const a of org) {
    const parent = a.parentAgentId ?? a.supervisorAgentId;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), a.agentId]);
  }
  const byId = new Map(org.map((a) => [a.agentId, a]));
  let count = 0;
  const seen = new Set<string>();
  const stack = [...(children.get(agentId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const agent = byId.get(id);
    if (agent && isActive(agent, now)) count += 1;
    stack.push(...(children.get(id) ?? []));
  }
  return count;
}

export interface CreationContext {
  /** Who asks. For a spawn this is the parent agent acting; for a durable agent, a human. */
  principal: Principal;
  /** The complete proposed agent (status `active`). */
  candidate: WorkforceAgent;
  /** Supervisor (and, for a spawn, the parent). null only for the root. */
  supervisor: WorkforceAgent | null;
  role: AgentRole | null;
  /** Every agent of the tenant, for the org-wide and subtree bounds. */
  org: readonly WorkforceAgent[];
  bounds: OrganizationBounds;
  now: string;
}

/**
 * The single creation gate. Durable agents (including the root) are created by a workforce
 * admin; ephemeral specialists and execution workers may also be spawned by their active
 * parent agent, within that parent's policy and the organisation bounds.
 */
export function evaluateAgentCreation(ctx: CreationContext): Verdict {
  const { principal, candidate: c, supervisor: sup, role, org, bounds, now } = ctx;
  const v: GovernanceViolation[] = [];

  if (principal.tenantId !== c.tenantId) v.push("ACTOR_NOT_AUTHORIZED");
  const admin = isWorkforceAdmin(principal);
  const spawnedByParent =
    principal.kind === "agent" && sup !== null && principal.id === sup.agentId;
  if (c.kind === "DURABLE_AGENT" && !admin) v.push("ACTOR_NOT_AUTHORIZED");
  if (c.kind !== "DURABLE_AGENT" && !admin && !spawnedByParent) v.push("ACTOR_NOT_AUTHORIZED");
  if (spawnedByParent && c.parentAgentId !== principal.id) v.push("ACTOR_NOT_AUTHORIZED");

  // A human admin grants in their OWN name only (no attribution to another human, no fake
  // pass-down). An agent may only pass down grants it holds (policyWithin); it never mints one.
  for (const g of c.policy.toolGrants) {
    if (admin && !isOwnGrant(g, principal)) v.push("GRANT_NOT_FROM_PRINCIPAL");
    if (spawnedByParent && g.delegatedBy !== principal.id) v.push("GRANT_NOT_FROM_PRINCIPAL");
  }

  if (!role || role.status !== "active") v.push("ROLE_NOT_ACTIVE");
  else {
    if (!role.agentKinds.includes(c.kind)) v.push("ROLE_KIND_MISMATCH");
    if (c.policy.autonomyLevel > role.autonomyCeiling) v.push("AUTONOMY_EXCEEDS_ROLE_CEILING");
  }

  if (
    c.kind !== "DURABLE_AGENT" &&
    (!c.missionId || (c.kind === "EPHEMERAL_SPECIALIST" && !c.expiresAt))
  ) {
    v.push("EPHEMERAL_REQUIRES_MISSION_AND_EXPIRY");
  }

  const activeCount = org.filter((a) => isActive(a, now)).length;
  if (activeCount >= bounds.maxAgents) v.push("MAX_AGENTS");
  if (c.depth > bounds.maxDepth) v.push("MAX_DEPTH");

  if (sup === null && c.supervisorAgentId !== null) v.push("SUPERVISOR_NOT_IN_CHAIN");
  if (sup === null) {
    // Only one root per tenant, created by a human.
    if (
      c.kind !== "DURABLE_AGENT" ||
      c.depth !== 0 ||
      org.some((a) => a.supervisorAgentId === null)
    ) {
      v.push("SPAWN_KIND_FORBIDDEN");
    }
    return verdict(v);
  }

  if (!isActive(sup, now)) v.push("PARENT_NOT_ACTIVE");
  if (sup.tenantId !== c.tenantId) v.push("SCOPE_ESCAPE");
  if (c.supervisorAgentId !== sup.agentId) v.push("SUPERVISOR_NOT_IN_CHAIN");
  if (c.depth !== sup.depth + 1) v.push("MAX_DEPTH");
  if (c.depth > sup.policy.bounds.maxDepth) v.push("MAX_DEPTH");
  if (c.kind !== "DURABLE_AGENT" && !SPAWNABLE[sup.kind].includes(c.kind))
    v.push("SPAWN_KIND_FORBIDDEN");
  if (c.kind === "DURABLE_AGENT" && sup.kind !== "DURABLE_AGENT") v.push("SPAWN_KIND_FORBIDDEN");
  if (activeDescendantCount(sup.agentId, org, now) >= sup.policy.bounds.maxDescendants) {
    v.push("MAX_DESCENDANTS");
  }
  if (sup.expiresAt && (!c.expiresAt || Date.parse(c.expiresAt) > Date.parse(sup.expiresAt))) {
    v.push("EXPIRY_AFTER_PARENT");
  }
  v.push(...policyWithin(c.policy, sup.policy, now));
  if (exceedsAllocation(c.policy, sup, org, c.agentId, now)) v.push("BUDGET_EXCEEDS_PARENT");
  if (!scopeWithin(c.scope, sup.scope)) v.push("SCOPE_ESCAPE");
  if (!memoryScopeWithin(c.memoryScope, sup.memoryScope)) v.push("MEMORY_SCOPE_ESCAPE");

  return verdict(v);
}

/**
 * Policy change on an existing agent. Only a workforce admin, never the agent itself, and
 * never beyond the supervisor or the role ceiling. Autonomy can only rise by a human act.
 */
export function evaluatePolicyChange(input: {
  principal: Principal;
  target: WorkforceAgent;
  next: AgentPolicy;
  supervisor: WorkforceAgent | null;
  role: AgentRole | null;
  /** The tenant's agents, for the budget allocation check across siblings. */
  siblings?: readonly WorkforceAgent[];
  now: string;
}): Verdict {
  const { principal, target, next, supervisor, role, siblings, now } = input;
  const v: GovernanceViolation[] = [];
  if (principal.id === target.agentId) v.push("SELF_MODIFICATION");
  if (!isWorkforceAdmin(principal) || principal.tenantId !== target.tenantId)
    v.push("ACTOR_NOT_AUTHORIZED");
  if (TERMINAL_AGENT_STATUSES.includes(target.status)) v.push("TERMINAL_STATUS");
  if (!role) v.push("ROLE_NOT_ACTIVE");
  else if (next.autonomyLevel > role.autonomyCeiling) v.push("AUTONOMY_EXCEEDS_ROLE_CEILING");
  // Any grant not carried over unchanged (new, or with a changed expiry/provenance) is a new
  // grant and must be in the acting human's own name.
  const previous = new Set(target.policy.toolGrants.map((g) => JSON.stringify(g)));
  for (const g of next.toolGrants) {
    if (!previous.has(JSON.stringify(g)) && !isOwnGrant(g, principal))
      v.push("GRANT_NOT_FROM_PRINCIPAL");
  }
  if (supervisor) {
    v.push(...policyWithin(next, supervisor.policy, now));
    if (siblings && exceedsAllocation(next, supervisor, siblings, target.agentId, now)) {
      v.push("BUDGET_EXCEEDS_PARENT");
    }
  }
  return verdict(v);
}

/* ---------------------------------------------------------------------------------------- */
/* Status transitions (terminal BLOCK)                                                       */
/* ---------------------------------------------------------------------------------------- */

const AGENT_TRANSITIONS: Readonly<Record<WorkforceAgentStatus, readonly WorkforceAgentStatus[]>> = {
  active: ["suspended", "retired", "blocked"],
  suspended: ["active", "retired", "blocked"],
  retired: [],
  blocked: [],
};

export function isAgentTransitionAllowed(
  from: WorkforceAgentStatus,
  to: WorkforceAgentStatus,
): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

/** Agent status change: a human admin; an agent may only retire ITSELF (never re-activate). */
export function evaluateAgentStatusChange(input: {
  principal: Principal;
  target: WorkforceAgent;
  to: WorkforceAgentStatus;
}): Verdict {
  const { principal, target, to } = input;
  const v: GovernanceViolation[] = [];
  if (!isAgentTransitionAllowed(target.status, to)) v.push("TERMINAL_STATUS");
  const selfRetire =
    principal.kind === "agent" && principal.id === target.agentId && to === "retired";
  if (!selfRetire && (!isWorkforceAdmin(principal) || principal.tenantId !== target.tenantId)) {
    v.push("ACTOR_NOT_AUTHORIZED");
  }
  return verdict(v);
}

const ASSIGNMENT_TRANSITIONS: Readonly<Record<AssignmentStatus, readonly AssignmentStatus[]>> = {
  assigned: ["executing", "blocked"],
  // A FAILED execution returns the work for another attempt; a succeeded one goes to review.
  executing: ["in_review", "assigned", "blocked"],
  in_review: ["accepted", "changes_requested", "blocked"],
  changes_requested: ["executing", "blocked"],
  accepted: ["synthesized"],
  blocked: [],
  synthesized: [],
};

export function isAssignmentTransitionAllowed(
  from: AssignmentStatus,
  to: AssignmentStatus,
): boolean {
  return ASSIGNMENT_TRANSITIONS[from].includes(to);
}

export function isAssignmentTerminal(status: AssignmentStatus): boolean {
  return TERMINAL_ASSIGNMENT_STATUSES.includes(status);
}

/* ---------------------------------------------------------------------------------------- */
/* Assignment authorization                                                                   */
/* ---------------------------------------------------------------------------------------- */

export interface AssignmentContext {
  /** The agent delegating. Must be the assignee's supervisor. */
  supervisor: WorkforceAgent | null;
  assignee: WorkforceAgent;
  role: AgentRole | null;
  skill: SkillDefinition | null;
  request: WorkRequest;
  /** The assignee's existing assignments (any status); load and budget are derived. */
  assigneeAssignments: readonly WorkAssignment[];
  now: string;
}

export type AssignmentVerdict =
  | { allowed: true; requiresApproval: boolean; approvalReasons: string[] }
  | { allowed: false; violations: GovernanceViolation[] };

/**
 * May `supervisor` give `request` to `assignee` using `skill`? A skill proves competence, not
 * permission: every tool the skill needs must be GRANTED to the assignee, live.
 */
export function authorizeAssignment(ctx: AssignmentContext): AssignmentVerdict {
  const { supervisor, assignee, role, skill, request, assigneeAssignments, now } = ctx;
  const v: GovernanceViolation[] = [];

  if (!isActive(assignee, now))
    v.push(assignee.status === "active" ? "AGENT_EXPIRED" : "AGENT_NOT_ACTIVE");
  if (!supervisor || assignee.supervisorAgentId !== supervisor.agentId)
    v.push("SUPERVISOR_NOT_IN_CHAIN");
  else if (!isActive(supervisor, now)) v.push("SUPERVISOR_NOT_ACTIVE");
  if (supervisor && supervisor.tenantId !== assignee.tenantId) v.push("SCOPE_ESCAPE");

  if (!role || role.status !== "active" || role.roleId !== assignee.roleId)
    v.push("ROLE_NOT_ACTIVE");
  if (!skill) v.push("SKILL_NOT_IN_ROLE");
  else {
    if (role && !role.skills.includes(skill.skillId)) v.push("SKILL_NOT_IN_ROLE");
    if (skill.status !== "active") v.push("SKILL_NOT_ACTIVE");
    if (!skill.compatibleAgentKinds.includes(assignee.kind)) v.push("SKILL_KIND_MISMATCH");
    if (!request.requiredCapabilities.every((cap) => skill.capabilities.includes(cap))) {
      v.push("MISSING_CAPABILITY");
    }
    const granted = liveToolIds(assignee.policy, now);
    if (!skill.requiredTools.every((t) => granted.has(t))) v.push("MISSING_TOOL_GRANT");
  }

  if (!scopeCovers(assignee.scope, request.scope)) v.push("SCOPE_ESCAPE");
  // Containment is re-checked at every assignment: a grant revoked from the supervisor after
  // the spawn stops its children too — a child never outlives a narrowing of its parent.
  if (supervisor) v.push(...policyWithin(assignee.policy, supervisor.policy, now));

  const open = assigneeAssignments.filter(
    (a) => !isAssignmentTerminal(a.status) && a.status !== "accepted",
  );
  if (open.length >= assignee.policy.bounds.maxConcurrentAssignments) v.push("CONCURRENCY_LIMIT");
  const committed = assigneeAssignments
    .filter((a) => a.status !== "blocked")
    .reduce((sum, a) => sum + a.computeUnits, 0);
  if (committed + request.computeUnits > assignee.policy.budget.computeUnits)
    v.push("COMPUTE_BUDGET_EXCEEDED");

  const result = verdict(v);
  if (!result.allowed) return result;

  const approvalReasons: string[] = [];
  if (skill!.risk === "CRITICAL") approvalReasons.push("skill risk CRITICAL");
  if (request.actionClass && skill!.approvalRequiredFor.includes(request.actionClass)) {
    approvalReasons.push(`action class ${request.actionClass} requires approval`);
  }
  return { allowed: true, requiresApproval: approvalReasons.length > 0, approvalReasons };
}
