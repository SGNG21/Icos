import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Digital workforce schema (decision 0057, migration drizzle/0051_digital_workforce.sql).
 * Separate file, like `memory-schema.ts`, to stay out of the way of the other lanes.
 *
 * TENANT: `tenant_id` is part of every primary and foreign key and every query predicate.
 * RLS is not enabled (none exists in ICOS yet; COMPLIANCE-1).
 *
 * `spec` holds the full Zod-validated contract; the scalar columns are the keys the
 * database must enforce (identity, lineage, status, optimistic version). Both are written
 * from the same parsed object and every row read back is re-validated.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

export const workforceSkills = pgTable(
  "workforce_skills",
  {
    tenantId: text("tenant_id").notNull(),
    skillId: text("skill_id").notNull(),
    version: text("version").notNull(),
    spec: jsonb("spec").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.skillId, t.version] })],
);

export const workforceRoles = pgTable(
  "workforce_roles",
  {
    tenantId: text("tenant_id").notNull(),
    roleId: text("role_id").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull(),
    spec: jsonb("spec").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.roleId, t.version] }),
    check(
      "workforce_roles_status_check",
      sql`${t.status} in ('draft','certified','active','retired')`,
    ),
  ],
);

export const workforceDepartments = pgTable(
  "workforce_departments",
  {
    tenantId: text("tenant_id").notNull(),
    departmentId: text("department_id").notNull(),
    spec: jsonb("spec").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.departmentId] })],
);

export const workforceAgents = pgTable(
  "workforce_agents",
  {
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    roleId: text("role_id").notNull(),
    roleVersion: text("role_version").notNull(),
    supervisorAgentId: text("supervisor_agent_id"),
    parentAgentId: text("parent_agent_id"),
    depth: integer("depth").notNull(),
    version: integer("version").notNull(),
    spec: jsonb("spec").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.agentId] }),
    foreignKey({
      columns: [t.tenantId, t.roleId, t.roleVersion],
      foreignColumns: [workforceRoles.tenantId, workforceRoles.roleId, workforceRoles.version],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.supervisorAgentId],
      foreignColumns: [t.tenantId, t.agentId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.parentAgentId],
      foreignColumns: [t.tenantId, t.agentId],
    }).onDelete("restrict"),
    check(
      "workforce_agents_kind_check",
      sql`${t.kind} in ('DURABLE_AGENT','EPHEMERAL_SPECIALIST','EXECUTION_WORKER')`,
    ),
    check(
      "workforce_agents_status_check",
      sql`${t.status} in ('active','suspended','retired','blocked')`,
    ),
    check(
      "workforce_agents_depth_check",
      sql`${t.depth} >= 0 and ((${t.supervisorAgentId} is null) = (${t.depth} = 0))`,
    ),
    index("workforce_agents_supervisor_idx").on(t.tenantId, t.supervisorAgentId),
  ],
);

export const workforceAssignments = pgTable(
  "workforce_assignments",
  {
    tenantId: text("tenant_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    missionId: text("mission_id").notNull(),
    taskId: text("task_id").notNull(),
    parentAssignmentId: text("parent_assignment_id"),
    supervisorAgentId: text("supervisor_agent_id").notNull(),
    assigneeAgentId: text("assignee_agent_id").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull(),
    spec: jsonb("spec").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.assignmentId] }),
    foreignKey({
      columns: [t.tenantId, t.parentAssignmentId],
      foreignColumns: [t.tenantId, t.assignmentId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.supervisorAgentId],
      foreignColumns: [workforceAgents.tenantId, workforceAgents.agentId],
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.tenantId, t.assigneeAgentId],
      foreignColumns: [workforceAgents.tenantId, workforceAgents.agentId],
    }).onDelete("restrict"),
    check(
      "workforce_assignments_status_check",
      sql`${t.status} in ('assigned','executing','in_review','changes_requested','accepted','blocked','synthesized','cancelled')`,
    ),
    index("workforce_assignments_mission_idx").on(t.tenantId, t.missionId),
    index("workforce_assignments_assignee_idx").on(t.tenantId, t.assigneeAgentId),
  ],
);

export const workforceObservations = pgTable(
  "workforce_performance_observations",
  {
    tenantId: text("tenant_id").notNull(),
    observationId: text("observation_id").notNull(),
    agentId: text("agent_id").notNull(),
    assignmentId: text("assignment_id").notNull(),
    spec: jsonb("spec").notNull(),
    observedAt: ts("observed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.observationId] }),
    foreignKey({
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [workforceAssignments.tenantId, workforceAssignments.assignmentId],
    }).onDelete("restrict"),
  ],
);

export const workforceEvents = pgTable(
  "workforce_events",
  {
    tenantId: text("tenant_id").notNull(),
    eventId: text("event_id").notNull(),
    seq: integer("seq").generatedAlwaysAsIdentity(),
    type: text("type").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id").notNull(),
    subjectId: text("subject_id").notNull(),
    details: jsonb("details").notNull(),
    occurredAt: ts("occurred_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.eventId] }),
    check("workforce_events_actor_kind_check", sql`${t.actorKind} in ('human','agent','system')`),
    index("workforce_events_subject_idx").on(t.tenantId, t.subjectId),
  ],
);
