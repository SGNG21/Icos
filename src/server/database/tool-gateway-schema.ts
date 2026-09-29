import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * Tool Gateway persistence (decision 0055). Separate file, like
 * `memory-schema.ts`, to avoid churn in `schema.ts`.
 * Migration: drizzle/0049_tool_gateway.sql (hand-written, see
 * docs/icos/database-migrations.md). Parity: postgres-stores.integration.test.ts.
 *
 * Tenant strategy: `tenant_id` NOT NULL on every table, part of every unique
 * key, and a mandatory predicate of every store query. No secret column exists.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

const ACTIONS = sql`'READ','SEARCH','CREATE','WRITE','UPDATE','SEND','PUBLISH','DEPLOY','DELETE','EXECUTE','PURCHASE','PAY','GRANT_ACCESS','REVOKE_ACCESS','CONFIGURE','MERGE'`;
const RISKS = sql`'LOW','MEDIUM','HIGH','CRITICAL'`;

export const toolExecutions = pgTable(
  "tool_executions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    toolId: text("tool_id").notNull(),
    toolVersion: text("tool_version").notNull(),
    action: text("action").notNull(),
    connectorInstanceId: text("connector_instance_id").notNull(),
    requesterAgentId: text("requester_agent_id").notNull(),
    missionId: text("mission_id"),
    taskId: text("task_id"),
    riskClass: text("risk_class").notNull(),
    sideEffects: text("side_effects").notNull(),
    status: text("status").notNull(),
    settlementState: text("settlement_state").notNull(),
    approvalRequestId: text("approval_request_id"),
    attemptCount: integer("attempt_count").notNull(),
    providerOperationId: text("provider_operation_id"),
    failureClass: text("failure_class"),
    failureMessage: text("failure_message"),
    resultSummary: jsonb("result_summary"),
    resultReference: text("result_reference"),
    auditReferences: jsonb("audit_references").notNull(),
    version: integer("version").notNull(),
    createdAt: ts("created_at").notNull(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    unique("tool_executions_tenant_key_unique").on(t.tenantId, t.idempotencyKey),
    check("tool_executions_tenant_check", sql`length(${t.tenantId}) > 0`),
    check("tool_executions_action_check", sql`${t.action} in (${ACTIONS})`),
    check("tool_executions_risk_check", sql`${t.riskClass} in (${RISKS})`),
    check(
      "tool_executions_side_effects_check",
      sql`${t.sideEffects} in ('none','internal','external')`,
    ),
    check(
      "tool_executions_status_check",
      sql`${t.status} in ('REQUESTED','AWAITING_APPROVAL','DENIED','REJECTED','EXECUTING','SUCCEEDED','FAILED')`,
    ),
    check(
      "tool_executions_settlement_check",
      sql`${t.settlementState} in ('NOT_STARTED','DISPATCHED','APPLIED','NOT_APPLIED','UNKNOWN')`,
    ),
    check(
      "tool_executions_failure_class_check",
      sql`${t.failureClass} is null or ${t.failureClass} in ('AUTH_FAILURE','PERMISSION_DENIED','RATE_LIMIT','PROVIDER_UNAVAILABLE','NETWORK_ERROR','TIMEOUT','INVALID_INPUT','CONFLICT','NOT_FOUND','IDEMPOTENCY_CONFLICT','POLICY_DENIED','APPROVAL_REQUIRED','APPROVAL_REJECTED','APPROVAL_EXPIRED','SETTLEMENT_UNKNOWN','NOT_CONNECTED','UNKNOWN')`,
    ),
    check("tool_executions_fingerprint_check", sql`${t.requestFingerprint} ~ '^[a-f0-9]{64}$'`),
    // A side effect is only ever APPLIED on a SUCCEEDED row, and vice versa.
    check(
      "tool_executions_success_settlement_check",
      sql`(${t.status} = 'SUCCEEDED') = (${t.settlementState} = 'APPLIED')`,
    ),
    check("tool_executions_counters_check", sql`${t.attemptCount} >= 0 and ${t.version} >= 0`),
    check(
      "tool_executions_summary_size_check",
      sql`${t.resultSummary} is null or octet_length(${t.resultSummary}::text) <= 8192`,
    ),
    index("tool_executions_tenant_status_idx").on(t.tenantId, t.status, t.updatedAt),
    index("tool_executions_tenant_settlement_idx").on(t.tenantId, t.settlementState),
  ],
);

export const toolApprovalRequests = pgTable(
  "tool_approval_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    toolExecutionId: text("tool_execution_id")
      .notNull()
      .references(() => toolExecutions.id, { onDelete: "restrict" }),
    requestFingerprint: text("request_fingerprint").notNull(),
    requesterAgentId: text("requester_agent_id").notNull(),
    toolId: text("tool_id").notNull(),
    action: text("action").notNull(),
    riskClass: text("risk_class").notNull(),
    status: text("status").notNull(),
    decidedByKind: text("decided_by_kind"),
    decidedById: text("decided_by_id"),
    reason: text("reason"),
    requestedAt: ts("requested_at").notNull(),
    decidedAt: ts("decided_at"),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    check("tool_approval_tenant_check", sql`length(${t.tenantId}) > 0`),
    check("tool_approval_status_check", sql`${t.status} in ('PENDING','APPROVED','REJECTED')`),
    check("tool_approval_action_check", sql`${t.action} in (${ACTIONS})`),
    check("tool_approval_risk_check", sql`${t.riskClass} in (${RISKS})`),
    check(
      "tool_approval_decided_check",
      sql`(${t.status} = 'PENDING') = (${t.decidedAt} is null and ${t.decidedById} is null)`,
    ),
    check(
      "tool_approval_decider_kind_check",
      sql`${t.decidedByKind} is null or ${t.decidedByKind} in ('human','agent')`,
    ),
    // HIGH and CRITICAL can only ever carry a human decision.
    check(
      "tool_approval_human_for_high_check",
      sql`${t.riskClass} not in ('HIGH','CRITICAL') or ${t.decidedByKind} is null or ${t.decidedByKind} = 'human'`,
    ),
    check(
      "tool_approval_reject_reason_check",
      sql`${t.status} <> 'REJECTED' or length(coalesce(${t.reason}, '')) > 0`,
    ),
    index("tool_approval_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const toolGrants = pgTable(
  "tool_grants",
  {
    tenantId: text("tenant_id").notNull(),
    agentId: text("agent_id").notNull(),
    toolId: text("tool_id").notNull(),
    action: text("action").notNull(),
    grantedBy: text("granted_by").notNull(),
    grantedAt: ts("granted_at").notNull(),
    expiresAt: ts("expires_at"),
  },
  (t) => [
    primaryKey({ name: "tool_grants_pk", columns: [t.tenantId, t.agentId, t.toolId, t.action] }),
    check("tool_grants_tenant_check", sql`length(${t.tenantId}) > 0`),
    check("tool_grants_action_check", sql`${t.action} in (${ACTIONS})`),
  ],
);
