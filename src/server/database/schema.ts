import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";

/**
 * Schéma Drizzle de la persistance ICOS (Lot 2A-2a).
 *
 * Divergences de nommage SQL ↔ domaine (voir mappers + ADR-0005) :
 * - `actions.created_at` porte la valeur métier `AgentAction.requestedAt` ;
 * - `actions.updated_at` trace les changements de statut (métadonnée, non
 *   surfacée dans le contrat) ;
 * - `Task.actionIds` n'est PAS persisté : la seule source de vérité de la
 *   relation tâche↔actions est `actions.task_id` ; `actionIds` est dérivé en
 *   lecture.
 */

export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(),
    authorizationLevel: smallint("authorization_level").notNull(),
    description: text("description").notNull(),
  },
  (t) => [
    check("agents_status_check", sql`${t.status} in ('available','standby','offline')`),
    check("agents_auth_level_check", sql`${t.authorizationLevel} between 0 and 3`),
  ],
);

export const humanAgentLinks = pgTable(
  "human_agent_links",
  {
    id: text("id").primaryKey(),
    humanUserId: text("human_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    relation: text("relation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    createdByHumanUserId: text("created_by_human_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("human_agent_links_human_user_agent_unique").on(t.humanUserId, t.agentId),
    check(
      "human_agent_links_relation_check",
      sql`${t.relation} in ('supervisor','operator','observer')`,
    ),
    index("human_agent_links_human_user_idx").on(t.humanUserId),
    index("human_agent_links_agent_idx").on(t.agentId),
    index("human_agent_links_created_by_idx").on(t.createdByHumanUserId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull(),
    assignedAgentId: text("assigned_agent_id").references(() => agents.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "tasks_status_check",
      sql`${t.status} in ('draft','queued','awaiting_approval','running','succeeded','failed','cancelled')`,
    ),
    index("tasks_assigned_agent_idx").on(t.assignedAgentId),
  ],
);

export const actions = pgTable(
  "actions",
  {
    id: text("id").primaryKey(),
    initiatedByAgentId: text("initiated_by_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    risk: text("risk").notNull(),
    requiresHumanApproval: boolean("requires_human_approval").notNull(),
    approvalStatus: text("approval_status").notNull(),
    // Porte la valeur métier `requestedAt` (divergence documentée).
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("actions_risk_check", sql`${t.risk} in ('read_only','reversible','sensitive')`),
    check(
      "actions_approval_status_check",
      sql`${t.approvalStatus} in ('not_required','pending','approved','rejected')`,
    ),
    index("actions_task_idx").on(t.taskId),
    index("actions_approval_status_idx").on(t.approvalStatus),
    index("actions_initiator_idx").on(t.initiatedByAgentId),
  ],
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id")
      .notNull()
      .references(() => actions.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    decidedByLabel: text("decided_by_label").notNull(),
    reason: text("reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("approvals_decision_check", sql`${t.decision} in ('approved','rejected')`),
    // Au plus une décision définitive par action.
    unique("approvals_action_id_unique").on(t.actionId),
  ],
);

export const auditEntries = pgTable(
  "audit_entries",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorLabel: text("actor_label").notNull(),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "restrict" }),
    actionId: text("action_id").references(() => actions.id, { onDelete: "restrict" }),
    details: jsonb("details").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "audit_event_type_check",
      sql`${t.eventType} in ('task.created','task.transitioned','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied')`,
    ),
    check("audit_actor_type_check", sql`${t.actorType} in ('agent','human','system')`),
    index("audit_event_type_idx").on(t.eventType),
    index("audit_action_idx").on(t.actionId),
    index("audit_task_idx").on(t.taskId),
    index("audit_actor_label_idx").on(t.actorLabel),
    index("audit_occurred_at_idx").on(t.occurredAt),
  ],
);
