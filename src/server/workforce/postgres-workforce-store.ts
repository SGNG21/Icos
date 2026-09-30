import { and, asc, eq, sql } from "drizzle-orm";

import {
  agentRoleSchema,
  departmentSchema,
  performanceObservationSchema,
  skillDefinitionSchema,
  workAssignmentSchema,
  workforceAgentSchema,
  workforceEventSchema,
  type AgentRole,
  type Department,
  type PerformanceObservation,
  type SkillDefinition,
  type WorkAssignment,
  type WorkforceAgent,
  type WorkforceEvent,
} from "@/core/workforce/contracts";
import type { Database } from "@/server/database/client";
import {
  workforceAgents,
  workforceAssignments,
  workforceDepartments,
  workforceEvents,
  workforceObservations,
  workforceRoles,
  workforceSkills,
} from "@/server/database/workforce-schema";

import type { WorkforceStore } from "./ports";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * PostgreSQL workforce store (migration 0051, decision 0057). Every read is re-validated by
 * Zod; every query carries the tenant predicate. A transaction takes a per-tenant advisory
 * lock so org-wide bounds (max agents, max descendants) are checked on a stable snapshot.
 */
export class PostgresWorkforceStore implements WorkforceStore {
  constructor(
    private readonly db: Database | Tx,
    private readonly inTransaction = false,
  ) {}

  async transaction<T>(tenantId: string, fn: (tx: WorkforceStore) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    return (this.db as Database).transaction(async (tx) => {
      // ponytail: one lock per tenant serialises all workforce writes; per-subtree locks if contention appears.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`icos.workforce:${tenantId}`}))`,
      );
      return fn(new PostgresWorkforceStore(tx, true));
    });
  }

  async insertSkill(tenantId: string, skill: SkillDefinition) {
    const spec = skillDefinitionSchema.parse(skill);
    await this.db
      .insert(workforceSkills)
      .values({ tenantId, skillId: spec.skillId, version: spec.version, spec });
  }
  async listSkills(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceSkills)
      .where(eq(workforceSkills.tenantId, tenantId))
      .orderBy(asc(workforceSkills.skillId), asc(workforceSkills.version));
    return rows.map((r) => skillDefinitionSchema.parse(r.spec));
  }

  async insertRole(tenantId: string, role: AgentRole) {
    const spec = agentRoleSchema.parse(role);
    await this.db
      .insert(workforceRoles)
      .values({ tenantId, roleId: spec.roleId, version: spec.version, status: spec.status, spec });
  }
  async updateRole(tenantId: string, role: AgentRole, expectedStatus: AgentRole["status"]) {
    const spec = agentRoleSchema.parse(role);
    const rows = await this.db
      .update(workforceRoles)
      .set({ status: spec.status, spec, updatedAt: new Date() })
      .where(
        and(
          eq(workforceRoles.tenantId, tenantId),
          eq(workforceRoles.roleId, spec.roleId),
          eq(workforceRoles.version, spec.version),
          eq(workforceRoles.status, expectedStatus),
        ),
      )
      .returning({ roleId: workforceRoles.roleId });
    return rows.length === 1;
  }
  async getRole(tenantId: string, roleId: string, version: string) {
    const rows = await this.db
      .select()
      .from(workforceRoles)
      .where(
        and(
          eq(workforceRoles.tenantId, tenantId),
          eq(workforceRoles.roleId, roleId),
          eq(workforceRoles.version, version),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : agentRoleSchema.parse(rows[0].spec);
  }
  async listRoles(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceRoles)
      .where(eq(workforceRoles.tenantId, tenantId))
      .orderBy(asc(workforceRoles.roleId), asc(workforceRoles.version));
    return rows.map((r) => agentRoleSchema.parse(r.spec));
  }

  async insertDepartment(tenantId: string, department: Department) {
    const spec = departmentSchema.parse(department);
    await this.db
      .insert(workforceDepartments)
      .values({ tenantId, departmentId: spec.departmentId, spec });
  }
  async listDepartments(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceDepartments)
      .where(eq(workforceDepartments.tenantId, tenantId))
      .orderBy(asc(workforceDepartments.departmentId));
    return rows.map((r) => departmentSchema.parse(r.spec));
  }

  private agentRow(agent: WorkforceAgent) {
    const spec = workforceAgentSchema.parse(agent);
    return {
      tenantId: spec.tenantId,
      agentId: spec.agentId,
      kind: spec.kind,
      status: spec.status,
      roleId: spec.roleId,
      roleVersion: spec.roleVersion,
      supervisorAgentId: spec.supervisorAgentId,
      parentAgentId: spec.parentAgentId,
      depth: spec.depth,
      version: spec.version,
      spec,
      createdAt: new Date(spec.createdAt),
      updatedAt: new Date(spec.updatedAt),
    };
  }
  async insertAgent(agent: WorkforceAgent) {
    await this.db.insert(workforceAgents).values(this.agentRow(agent));
  }
  async updateAgent(agent: WorkforceAgent, expectedVersion: number) {
    const row = this.agentRow(agent);
    const rows = await this.db
      .update(workforceAgents)
      .set(row)
      .where(
        and(
          eq(workforceAgents.tenantId, row.tenantId),
          eq(workforceAgents.agentId, row.agentId),
          eq(workforceAgents.version, expectedVersion),
        ),
      )
      .returning({ agentId: workforceAgents.agentId });
    return rows.length === 1;
  }
  async getAgent(tenantId: string, agentId: string) {
    const rows = await this.db
      .select()
      .from(workforceAgents)
      .where(and(eq(workforceAgents.tenantId, tenantId), eq(workforceAgents.agentId, agentId)))
      .limit(1);
    return rows.length === 0 ? null : workforceAgentSchema.parse(rows[0].spec);
  }
  async listAgents(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceAgents)
      .where(eq(workforceAgents.tenantId, tenantId))
      .orderBy(asc(workforceAgents.agentId));
    return rows.map((r) => workforceAgentSchema.parse(r.spec));
  }

  private assignmentRow(assignment: WorkAssignment) {
    const spec = workAssignmentSchema.parse(assignment);
    return {
      tenantId: spec.tenantId,
      assignmentId: spec.assignmentId,
      missionId: spec.missionId,
      taskId: spec.taskId,
      parentAssignmentId: spec.parentAssignmentId,
      supervisorAgentId: spec.supervisorAgentId,
      assigneeAgentId: spec.assigneeAgentId,
      status: spec.status,
      version: spec.version,
      spec,
      createdAt: new Date(spec.createdAt),
      updatedAt: new Date(spec.updatedAt),
    };
  }
  async insertAssignment(assignment: WorkAssignment) {
    await this.db.insert(workforceAssignments).values(this.assignmentRow(assignment));
  }
  async updateAssignment(assignment: WorkAssignment, expectedVersion: number) {
    const row = this.assignmentRow(assignment);
    const rows = await this.db
      .update(workforceAssignments)
      .set(row)
      .where(
        and(
          eq(workforceAssignments.tenantId, row.tenantId),
          eq(workforceAssignments.assignmentId, row.assignmentId),
          eq(workforceAssignments.version, expectedVersion),
        ),
      )
      .returning({ assignmentId: workforceAssignments.assignmentId });
    return rows.length === 1;
  }
  async getAssignment(tenantId: string, assignmentId: string) {
    const rows = await this.db
      .select()
      .from(workforceAssignments)
      .where(
        and(
          eq(workforceAssignments.tenantId, tenantId),
          eq(workforceAssignments.assignmentId, assignmentId),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : workAssignmentSchema.parse(rows[0].spec);
  }
  async listAssignments(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceAssignments)
      .where(eq(workforceAssignments.tenantId, tenantId))
      .orderBy(asc(workforceAssignments.assignmentId));
    return rows.map((r) => workAssignmentSchema.parse(r.spec));
  }

  async appendObservation(observation: PerformanceObservation) {
    const spec = performanceObservationSchema.parse(observation);
    await this.db.insert(workforceObservations).values({
      tenantId: spec.tenantId,
      observationId: spec.observationId,
      agentId: spec.agentId,
      assignmentId: spec.assignmentId,
      spec,
      observedAt: new Date(spec.observedAt),
    });
  }
  async listObservations(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceObservations)
      .where(eq(workforceObservations.tenantId, tenantId))
      .orderBy(asc(workforceObservations.observedAt), asc(workforceObservations.observationId));
    return rows.map((r) => performanceObservationSchema.parse(r.spec));
  }

  async appendEvent(event: WorkforceEvent) {
    const e = workforceEventSchema.parse(event);
    await this.db.insert(workforceEvents).values({
      tenantId: e.tenantId,
      eventId: e.eventId,
      type: e.type,
      actorKind: e.actor.kind,
      actorId: e.actor.id,
      subjectId: e.subjectId,
      details: e.details,
      occurredAt: new Date(e.occurredAt),
    });
  }
  async listEvents(tenantId: string) {
    const rows = await this.db
      .select()
      .from(workforceEvents)
      .where(eq(workforceEvents.tenantId, tenantId))
      .orderBy(asc(workforceEvents.seq));
    return rows.map((r) =>
      workforceEventSchema.parse({
        eventId: r.eventId,
        tenantId: r.tenantId,
        type: r.type,
        actor: { kind: r.actorKind, id: r.actorId },
        subjectId: r.subjectId,
        details: r.details,
        occurredAt: r.occurredAt.toISOString(),
      }),
    );
  }
}
