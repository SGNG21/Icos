import type { AuthorizationLevel } from "@/core/contracts/common";
import { effectiveMemoryScope, supervisionChain } from "@/core/workforce/authority";
import type { AgentKind, Kpi, MemoryVisibility, SkillRisk } from "@/core/workforce/contracts";
import {
  isAssignmentTerminal,
  isGrantLive,
  policyWithin,
  type Principal,
} from "@/core/workforce/governance";
import { summarizePerformance, type PerformanceSummary } from "@/core/workforce/performance";

import type { WorkforceStore } from "./ports";
import type { PrincipalAuthority } from "./principals";
import { WorkforceDeniedError } from "./workforce-service";

/**
 * COCKPIT READ MODEL (decision 0056 §integration). A stable, read-only projection: plain,
 * deep-frozen data with no reference to store objects and no mutating method. The Cockpit
 * changes the workforce only through WorkforceService commands.
 */

export type AgentHealth = "active" | "suspended" | "blocked" | "retired" | "expired" | "degraded";

export interface AgentView {
  agentId: string;
  displayName: string;
  kind: AgentKind;
  roleId: string;
  roleVersion: string;
  departmentId: string | null;
  supervisorAgentId: string | null;
  depth: number;
  status: string;
  health: AgentHealth;
  /** Why health is not `active` (e.g. ANCESTOR_NOT_ACTIVE, TOOL_NOT_HELD_BY_PARENT). */
  healthReasons: string[];
  autonomyLevel: AuthorizationLevel;
  budget: { computeUnits: number; allocatedToReports: number; committedToAssignments: number };
  toolGrants: {
    toolId: string;
    actions: string[];
    grantedBy: string;
    delegatedBy?: string;
    expiresAt?: string;
    live: boolean;
  }[];
  memory: {
    read: string[];
    write: string[];
    maxVisibility: MemoryVisibility;
    retentionDays?: number;
    effectiveActive: boolean;
  };
  scope: { clientIds: string[]; projectIds: string[] };
  missionId?: string;
  expiresAt?: string;
  objectives: string[];
  kpis: Kpi[];
  activeAssignments: number;
  performance: PerformanceSummary;
}

export interface WorkforceSnapshot {
  generatedAt: string;
  tenantId: string;
  agents: AgentView[];
  departments: {
    departmentId: string;
    name: string;
    parentDepartmentId: string | null;
    supervisorAgentId: string | null;
  }[];
  roles: {
    roleId: string;
    version: string;
    name: string;
    status: string;
    skills: string[];
    autonomyCeiling: AuthorizationLevel;
  }[];
  skills: {
    skillId: string;
    version: string;
    name: string;
    risk: SkillRisk;
    capabilities: string[];
    status: string;
  }[];
  activeAssignments: {
    assignmentId: string;
    missionId: string;
    taskId: string;
    parentAssignmentId: string | null;
    supervisorAgentId: string;
    assigneeAgentId: string;
    skillId: string;
    status: string;
    approvalPending: boolean;
  }[];
  performance: PerformanceSummary;
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

export class WorkforceReadModel {
  constructor(
    private readonly deps: {
      store: WorkforceStore;
      principals: Pick<PrincipalAuthority, "isIssued">;
      now: () => string;
    },
  ) {}

  async snapshot(principal: Principal): Promise<Readonly<WorkforceSnapshot>> {
    const readable =
      this.deps.principals.isIssued(principal) &&
      (principal.kind === "system" ||
        (principal.kind === "human" && principal.permissions.includes("cockpit.read")));
    if (!readable) throw new WorkforceDeniedError(["ACTOR_NOT_AUTHORIZED"]);

    const { store } = this.deps;
    const tenantId = principal.tenantId;
    const now = this.deps.now();
    const [agents, roles, skills, departments, assignments, observations] = await Promise.all([
      store.listAgents(tenantId),
      store.listRoles(tenantId),
      store.listSkills(tenantId),
      store.listDepartments(tenantId),
      store.listAssignments(tenantId),
      store.listObservations(tenantId),
    ]);
    const byId = new Map(agents.map((a) => [a.agentId, a]));
    const open = assignments.filter(
      (a) => !isAssignmentTerminal(a.status) && a.status !== "accepted",
    );

    const agentViews: AgentView[] = agents.map((a) => {
      const chain = supervisionChain(a.agentId, agents);
      const memory = effectiveMemoryScope(chain, now);
      const supervisor = a.supervisorAgentId ? byId.get(a.supervisorAgentId) : undefined;
      const drift = supervisor ? policyWithin(a.policy, supervisor.policy, now) : [];
      const reasons = [...(memory?.reasons ?? []), ...drift].filter(
        (r) => r !== "AGENT_NOT_ACTIVE",
      );
      const expired =
        a.status === "active" &&
        a.expiresAt !== undefined &&
        Date.parse(a.expiresAt) <= Date.parse(now);
      const health: AgentHealth =
        a.status !== "active"
          ? (a.status as AgentHealth)
          : expired
            ? "expired"
            : reasons.length > 0
              ? "degraded"
              : "active";
      return {
        agentId: a.agentId,
        displayName: a.displayName,
        kind: a.kind,
        roleId: a.roleId,
        roleVersion: a.roleVersion,
        departmentId: a.departmentId,
        supervisorAgentId: a.supervisorAgentId,
        depth: a.depth,
        status: a.status,
        health,
        healthReasons: [...new Set(reasons)],
        autonomyLevel: a.policy.autonomyLevel,
        budget: {
          computeUnits: a.policy.budget.computeUnits,
          allocatedToReports: agents
            .filter((c) => c.supervisorAgentId === a.agentId && c.status === "active")
            .reduce((sum, c) => sum + c.policy.budget.computeUnits, 0),
          committedToAssignments: assignments
            .filter((x) => x.assigneeAgentId === a.agentId && x.status !== "blocked")
            .reduce((sum, x) => sum + x.computeUnits, 0),
        },
        toolGrants: a.policy.toolGrants.map((g) => ({
          toolId: g.toolId,
          actions: [...g.actions],
          grantedBy: g.grantedBy.id,
          ...(g.delegatedBy ? { delegatedBy: g.delegatedBy } : {}),
          ...(g.expiresAt ? { expiresAt: g.expiresAt } : {}),
          live: isGrantLive(g, now),
        })),
        memory: {
          read: [...(memory?.read ?? [])],
          write: [...(memory?.write ?? [])],
          maxVisibility: memory?.maxVisibility ?? "private",
          ...(memory?.retentionDays !== undefined ? { retentionDays: memory.retentionDays } : {}),
          effectiveActive: memory?.active ?? false,
        },
        scope: { clientIds: [...a.scope.clientIds], projectIds: [...a.scope.projectIds] },
        ...(a.missionId ? { missionId: a.missionId } : {}),
        ...(a.expiresAt ? { expiresAt: a.expiresAt } : {}),
        objectives: [...a.objectives],
        kpis: a.kpis.map((k) => ({ ...k })),
        activeAssignments: open.filter((x) => x.assigneeAgentId === a.agentId).length,
        performance: summarizePerformance(observations, { agentId: a.agentId }),
      };
    });

    return deepFreeze({
      generatedAt: now,
      tenantId,
      agents: agentViews,
      departments: departments.map((d) => ({
        departmentId: d.departmentId,
        name: d.name,
        parentDepartmentId: d.parentDepartmentId,
        supervisorAgentId: d.supervisorAgentId,
      })),
      roles: roles.map((r) => ({
        roleId: r.roleId,
        version: r.version,
        name: r.name,
        status: r.status,
        skills: [...r.skills],
        autonomyCeiling: r.autonomyCeiling,
      })),
      skills: skills.map((s) => ({
        skillId: s.skillId,
        version: s.version,
        name: s.name,
        risk: s.risk,
        capabilities: [...s.capabilities],
        status: s.status,
      })),
      activeAssignments: open.map((x) => ({
        assignmentId: x.assignmentId,
        missionId: x.missionId,
        taskId: x.taskId,
        parentAssignmentId: x.parentAssignmentId,
        supervisorAgentId: x.supervisorAgentId,
        assigneeAgentId: x.assigneeAgentId,
        skillId: x.skillId,
        status: x.status,
        approvalPending: x.approval.required && !x.approval.approvedBy,
      })),
      performance: summarizePerformance(observations),
    });
  }
}
