import { sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { missions } from "./schema";

/**
 * Schéma Drizzle de la mémoire opérationnelle (Phase 7B) — fichier séparé de
 * `schema.ts` (comme `auth-schema.ts`) pour éviter tout conflit avec la Phase 7A.
 * Migration : drizzle/0031_operational_memory.sql (écrite à la main : les
 * snapshots drizzle-kit s'arrêtent à 0009, voir docs/icos/database-migrations.md).
 * Parité vérifiée par memory-schema.integration.test.ts.
 *
 * Toutes les FK sont ON DELETE RESTRICT ; `tenant_id` est obligatoire partout.
 */

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Colonnes communes : provenance, fraîcheur, confiance, visibilité. */
const envelope = () => ({
  tenantId: text("tenant_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  recordedByType: text("recorded_by_type").notNull(),
  recordedBy: text("recorded_by").notNull(),
  occurredAt: ts("occurred_at").notNull(),
  recordedAt: ts("recorded_at").notNull(),
  lastVerifiedAt: ts("last_verified_at").notNull(),
  staleAfter: ts("stale_after"),
  expiresAt: ts("expires_at"),
  confidence: doublePrecision("confidence").notNull(),
  confidenceBasis: text("confidence_basis").notNull(),
  visibility: text("visibility").notNull(),
  ownerSubject: text("owner_subject"),
  requiredPermission: text("required_permission"),
});

const SOURCES = sql`'execution_result','review_decision','audit_entry','mission','mission_plan','checkpoint','human_input','agent_report','system'`;

type EnvelopeCols = Record<
  | "tenantId"
  | "sourceType"
  | "recordedByType"
  | "confidence"
  | "confidenceBasis"
  | "visibility"
  | "ownerSubject"
  | "requiredPermission",
  AnyPgColumn
>;

function envelopeChecks(prefix: string, t: EnvelopeCols) {
  return [
    check(`${prefix}_source_type_check`, sql`${t.sourceType} in (${SOURCES})`),
    check(
      `${prefix}_recorded_by_type_check`,
      sql`${t.recordedByType} in ('human','agent','system')`,
    ),
    check(`${prefix}_confidence_check`, sql`${t.confidence} between 0 and 1`),
    check(
      `${prefix}_confidence_basis_check`,
      sql`${t.confidenceBasis} in ('observed','derived','declared','validated')`,
    ),
    check(`${prefix}_visibility_check`, sql`${t.visibility} in ('tenant','restricted','private')`),
    check(
      `${prefix}_visibility_owner_check`,
      sql`${t.visibility} <> 'private' or ${t.ownerSubject} is not null`,
    ),
    check(
      `${prefix}_visibility_permission_check`,
      sql`${t.visibility} <> 'restricted' or ${t.requiredPermission} is not null`,
    ),
    check(`${prefix}_tenant_check`, sql`length(${t.tenantId}) > 0`),
  ];
}

export const missionMemoryEntries = pgTable(
  "mission_memory_entries",
  {
    id: text("id").primaryKey(),
    ...envelope(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "restrict" }),
    /** Référence souple (pas de FK) : un replan peut supprimer des mission_tasks. */
    missionTaskId: text("mission_task_id"),
    scope: text("scope").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull(),
    supersedesId: text("supersedes_id").references((): AnyPgColumn => missionMemoryEntries.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    ...envelopeChecks("mission_memory", t),
    check(
      "mission_memory_kind_check",
      sql`${t.kind} in ('objective','plan','decision','result','error','retry','review','artifact','terminal_state')`,
    ),
    check("mission_memory_scope_check", sql`${t.scope} in ('mission','task')`),
    check(
      "mission_memory_scope_task_check",
      sql`(${t.scope} = 'task') = (${t.missionTaskId} is not null)`,
    ),
    check(
      "mission_memory_text_check",
      sql`length(${t.title}) <= 200 and length(${t.summary}) <= 2000`,
    ),
    check("mission_memory_payload_size_check", sql`octet_length(${t.payload}::text) <= 65536`),
    unique("mission_memory_source_unique").on(t.tenantId, t.kind, t.sourceType, t.sourceId),
    uniqueIndex("mission_memory_terminal_unique")
      .on(t.tenantId, t.missionId)
      .where(sql`${t.kind} = 'terminal_state' and ${t.supersedesId} is null`),
    index("mission_memory_timeline_idx").on(t.tenantId, t.missionId, t.occurredAt),
    index("mission_memory_supersedes_idx").on(t.supersedesId),
  ],
);

export const proceduralMemoryEntries = pgTable(
  "procedural_memory_entries",
  {
    id: text("id").primaryKey(),
    ...envelope(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    signature: text("signature").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull(),
    occurrenceCount: integer("occurrence_count").notNull(),
    successCount: integer("success_count").notNull(),
    failureCount: integer("failure_count").notNull(),
    firstObservedAt: ts("first_observed_at").notNull(),
    lastObservedAt: ts("last_observed_at").notNull(),
    validatedBy: text("validated_by"),
    validatedAt: ts("validated_at"),
    validatedSourceType: text("validated_source_type"),
    validatedSourceId: text("validated_source_id"),
  },
  (t) => [
    ...envelopeChecks("procedural_memory", t),
    check(
      "procedural_memory_kind_check",
      sql`${t.kind} in ('successful_plan','strategy','skill_usage','recovery_pattern','recurring_error','validated_remediation')`,
    ),
    check(
      "procedural_memory_scope_check",
      sql`${t.scope} in ('tenant','capability','worker_kind')`,
    ),
    check(
      "procedural_memory_scope_key_check",
      sql`(${t.scope} = 'tenant') = (${t.scopeKey} = '*')`,
    ),
    check(
      "procedural_memory_status_check",
      sql`${t.status} in ('candidate','validated','deprecated')`,
    ),
    check(
      "procedural_memory_counters_check",
      sql`${t.occurrenceCount} >= 1 and ${t.successCount} >= 0 and ${t.failureCount} >= 0 and ${t.occurrenceCount} = ${t.successCount} + ${t.failureCount}`,
    ),
    check(
      "procedural_memory_validation_check",
      sql`${t.status} <> 'validated' or (${t.validatedBy} is not null and ${t.validatedAt} is not null and ${t.validatedSourceType} is not null and ${t.validatedSourceId} is not null)`,
    ),
    check(
      "procedural_memory_remediation_check",
      sql`${t.kind} <> 'validated_remediation' or ${t.status} in ('validated','deprecated')`,
    ),
    check(
      "procedural_memory_text_check",
      sql`length(${t.title}) <= 200 and length(${t.summary}) <= 2000 and length(${t.signature}) <= 300`,
    ),
    check("procedural_memory_payload_size_check", sql`octet_length(${t.payload}::text) <= 65536`),
    unique("procedural_memory_signature_unique").on(
      t.tenantId,
      t.kind,
      t.scope,
      t.scopeKey,
      t.signature,
    ),
    index("procedural_memory_lookup_idx").on(t.tenantId, t.kind, t.status, t.confidence),
  ],
);

export const proceduralMemoryEvidence = pgTable(
  "procedural_memory_evidence",
  {
    id: text("id").primaryKey(),
    entryId: text("entry_id")
      .notNull()
      .references(() => proceduralMemoryEntries.id, { onDelete: "restrict" }),
    tenantId: text("tenant_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    missionId: text("mission_id"),
    outcome: text("outcome").notNull(),
    observedAt: ts("observed_at").notNull(),
    recordedAt: ts("recorded_at").notNull(),
  },
  (t) => [
    check("procedural_evidence_outcome_check", sql`${t.outcome} in ('success','failure')`),
    check("procedural_evidence_source_type_check", sql`${t.sourceType} in (${SOURCES})`),
    unique("procedural_evidence_source_unique").on(t.entryId, t.sourceType, t.sourceId),
    index("procedural_evidence_entry_idx").on(t.entryId, t.observedAt),
  ],
);

export const businessMemoryEntries = pgTable(
  "business_memory_entries",
  {
    id: text("id").primaryKey(),
    ...envelope(),
    kind: text("kind").notNull(),
    scope: text("scope").notNull(),
    scopeKey: text("scope_key").notNull(),
    subjectKey: text("subject_key").notNull(),
    summary: text("summary").notNull(),
    value: jsonb("value").notNull(),
    /** Attribuée à l'activation (pas à la proposition) : évite les collisions concurrentes. */
    version: integer("version"),
    status: text("status").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    supersedesId: text("supersedes_id").references((): AnyPgColumn => businessMemoryEntries.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    ...envelopeChecks("business_memory", t),
    check(
      "business_memory_kind_check",
      sql`${t.kind} in ('preference','business_fact','constraint','guideline')`,
    ),
    check("business_memory_scope_check", sql`${t.scope} in ('user','tenant')`),
    check("business_memory_scope_key_check", sql`(${t.scope} = 'tenant') = (${t.scopeKey} = '*')`),
    check(
      "business_memory_status_check",
      sql`${t.status} in ('proposed','active','superseded','retracted','rejected')`,
    ),
    check(
      "business_memory_version_check",
      sql`(${t.version} is null or ${t.version} >= 1) and (${t.status} not in ('active','superseded') or ${t.version} is not null)`,
    ),
    // I6 : aucune entrée non proposée sans décision humaine.
    check(
      "business_memory_decision_check",
      sql`${t.status} = 'proposed' or ${t.decidedBy} is not null`,
    ),
    check(
      "business_memory_decision_pair_check",
      sql`(${t.decidedBy} is null) = (${t.decidedAt} is null)`,
    ),
    check(
      "business_memory_text_check",
      sql`length(${t.summary}) <= 2000 and length(${t.subjectKey}) <= 200`,
    ),
    check("business_memory_value_size_check", sql`octet_length(${t.value}::text) <= 65536`),
    unique("business_memory_version_unique").on(
      t.tenantId,
      t.scope,
      t.scopeKey,
      t.subjectKey,
      t.version,
    ),
    uniqueIndex("business_memory_active_unique")
      .on(t.tenantId, t.scope, t.scopeKey, t.subjectKey)
      .where(sql`${t.status} = 'active'`),
    index("business_memory_lookup_idx").on(t.tenantId, t.scope, t.scopeKey, t.status),
  ],
);

export const memoryRetrievalLog = pgTable(
  "memory_retrieval_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    memoryType: text("memory_type").notNull(),
    requesterType: text("requester_type").notNull(),
    requesterId: text("requester_id").notNull(),
    onBehalfOfUserId: text("on_behalf_of_user_id"),
    purpose: text("purpose"),
    missionId: text("mission_id"),
    query: jsonb("query").notNull(),
    result: jsonb("result").notNull(),
    returnedCount: integer("returned_count").notNull(),
    stats: jsonb("stats").notNull(),
    retrievedAt: ts("retrieved_at").notNull(),
  },
  (t) => [
    check(
      "memory_retrieval_type_check",
      sql`${t.memoryType} in ('mission','procedural','business')`,
    ),
    check(
      "memory_retrieval_requester_type_check",
      sql`${t.requesterType} in ('human','agent','system')`,
    ),
    check("memory_retrieval_tenant_check", sql`length(${t.tenantId}) > 0`),
    index("memory_retrieval_requester_idx").on(t.tenantId, t.requesterId, t.retrievedAt),
    index("memory_retrieval_mission_idx").on(t.tenantId, t.missionId, t.retrievedAt),
  ],
);
