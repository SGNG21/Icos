import {
  agentRoleSchema,
  skillDefinitionSchema,
  workforceAgentSchema,
  type AgentPolicy,
  type AgentRole,
  type SkillDefinition,
  type ToolGrant,
  type WorkforceAgent,
  type WorkRequest,
} from "./contracts";
import type { Principal } from "./governance";

/** Shared test data for workforce unit tests. Not imported by production code. */

export const NOW = "2026-09-29T10:00:00.000Z";
export const LATER = "2026-09-30T10:00:00.000Z";
export const TENANT = "default";

export const owner = (over: Partial<Principal> = {}): Principal => ({
  kind: "human",
  id: "owner-1",
  tenantId: TENANT,
  permissions: ["agents.manage", "approvals.decide", "cockpit.read"],
  ...over,
});
export const asAgent = (id: string, tenantId = TENANT): Principal => ({
  kind: "agent",
  id,
  tenantId,
  permissions: [],
});

export const grant = (toolId: string, over: Partial<ToolGrant> = {}): ToolGrant => ({
  toolId,
  grantedBy: { kind: "human", id: "owner-1" },
  grantedAt: NOW,
  ...over,
});

export const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  autonomyLevel: 2,
  toolGrants: [],
  budget: { computeUnits: 100, financialCents: 0 },
  bounds: { maxDepth: 4, maxDescendants: 10, maxConcurrentAssignments: 3 },
  ...over,
});

export const skill = (over: Partial<SkillDefinition> = {}): SkillDefinition =>
  skillDefinitionSchema.parse({
    skillId: "APPSEC_REVIEW",
    name: "AppSec review",
    version: "1.0.0",
    description: "Reviews code",
    capabilities: ["appsec", "code_security"],
    requiredTools: ["repo_read"],
    risk: "HIGH",
    tests: ["skill.appsec_review.fixture"],
    compatibleAgentKinds: ["DURABLE_AGENT", "EPHEMERAL_SPECIALIST", "EXECUTION_WORKER"],
    compute: { reasoning: "deep" },
    ...over,
  });

export const role = (over: Partial<AgentRole> = {}): AgentRole =>
  agentRoleSchema.parse({
    roleId: "APPSEC_SPECIALIST",
    name: "AppSec specialist",
    version: "1.0.0",
    description: "AppSec",
    status: "active",
    agentKinds: ["DURABLE_AGENT", "EPHEMERAL_SPECIALIST", "EXECUTION_WORKER"],
    skills: ["APPSEC_REVIEW"],
    autonomyCeiling: 2,
    provenance: { source: "human_defined", createdBy: { kind: "human", id: "owner-1" } },
    ...over,
  });

export const agent = (over: Partial<WorkforceAgent> = {}): WorkforceAgent =>
  workforceAgentSchema.parse({
    agentId: "agent-root",
    tenantId: TENANT,
    kind: "DURABLE_AGENT",
    roleId: "APPSEC_SPECIALIST",
    roleVersion: "1.0.0",
    displayName: "Agent",
    departmentId: null,
    supervisorAgentId: null,
    parentAgentId: null,
    depth: 0,
    scope: { clientIds: ["*"], projectIds: ["*"] },
    memoryScope: { read: ["*"], write: ["*"] },
    policy: policy({ autonomyLevel: 3, toolGrants: [grant("repo_read"), grant("scanners")] }),
    status: "active",
    createdBy: { kind: "human", id: "owner-1" },
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...over,
  });

/** A direct report of `parent`, ephemeral by default. */
export const child = (parent: WorkforceAgent, over: Partial<WorkforceAgent> = {}): WorkforceAgent =>
  agent({
    agentId: "agent-child",
    kind: "EPHEMERAL_SPECIALIST",
    supervisorAgentId: parent.agentId,
    parentAgentId: parent.agentId,
    depth: parent.depth + 1,
    missionId: "mission-1",
    expiresAt: LATER,
    scope: { clientIds: ["belle-intendance"], projectIds: [] },
    memoryScope: { read: ["tenant/default/client/belle-intendance"], write: [] },
    policy: policy({ toolGrants: [grant("repo_read", { delegatedBy: parent.agentId })] }),
    createdBy: { kind: "agent", id: parent.agentId },
    ...over,
  });

export const request = (over: Partial<WorkRequest> = {}): WorkRequest => ({
  missionId: "mission-1",
  taskId: "task-1",
  taskType: "appsec_review",
  requiredCapabilities: ["appsec"],
  scope: { clientId: "belle-intendance" },
  computeUnits: 10,
  ...over,
});

export const BOUNDS = { maxDepth: 4, maxAgents: 200, maxConcurrentAssignmentsPerAgent: 5 };
