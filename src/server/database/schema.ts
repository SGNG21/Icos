import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  foreignKey,
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
 *   tâche↔actions est `actions.task_id` ; `actionIds` est dérivé en
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
    /*
     * CORE3 planning metadata (migration 0041).
     *
     * Before 0041 these existed only in the Task domain contract: they were
     * built by prepareTaskCreation, validated, then silently DROPPED by
     * taskToRow, so nothing survived a restart. Persisted here so planner
     * output is durable and readable back.
     *
     * Nullable / defaulted: a generic (non-autonomous) Task carries no
     * mission, goal or plan lineage.
     */
    missionId: text("mission_id"),
    goalId: text("goal_id"),
    planId: text("plan_id"),
    objective: text("objective"),
    instructions: text("instructions"),
    /*
     * NON-AUTHORITATIVE (decision 0030). The canonical autonomous DAG is
     * mission_tasks.depends_on. Advisory only; never consulted for readiness.
     */
    dependencies: jsonb("dependencies").default([]).notNull(),
    successCriteria: jsonb("success_criteria").default([]).notNull(),
    requiredCapabilities: jsonb("required_capabilities").default([]).notNull(),
    riskClass: text("risk_class").default("reversible").notNull(),
    allowedFileScope: jsonb("allowed_file_scope").default([]).notNull(),
    expectedArtifacts: jsonb("expected_artifacts").default([]).notNull(),
    priority: integer("priority").default(3).notNull(),
    attemptBudget: integer("attempt_budget").default(3).notNull(),
    reviewPolicy: text("review_policy").default("if_risky").notNull(),
    integrationPolicy: text("integration_policy").default("").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "tasks_status_check",
      sql`${t.status} in ('draft','queued','awaiting_approval','running','review_pending','succeeded','failed','cancelled','superseded')`,
    ),
    /*
     * Fail closed at the database boundary too: an unknown risk class or
     * review policy cannot be stored, even by a caller that bypasses
     * validateMissionPlan.
     */
    check(
      "tasks_risk_class_check",
      sql`${t.riskClass} in ('read_only','reversible','sensitive')`,
    ),
    check(
      "tasks_review_policy_check",
      sql`${t.reviewPolicy} in ('never','if_risky','always')`,
    ),
    check("tasks_priority_check", sql`${t.priority} between 1 and 5`),
    check("tasks_attempt_budget_check", sql`${t.attemptBudget} >= 1`),
    index("tasks_assigned_agent_idx").on(t.assignedAgentId),
    index("tasks_mission_id_idx").on(t.missionId),
    index("tasks_plan_id_idx").on(t.planId),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
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
    missionId: text("mission_id"),
    performedBy: text("performed_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [
    check(
      "audit_event_type_check",
      sql`${t.eventType} in ('task.created','task.transitioned','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked','skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed','skill.security_scan_recorded','skill.eval_recorded')`,
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
    name: text("name").notNull(),
    description: text("description"),
    category: text("category").notNull(),
    status: text("status").notNull(),
    provenance: jsonb("provenance"),
    riskHint: text("risk_hint"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("capabilities_key_unique").on(t.key),
    check(
      "capabilities_status_check",
      sql`${t.status} in ('proposed','active','deprecated','retired')`,
    ),
    index("capabilities_status_idx").on(t.status),
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

export const skills = pgTable(
  "skills",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    skillKey: text("skill_key").notNull(),
    version: text("version").notNull(),
    name: text("name").notNull(),
    description: text("description"),
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
    contentHash: text("content_hash").notNull(),
    provenance: jsonb("provenance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("skills_tenant_key_version_unique").on(t.tenantId, t.skillKey, t.version),
    check("skills_trust_state_check", sql`${t.trustState} in ('untrusted','quarantined','reviewed','approved','rejected')`),
    check("skills_activation_state_check", sql`${t.activationState} in ('inactive','active','suspended','revoked')`),
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
    metadata: jsonb("metadata"),
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
    message: text("message").notNull(),
    location: text("location"),
    metadata: jsonb("metadata"),
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
    score: jsonb("score"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("skill_evaluations_status_check", sql`${t.status} in ('running','passed','failed','error')`),
    index("skill_evaluations_skill_hash_idx").on(t.skillId, t.evaluatedContentHash),
  ],
);

export const checkpoints = pgTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    state: jsonb("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    label: text("label"),
  },
  (t) => [
    index("checkpoints_mission_id_idx").on(t.missionId),
    index("checkpoints_created_at_idx").on(t.createdAt),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("conversations_updated_at_idx").on(t.updatedAt)],
);

export const missionTasks = pgTable(
  "mission_tasks",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /*
     * CANONICAL autonomous DAG edges (decision 0030): MissionTask.id values
     * resolved from planner keys. The single authority for task readiness;
     * computeReadyTasks() reads only this.
     */
    dependsOn: jsonb("depends_on").default([]).notNull(),
    status: text("status").notNull(),
    workerKind: text("worker_kind"),
    capability: text("capability"),
    taskId: text("task_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "mission_tasks_status_check",
      sql`${t.status} in ('draft','queued','awaiting_approval','running','review_pending','succeeded','failed','cancelled','blocked','superseded')`,
    ),
    index("mission_tasks_mission_idx").on(t.missionId),
    index("mission_tasks_status_idx").on(t.status),
  ],
);

export const handoffPackages = pgTable(
  "handoff_packages",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    fromAgent: text("from_agent").notNull(),
    toAgent: text("to_agent").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    reason: text("reason").notNull(),
    instructions: text("instructions"),
    missionContext: jsonb("mission_context").notNull(),
    workingMemorySlice: jsonb("working_memory_slice"),
    durableRefs: jsonb("durable_refs").notNull(),
  },
  (t) => [
    index("handoff_packages_mission_id_idx").on(t.missionId),
    index("handoff_packages_from_agent_idx").on(t.fromAgent),
    index("handoff_packages_to_agent_idx").on(t.toAgent),
  ],
);

export const missions = pgTable(
  "missions",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    status: text("status").notNull(),
    /*
     * CORE3 lineage: the goal this mission serves and the mission's CURRENT
     * autonomous plan version. snake_case column names, matching the rest of
     * this table (created_at, user_id) and migration 0040.
     */
    goalId: text("goal_id"),
    planId: text("plan_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    userId: text("user_id")
      .notNull()
      .default("00000000-0000-0000-0000-000000000000"),
  },
  (t) => [
    check(
      "missions_status_check",
      sql`${t.status} in ('draft','planning','ready','running','blocked','awaiting_approval','succeeded','failed','cancelled')`,
    ),
    index("missions_status_idx").on(t.status),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    missionId: text("missionId").notNull(),
    taskId: text("taskId").notNull(),
    decision: text("decision").notNull(),
    reviewerKind: text("reviewerKind").notNull(),
    severity: text("severity").notNull(),
    reasons: text("reasons").array().notNull(),
    requestedChanges: jsonb("requestedChanges"),
    evidenceRefs: text("evidenceRefs").array(),
    findingRefs: text("findingRefs").array(),
    policyRefs: text("policyRefs").array(),
    providerMetadata: jsonb("providerMetadata"),
    confidence: doublePrecision("confidence"),
    createdAt: timestamp("createdAt", { withTimezone: true }).notNull(),
    humanOverridden: boolean("humanOverridden").notNull().default(false),
    overriddenBy: text("overriddenBy"),
    workflowId: text("workflowId").notNull(),
  },
  (t) => [
    index("decisions_missionId_idx").on(t.missionId),
    index("decisions_taskId_idx").on(t.taskId),
    unique("decisions_workflowId_unique").on(t.workflowId),
    check("decisions_reviewerKind_check", sql`${t.reviewerKind} in ('deterministic','llm')`),
    check("decisions_severity_check", sql`${t.severity} in ('info','warning','critical')`),
    check("decisions_decision_check", sql`${t.decision} in ('APPROVE','REQUEST_CHANGES','RETRY','REPLAN','BLOCK','ESCALATE_TO_HUMAN')`),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("messages_role_check", sql`${t.role} in ('user','assistant','system')`),
    index("messages_conversation_idx").on(t.conversationId),
    index("messages_created_at_idx").on(t.createdAt),
  ],
);

export const learnedPatterns = pgTable(
  "learned_patterns",
  {
    id: text("id").primaryKey(),
    capability: text("capability"),
    workerKind: text("worker_kind"),
    signature: text("signature").notNull(),
    description: text("description"),
    outcome: text("outcome").notNull(),
    observations: jsonb("observations").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("learned_patterns_capability_idx").on(t.capability),
    index("learned_patterns_worker_kind_idx").on(t.workerKind),
  ],
);

export const contextItems = pgTable(
  "context_items",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    scope: text("scope").notNull(),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    contentReference: text("content_reference"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    priority: integer("priority").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
  },
  (t) => [
    index("context_items_mission_id_idx").on(t.missionId),
    index("context_items_scope_idx").on(t.scope),
    index("context_items_type_idx").on(t.type),
  ],
);

export const autonomousMissionRuntime = pgTable(
  "autonomous_mission_runtime",
  {
    missionId: text("mission_id")
      .primaryKey()
      .references(() => missions.id, {
        onDelete: "cascade",
      }),

    state: text("state").notNull(),

    startedAt: timestamp("started_at", {
      withTimezone: true,
    }).notNull(),

    updatedAt: timestamp("updated_at", {
      withTimezone: true,
    }).notNull(),

    lastHeartbeatAt: timestamp(
      "last_heartbeat_at",
      {
        withTimezone: true,
      },
    ).notNull(),

    lastProgressAt: timestamp(
      "last_progress_at",
      {
        withTimezone: true,
      },
    ).notNull(),

    cycleCount: integer("cycle_count")
      .notNull(),

    replanCount: integer("replan_count")
      .notNull(),

    stagnationCount: integer(
      "stagnation_count",
    ).notNull(),

    maxCycles: integer("max_cycles")
      .notNull(),

    maxReplans: integer("max_replans")
      .notNull(),

    maxRuntimeMs: integer(
      "max_runtime_ms",
    ).notNull(),

    maxStagnationCycles: integer(
      "max_stagnation_cycles",
    ).notNull(),

    lastFingerprint: text(
      "last_fingerprint",
    ),

    lastReason: text("last_reason"),

    ownerToken: text("owner_token"),

    leaseUntil: timestamp(
      "lease_until",
      {
        withTimezone: true,
      },
    ),
    workerId: text("worker_id"),
    workspaceId: text("workspace_id"),
    attemptId: text("attempt_id"),
    workflowId: text("workflow_id"),
  },
  (t) => [
    check(
      "autonomous_mission_runtime_state_check",
      sql`${t.state} in (
        'running',
        'waiting',
        'replanning',
        'succeeded',
        'failed',
        'blocked',
        'cancelled',
        'escalated'
      )`,
    ),

    check(
      "autonomous_mission_runtime_cycle_count_check",
      sql`${t.cycleCount} >= 0`,
    ),

    check(
      "autonomous_mission_runtime_replan_count_check",
      sql`${t.replanCount} >= 0`,
    ),

    check(
      "autonomous_mission_runtime_stagnation_count_check",
      sql`${t.stagnationCount} >= 0`,
    ),

    check(
      "autonomous_mission_runtime_max_cycles_check",
      sql`${t.maxCycles} >= 1`,
    ),

    check(
      "autonomous_mission_runtime_max_replans_check",
      sql`${t.maxReplans} >= 0`,
    ),

    check(
      "autonomous_mission_runtime_max_runtime_ms_check",
      sql`${t.maxRuntimeMs} >= 1`,
    ),

    check(
      "autonomous_mission_runtime_max_stagnation_check",
      sql`${t.maxStagnationCycles} >= 1`,
    ),

    index(
      "autonomous_mission_runtime_state_idx",
    ).on(t.state),

    index(
      "autonomous_mission_runtime_heartbeat_idx",
    ).on(t.lastHeartbeatAt),

    index(
      "autonomous_mission_runtime_lease_idx",
    ).on(t.leaseUntil),
  ],
);

export const dispatchAttempts = pgTable(
  "dispatch_attempts",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    missionTaskId: text("mission_task_id")
      .notNull()
      .references(() => missionTasks.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    attempt: integer("attempt").notNull(),
    workflowId: text("workflow_id").notNull(),
    prompt: text("prompt").notNull(),
    workerKind: text("worker_kind"),
    /*
     * WHICH worker this attempt was assigned to (migration 0044, defect 12).
     * Deliberately NOT a foreign key: attribution must outlive the worker, and a
     * reference would either block deregistration or erase the historical record
     * of who did the work. Routing reads it only to COUNT load, never to decide
     * eligibility.
     */
    workerId: text("worker_id"),
    capability: text("capability"),
    state: text("state").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    lastError: text("last_error"),
    claimToken: text("claim_token"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
  },
  (t) => [
    unique("dispatch_attempts_workflow_id_unique").on(t.workflowId),
    unique(
      "dispatch_attempts_mission_task_attempt_unique"
    ).on(t.missionTaskId, t.attempt),
    check(
      "dispatch_attempts_attempt_check",
      sql`${t.attempt} >= 1`,
    ),
    check(
      "dispatch_attempts_state_check",
      sql`${t.state} in ('prepared','dispatched','completed','failed')`,
    ),
    index("dispatch_attempts_mission_idx").on(t.missionId),
    index("dispatch_attempts_state_idx").on(t.state),
    /* Durable load is a count of non-terminal attempts per worker. */
    index("dispatch_attempts_worker_active_idx").on(t.workerId, t.state),
  ],
);

export const taskExecutionResults = pgTable(
  "task_execution_results",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    workflowId: text("workflow_id").notNull(),
    outcome: text("outcome").notNull(),
    workerKind: text("worker_kind"),
    capability: text("capability"),
    digitalosExecutionId: text("digitalos_execution_id"),
    result: text("result"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    observations: jsonb("observations"),
    confidence: doublePrecision("confidence"),
    artifacts: jsonb("artifacts"),
    evidence: jsonb("evidence"),
    findings: jsonb("findings"),
  },
  (t) => [
    unique("task_execution_results_workflow_id_unique").on(t.workflowId),
    check(
      "task_execution_results_outcome_check",
      sql`${t.outcome} in ('success','failure')`,
    ),
    check(
      "task_execution_results_worker_kind_check",
      sql`${t.workerKind} is null or ${t.workerKind} in ('hermes','openhands','digitalos','other','agent')`,
    ),
    check(
      "task_execution_results_error_consistency_check",
      sql`((${t.outcome} = 'failure' and ${t.errorCode} is not null and ${t.errorMessage} is not null) or (${t.outcome} = 'success' and ${t.errorCode} is null and ${t.errorMessage} is null))`,
    ),
    check(
      "task_execution_results_error_code_check",
      sql`${t.errorCode} is null or ${t.errorCode} in ('WORKER_FAILED','WORKER_TIMEOUT','WORKER_UNAVAILABLE','INVALID_RESULT','UNKNOWN_EFFECT','CANCELLED','INTERNAL_ERROR')`,
    ),
    index("task_execution_results_task_idx").on(t.taskId),
  ],
);

export const qualityControlJobs = pgTable(
  "quality_control_jobs",
  {
    workflowId: text("workflow_id").primaryKey(),
    executionResultId: text("execution_result_id")
      .notNull()
      .references(() => taskExecutionResults.id, { onDelete: "restrict" }),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    missionTaskId: text("mission_task_id")
      .notNull()
      .references(() => missionTasks.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "restrict" }),
    executionAttempt: integer("execution_attempt").notNull(),
    reviewAttemptCount: integer("review_attempt_count").notNull().default(0),
    state: text("state").notNull(),
    reviewDecisionId: text("review_decision_id").references(() => decisions.id, {
      onDelete: "restrict",
    }),
    action: text("action"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    claimToken: text("claim_token"),
    claimUntil: timestamp("claim_until", { withTimezone: true }),
    lastError: text("last_error"),
    wakeupPending: boolean("wakeup_pending").notNull().default(false),
  },
  (t) => [
    unique("quality_control_jobs_execution_result_unique").on(t.executionResultId),
    check(
      "quality_control_jobs_execution_attempt_check",
      sql`${t.executionAttempt} >= 1`,
    ),
    check(
      "quality_control_jobs_review_attempt_check",
      sql`${t.reviewAttemptCount} >= 0`,
    ),
    check(
      "quality_control_jobs_state_check",
      sql`${t.state} in ('review_pending','reviewing','decision_ready','review_unavailable','action_applied','escalated')`,
    ),
    check(
      "quality_control_jobs_action_check",
      sql`${t.action} is null or ${t.action} in ('ACCEPT','CORRECT','RETRY','REPLAN','ESCALATE')`,
    ),
    index("quality_control_jobs_pending_idx").on(t.state, t.claimUntil, t.createdAt),
    index("quality_control_jobs_mission_idx").on(t.missionId),
    index("quality_control_jobs_wakeup_idx").on(t.missionId).where(sql`${t.wakeupPending}`),
  ],
);

/**
 * Durable Scheduler (ADR-0025) : file de jobs différés. PostgreSQL est la source
 * de vérité ; `now()` de la base est la seule horloge (next_run_at, lease, backoff).
 */
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    payloadHash: text("payload_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").notNull(),
    priority: integer("priority").notNull().default(0),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    backoffBaseMs: integer("backoff_base_ms").notNull().default(5000),
    leaseOwner: text("lease_owner"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    lastError: text("last_error"),
    missionId: text("mission_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    unique("scheduled_jobs_idempotency_key_unique").on(t.idempotencyKey),
    check(
      "scheduled_jobs_kind_check",
      /* ALLOW-list. `probe_workers` added by migration 0045 (M6, defect 16). */
      sql`${t.kind} in ('start_mission','wake_mission','probe_workers')`,
    ),
    check(
      "scheduled_jobs_state_check",
      sql`${t.state} in ('scheduled','running','succeeded','dead','expired')`,
    ),
    check(
      "scheduled_jobs_attempts_check",
      sql`${t.maxAttempts} >= 1 and ${t.attemptCount} >= 0`,
    ),
    check(
      "scheduled_jobs_backoff_check",
      sql`${t.backoffBaseMs} >= 0`,
    ),
    check(
      "scheduled_jobs_running_lease_check",
      sql`${t.state} <> 'running' or (${t.leaseOwner} is not null and ${t.leaseUntil} is not null)`,
    ),
    index("scheduled_jobs_due_idx").on(t.state, t.nextRunAt),
    index("scheduled_jobs_lease_idx").on(t.state, t.leaseUntil),
  ],
);

/**
 * Phase 7C — coordination des unités de reprise (ADR-0027). Table de coordination reconstructible
 * (les scans recalculent tout depuis l'état métier) ; lignes jamais supprimées : journal des reprises.
 * Horloge unique : `now()` de PostgreSQL.
 */
export const recoveryUnits = pgTable(
  "recovery_units",
  {
    kind: text("kind").notNull(),
    unitKey: text("unit_key").notNull(),
    missionId: text("mission_id").notNull(),
    ownerToken: text("owner_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    attemptCount: integer("attempt_count").notNull().default(0),
    outcome: text("outcome"),
    lastError: text("last_error"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ name: "recovery_units_pk", columns: [t.kind, t.unitKey] }),
    check("recovery_units_attempts_check", sql`${t.attemptCount} >= 0`),
    index("recovery_units_mission_idx").on(t.missionId),
  ],
);

/**
 * Goals and goal previews (Phase 8).
 */
export const goals = pgTable("goals", {
  id: text("id").primaryKey().notNull(),
  goalId: text("goalId").notNull(),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
  rawInput: text("rawInput").notNull(),
  normalizedIntent: text("normalizedIntent").notNull(),
  constraints: text("constraints")
    .array()
    .notNull()
    .default(sql`'{}'`),
  successCriteria: text("successCriteria")
    .array()
    .notNull()
    .default(sql`'{}'`),
  priority: integer("priority").notNull().default(3),
  riskLevel: text("riskLevel").notNull().default('reversible'),
  deadline: timestamp("deadline", { withTimezone: true }),
  budget: doublePrecision("budget"),
  allowedCapabilities: text("allowedCapabilities")
    .array()
    .notNull()
    .default(sql`'{}'`),
  forbiddenCapabilities: text("forbiddenCapabilities")
    .array()
    .notNull()
    .default(sql`'{}'`),
  humanApprovalPolicy: text("humanApprovalPolicy")
    .notNull()
    .default('if_risky'),
  metadata: jsonb("metadata").notNull().default(sql`'{}'`),
  status: text("status").notNull().default('pending'),
  convertedAt: timestamp("convertedAt", { withTimezone: true }),
  resultingMissionId: text("resultingMissionId"),
  idempotencyKey: text("idempotencyKey"),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updatedAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  unique("goals_goalId_unique").on(t.goalId),
]);

export const goalPreviews = pgTable("goal_previews", {
  id: text("id").primaryKey().notNull(),
  goalId: text("goalId")
    .notNull()
    .references(() => goals.goalId, { onDelete: "cascade" }),
  missionTitle: text("missionTitle").notNull(),
  missionObjective: text("missionObjective").notNull(),
  tasks: jsonb("tasks").notNull(),
  createdAt: timestamp("createdAt", { withTimezone: true })
    .notNull()
    .defaultNow(),
}, (t) => [
  unique("goal_previews_goalId_unique").on(t.goalId),
  index("goal_previews_goalId_idx").on(t.goalId),
]);

/**
 * Autonomous plans (Phase 8C).
 */
export const autonomousPlans = pgTable("autonomous_plans", {
  id: text("id").primaryKey(),
  missionId: text("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  goalId: text("goal_id").notNull(),
  /*
   * Identity of ONE persisted plan version. Never equal to planFingerprint.
   */
  planId: text("plan_id").notNull(),
  /*
   * Deterministic hash of the canonical logical plan content.
   * Used only for applyPlan idempotency detection, never as an identity.
   */
  planFingerprint: text("plan_fingerprint").notNull(),
  version: integer("version").notNull(),
  /*
   * References autonomous_plans(plan_id) — the logical plan identity of the
   * superseded version — NOT the internal surrogate id.
   */
  predecessorPlanId: text("predecessor_plan_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (t) => [
  unique("autonomous_plans_mission_id_version_unique").on(t.missionId, t.version),
  unique("autonomous_plans_plan_id_unique").on(t.planId),
  unique("autonomous_plans_mission_id_plan_fingerprint_unique").on(t.missionId, t.planFingerprint),
  index("autonomous_plans_mission_id_idx").on(t.missionId),
  foreignKey({
    columns: [t.predecessorPlanId],
    foreignColumns: [t.planId],
    name: "autonomous_plans_predecessor_plan_id_fkey",
  }),
]);

export type AutonomousPlan = typeof autonomousPlans.$inferSelect;
/*
 * Durable worker registry (migration 0042, decision 0031).
 *
 * A Worker is an EXECUTION UNIT. It is deliberately NOT a Model, NOT a
 * Provider, NOT an Account and NOT a capacity slot — those are separate
 * concerns owned by the AI resource catalog and, later, the Resource Manager.
 * Nothing here names a provider; routing is data, not code.
 *
 * Before 0042 the registry was `new InMemoryWorkerRegistry([])` in
 * container.ts: empty at boot, unqueryable, and gone on restart. Capability
 * routing on top of that could not survive a process restart, so it could not
 * be certified.
 *
 * FAIL CLOSED BY DEFAULT: health, availability and runtime_support all default
 * to their "unknown" value, and the canonical matcher
 * (src/core/workers/worker-eligibility.ts) admits only the one exact value per
 * gate. A row inserted with no probe data routes nothing.
 */
export const workers = pgTable(
  "workers",
  {
    id: text("id").primaryKey(),
    workerKind: text("worker_kind").notNull(),
    displayName: text("display_name").notNull(),
    /** Capability keys this worker can satisfy. Matched exactly, never by prefix. */
    capabilities: jsonb("capabilities").default([]).notNull(),
    features: jsonb("features").default([]).notNull(),
    supportsTools: boolean("supports_tools").default(false).notNull(),
    supportsStructuredOutput: boolean("supports_structured_output").default(false).notNull(),
    status: text("status").default("inactive").notNull(),
    runtime: text("runtime").default("unknown").notNull(),
    runtimeSupport: text("runtime_support").default("UNKNOWN").notNull(),
    health: text("health").default("unknown").notNull(),
    availability: text("availability").default("unknown").notNull(),
    tags: jsonb("tags").default([]).notNull(),
    metadata: jsonb("metadata").default({}).notNull(),
    /*
     * Health-probe EVIDENCE (migration 0043, M5.2). null = never probed.
     * Registration deliberately leaves it null: a worker announcing itself is
     * evidence that it exists, not evidence that it works. Undated evidence
     * cannot be aged, and evidence that cannot be aged does not route work.
     */
    lastProbeAt: timestamp("last_probe_at", { withTimezone: true }),
    lastProbeOutcome: text("last_probe_outcome").default("never").notNull(),
    /*
     * CAPACITY (migration 0044, M5.5). A worker is NOT an unlimited execution
     * slot, hence the default of 1. There is deliberately no `current_load`
     * column: load is DERIVED by counting non-terminal dispatch_attempts, so it
     * cannot drift from the ledger and survives a restart for free.
     *
     * `capacityPool` is how several DISTINCT workers competing for ONE
     * provider/account quota is expressed without conflating Worker with Model,
     * Provider, Account or CapacitySlot. It is opaque: routing counts against it
     * and never interprets it.
     */
    maxConcurrency: integer("max_concurrency").default(1).notNull(),
    capacityPool: text("capacity_pool"),
    capacityPoolLimit: integer("capacity_pool_limit"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    /*
     * Fail closed at the database boundary too: an unknown enum value cannot be
     * stored even by a caller that bypasses the Zod contract.
     */
    check("workers_status_check", sql`${t.status} in ('active','inactive','maintenance')`),
    check("workers_runtime_check", sql`${t.runtime} in ('node','docker','binary','wasm','unknown')`),
    check(
      "workers_runtime_support_check",
      sql`${t.runtimeSupport} in ('SUPPORTED_RUNTIME','DECLARED_ONLY','UNKNOWN')`,
    ),
    check("workers_health_check", sql`${t.health} in ('healthy','degraded','unhealthy','unknown')`),
    check(
      "workers_availability_check",
      sql`${t.availability} in ('available','unavailable','unknown')`,
    ),
    check(
      "workers_last_probe_outcome_check",
      sql`${t.lastProbeOutcome} in ('never','ok','failed','unsupported','stale')`,
    ),
    /* An 'ok'/'failed' probe with no timestamp would be undatable evidence. */
    check(
      "workers_probe_evidence_dated_check",
      sql`${t.lastProbeOutcome} = 'never' or ${t.lastProbeAt} is not null`,
    ),
    check("workers_max_concurrency_check", sql`${t.maxConcurrency} >= 1`),
    check(
      "workers_capacity_pool_limit_check",
      sql`(${t.capacityPoolLimit} is null) or (${t.capacityPool} is not null and ${t.capacityPoolLimit} >= 1)`,
    ),
    index("workers_worker_kind_idx").on(t.workerKind),
    index("workers_status_idx").on(t.status),
    index("workers_last_probe_at_idx").on(t.lastProbeAt),
  ],
);

export type WorkerRow = typeof workers.$inferSelect;
