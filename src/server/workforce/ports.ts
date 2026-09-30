import type {
  AgentRole,
  Department,
  PerformanceObservation,
  SkillDefinition,
  WorkAssignment,
  WorkforceAgent,
  WorkforceEvent,
} from "@/core/workforce/contracts";

/**
 * Durable store behind the digital workforce (decision 0057). Tenant-scoped: every call takes
 * the tenant explicitly and implementations filter on it — no tenant, no operation.
 *
 * Writes of agents, roles and assignments are compare-and-set (`expected*`): a stale writer
 * gets `false` and nothing changes. Events and observations are append-only.
 *
 * `transaction` serialises every workforce write of one tenant (bounds such as max agents and
 * max descendants are checked against a consistent org snapshot).
 */
export interface WorkforceStore {
  transaction<T>(tenantId: string, fn: (tx: WorkforceStore) => Promise<T>): Promise<T>;

  insertSkill(tenantId: string, skill: SkillDefinition): Promise<void>;
  listSkills(tenantId: string): Promise<SkillDefinition[]>;

  insertRole(tenantId: string, role: AgentRole): Promise<void>;
  updateRole(
    tenantId: string,
    role: AgentRole,
    expectedStatus: AgentRole["status"],
  ): Promise<boolean>;
  getRole(tenantId: string, roleId: string, version: string): Promise<AgentRole | null>;
  listRoles(tenantId: string): Promise<AgentRole[]>;

  insertDepartment(tenantId: string, department: Department): Promise<void>;
  listDepartments(tenantId: string): Promise<Department[]>;

  insertAgent(agent: WorkforceAgent): Promise<void>;
  updateAgent(agent: WorkforceAgent, expectedVersion: number): Promise<boolean>;
  getAgent(tenantId: string, agentId: string): Promise<WorkforceAgent | null>;
  listAgents(tenantId: string): Promise<WorkforceAgent[]>;

  insertAssignment(assignment: WorkAssignment): Promise<void>;
  updateAssignment(assignment: WorkAssignment, expectedVersion: number): Promise<boolean>;
  getAssignment(tenantId: string, assignmentId: string): Promise<WorkAssignment | null>;
  listAssignments(tenantId: string): Promise<WorkAssignment[]>;

  appendObservation(observation: PerformanceObservation): Promise<void>;
  listObservations(tenantId: string): Promise<PerformanceObservation[]>;

  appendEvent(event: WorkforceEvent): Promise<void>;
  listEvents(tenantId: string): Promise<WorkforceEvent[]>;
}
