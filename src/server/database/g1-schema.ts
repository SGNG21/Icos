import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * G1.0 — Tool Gateway Foundation.
 *
 * Tables pour ExecutionGrant, IdempotencyState, et ExecutionRecord.
 * Migrations additives uniquement (0008_g1_foundation).
 */

// ─────────────────────────────────────
// Execution Grants
// ─────────────────────────────────────

export const executionGrants = pgTable(
  "execution_grants",
  {
    id: text("id").primaryKey(),
    tenant: text("tenant").notNull(),
    principal: text("principal").notNull(),
    mission: text("mission").notNull(),
    run: text("run").notNull(),
    toolId: text("tool_id").notNull(),
    toolDefinitionHash: text("tool_definition_hash").notNull(),
    toolVersion: text("tool_version"),
    capability: text("capability").notNull(),
    operation: text("operation").notNull(),
    resource: text("resource").notNull(),
    requestHash: text("request_hash").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    policyProvenance: jsonb("policy_provenance").notNull(),
    credentialRequirements: jsonb("credential_requirements"),
    networkRequirements: jsonb("network_requirements"),
    isolationRequirements: jsonb("isolation_requirements"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumed: boolean("consumed").notNull().default(false),
  },
  (t) => [
    index("execution_grants_tenant_idx").on(t.tenant),
    index("execution_grants_principal_idx").on(t.principal),
    index("execution_grants_idempotency_key_idx").on(t.idempotencyKey),
    index("execution_grants_expires_at_idx").on(t.expiresAt),
    check(
      "execution_grants_ttl_check",
      sql`${t.expiresAt} > ${t.issuedAt}`,
    ),
  ],
);

// ─────────────────────────────────────
// Idempotency States (mutable)
// ─────────────────────────────────────

export const idempotencyStates = pgTable(
  "idempotency_states",
  {
    idempotencyKey: text("idempotency_key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    tenant: text("tenant").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
  },
  (t) => [
    check(
      "idempotency_states_state_check",
      sql`${t.state} in ('RESERVED','EXECUTING','COMPLETED','FAILED_SAFE','UNKNOWN')`,
    ),
    check(
      "idempotency_states_attempt_check",
      sql`${t.attemptNumber} > 0`,
    ),
    check(
      "idempotency_states_timestamps_check",
      sql`${t.updatedAt} >= ${t.createdAt}`,
    ),
    index("idempotency_states_tenant_idx").on(t.tenant),
    index("idempotency_states_state_idx").on(t.state),
    index("idempotency_states_request_hash_idx").on(t.requestHash),
  ],
);

// ─────────────────────────────────────
// Execution Records (append-only audit)
// ─────────────────────────────────────

export const executionRecords = pgTable(
  "execution_records",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    grantId: text("grant_id").notNull(),
    tenant: text("tenant").notNull(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(),
    classification: text("classification").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome"),
    errorCode: text("error_code"),
    durationMs: integer("duration_ms"),
    artifactRefs: jsonb("artifact_refs"),
    outputHash: text("output_hash"),
    policyRefs: jsonb("policy_refs"),
    metadata: jsonb("metadata"),
  },
  (t) => [
    check(
      "execution_records_event_type_check",
      sql`${t.eventType} in ('tool.invocation_reserved','tool.invocation_started','tool.invocation_completed','tool.invocation_failed','tool.invocation_unknown')`,
    ),
    check(
      "execution_records_classification_check",
      sql`${t.classification} in ('C0','C1','C2','C3')`,
    ),
    index("execution_records_tenant_idx").on(t.tenant),
    index("execution_records_idempotency_key_idx").on(t.idempotencyKey),
    index("execution_records_event_type_idx").on(t.eventType),
    index("execution_records_occurred_at_idx").on(t.occurredAt),
  ],
);
