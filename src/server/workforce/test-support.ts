import { randomUUID } from "node:crypto";

import { loadWorkforceBootstrap } from "@/core/workforce/bootstrap";
import type {
  AgentKind,
  AgentPolicy,
  WorkAssignment,
  WorkRequest,
} from "@/core/workforce/contracts";
import type { Principal } from "@/core/workforce/governance";
import { requiredRoleTests } from "@/core/workforce/role-composer";

import { InMemoryWorkforceStore } from "./in-memory-workforce-store";
import type { WorkforceStore } from "./ports";
import { WorkforceService, type AgentSpec } from "./workforce-service";

/**
 * Shared scenario helpers for the workforce service tests (unit and PostgreSQL). Test-only.
 * Execution facts produced here are SIMULATED: no worker runs, and the records say so.
 */

export const T0 = Date.parse("2026-09-29T10:00:00.000Z");
export const bootstrap = loadWorkforceBootstrap();
export const TENANT = "default";
export const owner: Principal = {
  kind: "human",
  id: "owner-1",
  tenantId: TENANT,
  permissions: ["agents.manage", "approvals.decide", "cockpit.read"],
};
export const certifier: Principal = {
  kind: "human",
  id: "reviewer-1",
  tenantId: TENANT,
  permissions: [],
};
export const system: Principal = {
  kind: "system",
  id: "execution-fabric",
  tenantId: TENANT,
  permissions: [],
};
export const as = (id: string): Principal => ({
  kind: "agent",
  id,
  tenantId: TENANT,
  permissions: [],
});
export const ALL_TOOLS = [...new Set(bootstrap.skills.flatMap((s) => s.requiredTools))].sort();

export function makeService(store: WorkforceStore = new InMemoryWorkforceStore()) {
  let tick = 0;
  const service = new WorkforceService({
    store,
    bounds: bootstrap.bounds,
    now: () => new Date(T0 + tick++ * 1000).toISOString(),
    // Unique across service instances: two instances share one database in the PG proofs.
    newId: (prefix) => `${prefix}-${randomUUID()}`,
  });
  return { service, store };
}

export const grants = (tools: string[], delegatedBy?: string) =>
  tools.map((toolId) => ({
    toolId,
    grantedBy: { kind: "human" as const, id: "owner-1" },
    grantedAt: "2026-09-29T09:00:00.000Z",
    ...(delegatedBy ? { delegatedBy } : {}),
  }));

export const policyOf = (
  over: Partial<AgentPolicy> & { tools?: string[]; delegatedBy?: string } = {},
): AgentPolicy => ({
  autonomyLevel: over.autonomyLevel ?? 2,
  toolGrants: over.toolGrants ?? grants(over.tools ?? [], over.delegatedBy),
  budget: over.budget ?? { computeUnits: 1000, financialCents: 0 },
  bounds: over.bounds ?? { maxDepth: 4, maxDescendants: 8, maxConcurrentAssignments: 3 },
});

export async function buildOrg(service: WorkforceService, roleIds: string[]) {
  await service.seedBootstrap(owner, bootstrap);
  for (const roleId of ["ICOS_CENTRAL", "INDEPENDENT_REVIEWER", ...roleIds]) {
    const role = bootstrap.roles.find((r) => r.roleId === roleId)!;
    await service.certifyRole(
      certifier,
      roleId,
      "1.0.0",
      requiredRoleTests(role, bootstrap.skills),
    );
    await service.activateRole(owner, roleId, "1.0.0");
  }
  const base = { roleVersion: "1.0.0", memoryScope: { read: ["*"], write: ["*"] } };
  await service.createAgent(owner, {
    ...base,
    agentId: "icos-central",
    kind: "DURABLE_AGENT",
    roleId: "ICOS_CENTRAL",
    displayName: "ICOS Central",
    supervisorAgentId: null,
    scope: { clientIds: ["*"], projectIds: ["*"] },
    policy: policyOf({
      autonomyLevel: 3,
      tools: ALL_TOOLS,
      budget: { computeUnits: 100_000, financialCents: 0 },
      bounds: { maxDepth: 4, maxDescendants: 50, maxConcurrentAssignments: 10 },
    }),
  });
  await service.createAgent(owner, {
    ...base,
    agentId: "central-reviewer",
    kind: "DURABLE_AGENT",
    roleId: "INDEPENDENT_REVIEWER",
    displayName: "Central independent reviewer",
    supervisorAgentId: "icos-central",
    scope: { clientIds: ["*"], projectIds: ["*"] },
    policy: policyOf({
      autonomyLevel: 1,
      tools: ["repo_read"],
      bounds: { maxDepth: 4, maxDescendants: 0, maxConcurrentAssignments: 3 },
    }),
  });
}

/** A department head (human-created Mini-ICOS) under ICOS Central. */
export async function head(
  service: WorkforceService,
  agentId: string,
  roleId: string,
  departmentId: string,
  tools: string[],
  clientIds: string[],
  maxDescendants = 8,
) {
  return service.createAgent(owner, {
    agentId,
    kind: "DURABLE_AGENT",
    roleId,
    roleVersion: "1.0.0",
    displayName: roleId,
    departmentId,
    supervisorAgentId: "icos-central",
    scope: { clientIds, projectIds: ["*"] },
    memoryScope: { read: ["tenant/default"], write: ["tenant/default"] },
    objectives: [`Lead ${departmentId}`],
    policy: policyOf({
      tools,
      bounds: { maxDepth: 3, maxDescendants, maxConcurrentAssignments: 5 },
    }),
  });
}

/** The head spawns a mission-bound specialist with a subset of its own grants. */
export async function specialist(
  service: WorkforceService,
  parentId: string,
  agentId: string,
  roleId: string,
  tools: string[],
  clientIds: string[],
  kind: AgentKind = "EPHEMERAL_SPECIALIST",
  autonomyLevel: 0 | 1 | 2 = 1,
) {
  const spec: AgentSpec = {
    agentId,
    kind,
    roleId,
    roleVersion: "1.0.0",
    displayName: roleId,
    supervisorAgentId: parentId,
    scope: { clientIds, projectIds: ["*"] },
    memoryScope: { read: ["tenant/default"], write: [] },
    missionId: "mission-x",
    expiresAt: "2026-09-30T10:00:00.000Z",
    ...(kind === "EXECUTION_WORKER" ? { workerId: `worker-${agentId}` } : {}),
    policy: policyOf({
      autonomyLevel,
      tools,
      delegatedBy: parentId,
      budget: { computeUnits: 100, financialCents: 0 },
      bounds: { maxDepth: 3, maxDescendants: 0, maxConcurrentAssignments: 3 },
    }),
  };
  return service.createAgent(as(parentId), spec);
}

export const req = (
  missionId: string,
  taskId: string,
  requiredCapabilities: string[],
  clientId: string,
  actionClass?: string,
): WorkRequest => ({
  missionId,
  taskId,
  taskType: taskId,
  requiredCapabilities,
  scope: { clientId },
  computeUnits: 20,
  ...(actionClass ? { actionClass } : {}),
});

/** Runs one assignment through execution (SIMULATED compute) and review. */
export async function execute(
  service: WorkforceService,
  a: WorkAssignment,
  reviewerId: string,
  evidence = [`artifact://${a.taskId}`],
) {
  await service.start(as(a.assigneeAgentId), a.assignmentId);
  await service.recordExecution(system, a.assignmentId, {
    workerId: `hermes-${a.assigneeAgentId}`,
    modelKey: "NOT_CONNECTED/omniroute",
    source: "SIMULATED",
    startedAt: "2026-09-29T10:00:00.000Z",
    finishedAt: "2026-09-29T10:02:00.000Z",
    evidence,
  });
  return service.review(as(reviewerId), a.assignmentId, "APPROVE");
}
