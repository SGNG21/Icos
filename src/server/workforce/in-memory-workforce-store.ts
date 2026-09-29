import type {
  AgentRole,
  Department,
  PerformanceObservation,
  SkillDefinition,
  WorkAssignment,
  WorkforceAgent,
  WorkforceEvent,
} from "@/core/workforce/contracts";

import type { WorkforceStore } from "./ports";

interface State {
  skills: Map<string, SkillDefinition>;
  roles: Map<string, AgentRole>;
  departments: Map<string, Department>;
  agents: Map<string, WorkforceAgent>;
  assignments: Map<string, WorkAssignment>;
  observations: PerformanceObservation[];
  events: WorkforceEvent[];
}

const empty = (): State => ({
  skills: new Map(),
  roles: new Map(),
  departments: new Map(),
  agents: new Map(),
  assignments: new Map(),
  observations: [],
  events: [],
});

const clone = <T>(v: T): T => structuredClone(v);
const k = (...parts: string[]) => parts.join("\u0000");

/**
 * In-memory store for unit tests and `PERSISTENCE=memory`. Transactions are serialised by a
 * promise chain and roll back by restoring a snapshot on throw, so a denied or failed flow
 * leaves no partial write — same contract as the PostgreSQL store.
 */
export class InMemoryWorkforceStore implements WorkforceStore {
  private state: State = empty();
  private chain: Promise<unknown> = Promise.resolve();

  async transaction<T>(_tenantId: string, fn: (tx: WorkforceStore) => Promise<T>): Promise<T> {
    // Nested calls go through the tx view and run inline; concurrent callers queue on the chain.
    const tx: WorkforceStore = Object.create(this, {
      transaction: {
        value: <U>(_t: string, inner: (t: WorkforceStore) => Promise<U>) => inner(tx),
      },
    });
    const run = async () => {
      const snapshot = clone(this.state);
      try {
        return await fn(tx);
      } catch (error) {
        this.state = snapshot;
        throw error;
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  private insertUnique<V>(map: Map<string, V>, key: string, value: V, what: string): void {
    if (map.has(key)) throw new Error(`${what} already exists`);
    map.set(key, clone(value));
  }

  private byTenant<V extends { tenantId: string }>(values: Iterable<V>, tenantId: string): V[] {
    return [...values].filter((v) => v.tenantId === tenantId).map(clone);
  }

  async insertSkill(tenantId: string, skill: SkillDefinition) {
    this.insertUnique(this.state.skills, k(tenantId, skill.skillId, skill.version), skill, "skill");
  }
  async listSkills(tenantId: string) {
    return [...this.state.skills.entries()]
      .filter(([key]) => key.startsWith(k(tenantId, "")))
      .map(([, v]) => clone(v))
      .sort((a, b) => a.skillId.localeCompare(b.skillId) || a.version.localeCompare(b.version));
  }

  async insertRole(tenantId: string, role: AgentRole) {
    this.insertUnique(this.state.roles, k(tenantId, role.roleId, role.version), role, "role");
  }
  async updateRole(tenantId: string, role: AgentRole, expectedStatus: AgentRole["status"]) {
    const key = k(tenantId, role.roleId, role.version);
    if (this.state.roles.get(key)?.status !== expectedStatus) return false;
    this.state.roles.set(key, clone(role));
    return true;
  }
  async getRole(tenantId: string, roleId: string, version: string) {
    const role = this.state.roles.get(k(tenantId, roleId, version));
    return role ? clone(role) : null;
  }
  async listRoles(tenantId: string) {
    return [...this.state.roles.entries()]
      .filter(([key]) => key.startsWith(k(tenantId, "")))
      .map(([, v]) => clone(v))
      .sort((a, b) => a.roleId.localeCompare(b.roleId) || a.version.localeCompare(b.version));
  }

  async insertDepartment(tenantId: string, department: Department) {
    this.insertUnique(
      this.state.departments,
      k(tenantId, department.departmentId),
      department,
      "department",
    );
  }
  async listDepartments(tenantId: string) {
    return [...this.state.departments.entries()]
      .filter(([key]) => key.startsWith(k(tenantId, "")))
      .map(([, v]) => clone(v))
      .sort((a, b) => a.departmentId.localeCompare(b.departmentId));
  }

  async insertAgent(agent: WorkforceAgent) {
    this.insertUnique(this.state.agents, k(agent.tenantId, agent.agentId), agent, "agent");
  }
  async updateAgent(agent: WorkforceAgent, expectedVersion: number) {
    const key = k(agent.tenantId, agent.agentId);
    if (this.state.agents.get(key)?.version !== expectedVersion) return false;
    this.state.agents.set(key, clone(agent));
    return true;
  }
  async getAgent(tenantId: string, agentId: string) {
    const agent = this.state.agents.get(k(tenantId, agentId));
    return agent ? clone(agent) : null;
  }
  async listAgents(tenantId: string) {
    return this.byTenant(this.state.agents.values(), tenantId).sort((a, b) =>
      a.agentId.localeCompare(b.agentId),
    );
  }

  async insertAssignment(assignment: WorkAssignment) {
    this.insertUnique(
      this.state.assignments,
      k(assignment.tenantId, assignment.assignmentId),
      assignment,
      "assignment",
    );
  }
  async updateAssignment(assignment: WorkAssignment, expectedVersion: number) {
    const key = k(assignment.tenantId, assignment.assignmentId);
    if (this.state.assignments.get(key)?.version !== expectedVersion) return false;
    this.state.assignments.set(key, clone(assignment));
    return true;
  }
  async getAssignment(tenantId: string, assignmentId: string) {
    const a = this.state.assignments.get(k(tenantId, assignmentId));
    return a ? clone(a) : null;
  }
  async listAssignments(tenantId: string) {
    return this.byTenant(this.state.assignments.values(), tenantId).sort((a, b) =>
      a.assignmentId.localeCompare(b.assignmentId),
    );
  }

  async appendObservation(observation: PerformanceObservation) {
    this.state.observations.push(clone(observation));
  }
  async listObservations(tenantId: string) {
    return this.byTenant(this.state.observations, tenantId);
  }

  async appendEvent(event: WorkforceEvent) {
    this.state.events.push(clone(event));
  }
  async listEvents(tenantId: string) {
    return this.byTenant(this.state.events, tenantId);
  }
}
