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
    name: text("name").notNull(), // @classification C3
    role: text("role").notNull(),
    status: text("status").notNull(),
    authorizationLevel: smallint("authorization_level").notNull(),
    description: text("description").notNull(), // @classification C3
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
    title: text("title").notNull(), // @classification C3
    description: text("description"), // @classification C3
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
    reason: text("reason"), // @classification C3
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
    details: jsonb("details").notNull(), // @classification C2
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "audit_event_type_check",
      sql`${t.eventType} in ('task.created','task.transitioned','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked','skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed','skill.security_scan_recorded','skill.eval_recorded','mission.created','mission.transitioned','mission.plan_set','tool.invocation_reserved','tool.invocation_started','tool.invocation_completed','tool.invocation_failed','tool.invocation_unknown')`,
    ),
    check("audit_actor_type_check", sql`${t.actorType} in ('agent','human','system')`),
    index("audit_event_type_idx").on(t.eventType),
    index("audit_action_idx").on(t.actionId),
    index("audit_task_idx").on(t.taskId),
    index("audit_actor_label_idx").on(t.actorLabel),
    index("audit_occurred_at_idx").on(t.occurredAt),
  ],
);

export const capabilities = pgTable(
  "capabilities",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(), // @classification C3
    description: text("description"), // @classification C3
    category: text("category").notNull(),
    status: text("status").notNull(),
    provenance: jsonb("provenance"),
    riskHint: text("risk_hint"),
    // COMPLIANCE-1 — Classification des données
    sensitivityLevel: text("sensitivity_level"),
    dataCategory: text("data_category"),
    // COMPLIANCE-1 — Politique de rétention pour C3
    retentionPolicyRef: jsonb("retention_policy_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("capabilities_key_unique").on(t.key),
    check(
      "capabilities_status_check",
      sql`${t.status} in ('proposed','active','deprecated','retired')`,
    ),
    check("capabilities_sensitivity_level_check", sql`${t.sensitivityLevel} is null or ${t.sensitivityLevel} in ('C0','C1','C2','C3')`),
    check("capabilities_data_category_check", sql`${t.dataCategory} is null or ${t.dataCategory} in ('PUBLIC','INTERNAL','PERSONAL','SENSITIVE_PERSONAL','CONFIDENTIAL_CLIENT','AUTH_SECRET','FINANCIAL','LEGAL','HEALTH','HR','CHILD_DATA','BIOMETRIC','DERIVED_PROFILE')`),
    index("capabilities_status_idx").on(t.status),
    index("capabilities_sensitivity_level_idx").on(t.sensitivityLevel),
  ],
);

export const agentCapabilities = pgTable(
  "agent_capabilities",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "restrict" }),
    capabilityId: text("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull(),
    assignedByUserId: text("assigned_by_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("agent_capabilities_agent_capability_unique").on(t.agentId, t.capabilityId),
    index("agent_capabilities_agent_idx").on(t.agentId),
    index("agent_capabilities_capability_idx").on(t.capabilityId),
  ],
);

// ─────────────────────────────────────
// C2 — Skill Registry & Trust Lifecycle
// ─────────────────────────────────────

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    skillKey: text("skill_key").notNull(),
    version: text("version").notNull(),
    name: text("name").notNull(), // @classification C3
    description: text("description"), // @classification C3
    capabilityKeys: jsonb("capability_keys").notNull().default([]),
    category: text("category").notNull(),
    trustState: text("trust_state").notNull(),
    activationState: text("activation_state").notNull(),
    scripts: jsonb("scripts"),
    resources: jsonb("resources"),
    references: jsonb("references"),
    dependencyDeclarations: jsonb("dependency_declarations"),
    networkRequirements: jsonb("network_requirements"),
    credentialRequirements: jsonb("credential_requirements"),
    executionIsolationRequirement: jsonb("execution_isolation_requirement"),
    toolRequirements: jsonb("tool_requirements"),
    inputSchema: jsonb("input_schema"),
    outputSchema: jsonb("output_schema"),
    dataCategory: text("data_category"),
    sensitivityLevel: text("sensitivity_level"),
    contentHash: text("content_hash").notNull(), // @classification C2
    provenance: jsonb("provenance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("skills_tenant_key_version_unique").on(t.tenantId, t.skillKey, t.version),
    check("skills_trust_state_check", sql`${t.trustState} in ('untrusted','quarantined','reviewed','approved','rejected')`),
    check("skills_activation_state_check", sql`${t.activationState} in ('inactive','active','suspended','revoked')`),
    check("skills_data_category_check", sql`${t.dataCategory} is null or ${t.dataCategory} in ('PUBLIC','INTERNAL','PERSONAL','SENSITIVE_PERSONAL','CONFIDENTIAL_CLIENT','AUTH_SECRET','FINANCIAL','LEGAL','HEALTH','HR','CHILD_DATA','BIOMETRIC','DERIVED_PROFILE')`),
    check("skills_sensitivity_level_check", sql`${t.sensitivityLevel} is null or ${t.sensitivityLevel} in ('C0','C1','C2','C3')`),
    index("skills_trust_state_idx").on(t.trustState),
    index("skills_activation_state_idx").on(t.activationState),
    index("skills_skill_key_idx").on(t.skillKey),
    index("skills_content_hash_idx").on(t.contentHash),
  ],
);

export const skillSecurityScans = pgTable(
  "skill_security_scans",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "restrict" }),
    evaluatedContentHash: text("evaluated_content_hash").notNull(),
    scannerId: text("scanner_id").notNull(),
    scannerVersion: text("scanner_version"),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata"), // @classification C2
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("skill_security_scans_status_check", sql`${t.status} in ('running','passed','failed','error')`),
    index("skill_security_scans_skill_hash_idx").on(t.skillId, t.evaluatedContentHash),
  ],
);

export const skillSecurityFindings = pgTable(
  "skill_security_findings",
  {
    id: text("id").primaryKey(),
    scanId: text("scan_id")
      .notNull()
      .references(() => skillSecurityScans.id, { onDelete: "restrict" }),
    severity: text("severity").notNull(),
    category: text("category").notNull(),
    code: text("code"),
    message: text("message").notNull(), // @classification C3
    location: text("location"),
    metadata: jsonb("metadata"), // @classification C2
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("skill_security_findings_severity_check", sql`${t.severity} in ('low','medium','high','critical')`),
    index("skill_security_findings_scan_idx").on(t.scanId),
  ],
);

export const skillEvaluations = pgTable(
  "skill_evaluations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "restrict" }),
    evaluatedContentHash: text("evaluated_content_hash").notNull(),
    evaluatorType: text("evaluator_type").notNull(),
    evaluatorVersion: text("evaluator_version"),
    status: text("status").notNull(),
    score: jsonb("score"), // @classification C2
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata"), // @classification C2
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("skill_evaluations_status_check", sql`${t.status} in ('running','passed','failed','error')`),
    index("skill_evaluations_skill_hash_idx").on(t.skillId, t.evaluatedContentHash),
  ],
);
