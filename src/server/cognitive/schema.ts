import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/**
 * Drizzle mirror of drizzle/0050_cognitive_runtime.sql (decision 0056). Constraints,
 * partial unique indexes and guard triggers live in the SQL migration; this file only
 * types the columns for queries (same approach as memory-schema.ts).
 */
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const cognitiveConversations = pgTable("cognitive_conversations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  title: text("title"),
  clientId: text("client_id"),
  projectId: text("project_id"),
  previousClientId: text("previous_client_id"),
  previousProjectId: text("previous_project_id"),
  status: text("status").notNull().default("active"),
  nextTurnSeq: integer("next_turn_seq").notNull().default(1),
  nextEventSeq: integer("next_event_seq").notNull().default(1),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const cognitiveParticipants = pgTable(
  "cognitive_participants",
  {
    conversationId: text("conversation_id").notNull(),
    kind: text("kind").notNull(),
    subjectId: text("subject_id").notNull(),
    role: text("role").notNull(),
    joinedAt: ts("joined_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.kind, t.subjectId] })],
);

export const cognitiveTurns = pgTable("cognitive_turns", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  clientId: text("client_id"),
  projectId: text("project_id"),
  seq: integer("seq").notNull(),
  role: text("role").notNull(),
  authorKind: text("author_kind").notNull(),
  authorId: text("author_id").notNull(),
  content: jsonb("content").notNull(),
  status: text("status").notNull(),
  outcome: text("outcome"),
  intent: text("intent"),
  replyToTurnId: text("reply_to_turn_id"),
  idempotencyKey: text("idempotency_key"),
  contextSnapshotId: text("context_snapshot_id"),
  failureReason: text("failure_reason"),
  processingStartedAt: ts("processing_started_at"),
  createdAt: ts("created_at").notNull(),
  completedAt: ts("completed_at"),
});

export const cognitiveTurnRefs = pgTable("cognitive_turn_refs", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  turnId: text("turn_id").notNull(),
  clientId: text("client_id"),
  projectId: text("project_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  payload: jsonb("payload").notNull(),
  policyReason: text("policy_reason").notNull(),
  decidedBy: text("decided_by"),
  decidedAt: ts("decided_at"),
  goalId: text("goal_id"),
  missionId: text("mission_id"),
  launchJobId: text("launch_job_id"),
  failureReason: text("failure_reason"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const cognitiveContextSnapshots = pgTable("cognitive_context_snapshots", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  turnId: text("turn_id").notNull(),
  policyVersion: text("policy_version").notNull(),
  scope: jsonb("scope").notNull(),
  items: jsonb("items").notNull(),
  excluded: jsonb("excluded").notNull(),
  tokenBudget: integer("token_budget").notNull(),
  tokensUsed: integer("tokens_used").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: ts("created_at").notNull(),
});

export const cognitiveEvents = pgTable(
  "cognitive_events",
  {
    conversationId: text("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    tenantId: text("tenant_id").notNull(),
    type: text("type").notNull(),
    turnId: text("turn_id"),
    payload: jsonb("payload").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.seq] })],
);

export const memoryEntities = pgTable("memory_entities", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  kind: text("kind").notNull(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  clientId: text("client_id"),
  projectId: text("project_id"),
  aliases: text("aliases").array().notNull().default([]),
  sensitivity: text("sensitivity").notNull().default("normal"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});

export const memoryRelations = pgTable("memory_relations", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  fromEntityId: text("from_entity_id").notNull(),
  toEntityId: text("to_entity_id").notNull(),
  type: text("type").notNull(),
  epistemic: text("epistemic").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  sourceId: text("source_id").notNull(),
  validFrom: ts("valid_from").notNull(),
  validUntil: ts("valid_until"),
  createdAt: ts("created_at").notNull(),
});

export const memoryRecords = pgTable("memory_records", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  type: text("type").notNull(),
  subjectKey: text("subject_key").notNull(),
  entityId: text("entity_id"),
  content: text("content").notNull(),
  epistemic: text("epistemic").notNull(),
  statementKind: text("statement_kind").notNull(),
  status: text("status").notNull(),
  confidence: doublePrecision("confidence").notNull(),
  originTrust: text("origin_trust").notNull(),
  provenance: jsonb("provenance").notNull(),
  clientId: text("client_id"),
  projectId: text("project_id"),
  ownerUserId: text("owner_user_id"),
  conversationId: text("conversation_id"),
  missionId: text("mission_id"),
  tags: text("tags").array().notNull().default([]),
  sensitivity: text("sensitivity").notNull(),
  retention: text("retention").notNull(),
  validFrom: ts("valid_from").notNull(),
  validUntil: ts("valid_until"),
  expiresAt: ts("expires_at"),
  supersedesId: text("supersedes_id").references((): AnyPgColumn => memoryRecords.id),
  contradictsId: text("contradicts_id").references((): AnyPgColumn => memoryRecords.id),
  recordedBy: text("recorded_by").notNull(),
  reviewedBy: text("reviewed_by"),
  reviewedAt: ts("reviewed_at"),
  createdAt: ts("created_at").notNull(),
  updatedAt: ts("updated_at").notNull(),
});
