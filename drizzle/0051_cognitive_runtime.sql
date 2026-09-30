-- Cognitive Runtime + Memory V1 (decision 0057). ADDITIVE: no existing table is modified.
-- Hand-written (drizzle-kit snapshots are stale, see docs/icos/database-migrations.md);
-- Drizzle mirror: src/server/cognitive/schema.ts; checked by cognitive-schema.integration.test.ts.
--
-- Tenant key: tenant_id NOT NULL on every table. RLS strategy: application-enforced scope
-- predicates in the single repository layer (same as 0031); Postgres RLS waits for the
-- canonical TenantContext (COMPLIANCE-1).
--
-- Rollback (dev/test data only — in production conversations and memory are evidence,
-- export before any rollback):
--   DROP TABLE cognitive_events, cognitive_context_snapshots, cognitive_turn_refs,
--     cognitive_turns, cognitive_participants, cognitive_conversations,
--     memory_relations, memory_records, memory_entities CASCADE;
--   DROP FUNCTION icos_cognitive_turn_guard(), icos_memory_record_guard();
--   then remove the 0051 entry from drizzle/meta/_journal.json.
-- Numbering (checked 2026-09-30 across all local branches): 0049 is taken by
-- feat/tool-gateway-connectors and feat/proactive-supervisor, 0050 by feat/digital-workforce.
-- This file's journal `when` (0048 + 3 days) sorts after all of them; the integrator only has
-- to re-sequence `idx` (see decision 0057, "Integration / migration reconciliation").
-- Reuses icos_forbid_memory_mutation() from 0031 for append-only tables.

CREATE TABLE "cognitive_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text,
	"client_id" text,
	"project_id" text,
	"status" text NOT NULL DEFAULT 'active',
	"next_turn_seq" integer NOT NULL DEFAULT 1,
	"next_event_seq" integer NOT NULL DEFAULT 1,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cognitive_conversations_tenant_check" CHECK (length("tenant_id") > 0),
	CONSTRAINT "cognitive_conversations_status_check" CHECK ("status" in ('active','archived')),
	CONSTRAINT "cognitive_conversations_project_client_check" CHECK ("project_id" is null or "client_id" is not null)
);
--> statement-breakpoint
CREATE INDEX "cognitive_conversations_owner_idx" ON "cognitive_conversations" ("tenant_id","owner_user_id","updated_at");
--> statement-breakpoint
CREATE TABLE "cognitive_participants" (
	"conversation_id" text NOT NULL REFERENCES "cognitive_conversations"("id") ON DELETE RESTRICT,
	"kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cognitive_participants_pk" PRIMARY KEY ("conversation_id","kind","subject_id"),
	CONSTRAINT "cognitive_participants_kind_check" CHECK ("kind" in ('human','icos','agent')),
	CONSTRAINT "cognitive_participants_role_check" CHECK ("role" in ('owner','assistant','observer'))
);
--> statement-breakpoint
CREATE TABLE "cognitive_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL REFERENCES "cognitive_conversations"("id") ON DELETE RESTRICT,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"content" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" text,
	"intent" text,
	"reply_to_turn_id" text REFERENCES "cognitive_turns"("id") ON DELETE RESTRICT,
	"idempotency_key" text,
	"context_snapshot_id" text,
	"failure_reason" text,
	"processing_started_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "cognitive_turns_seq_unique" UNIQUE("conversation_id","seq"),
	CONSTRAINT "cognitive_turns_idempotency_unique" UNIQUE("conversation_id","idempotency_key"),
	CONSTRAINT "cognitive_turns_role_check" CHECK ("role" in ('user','assistant')),
	CONSTRAINT "cognitive_turns_author_kind_check" CHECK ("author_kind" in ('human','icos','agent')),
	CONSTRAINT "cognitive_turns_status_check" CHECK ("status" in ('received','processing','completed','failed','cancelled')),
	CONSTRAINT "cognitive_turns_outcome_check" CHECK ("outcome" is null or "outcome" in ('ANSWER_ONLY','ACTION_REQUEST','MISSION_REQUEST','APPROVAL_REQUEST','CLARIFICATION','NO_ACTION')),
	CONSTRAINT "cognitive_turns_content_size_check" CHECK (octet_length("content"::text) <= 131072),
	CONSTRAINT "cognitive_turns_user_key_check" CHECK ("role" <> 'user' or "idempotency_key" is not null)
);
--> statement-breakpoint
-- One in-flight user turn per conversation: concurrent submissions are serialized by the database.
CREATE UNIQUE INDEX "cognitive_turns_one_inflight" ON "cognitive_turns" ("conversation_id") WHERE "role" = 'user' AND "status" in ('received','processing');
--> statement-breakpoint
CREATE TABLE "cognitive_turn_refs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL REFERENCES "cognitive_conversations"("id") ON DELETE RESTRICT,
	"turn_id" text NOT NULL REFERENCES "cognitive_turns"("id") ON DELETE RESTRICT,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"payload" jsonb NOT NULL,
	"policy_reason" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	-- Canonical launch identity (goal intake + scheduler start_mission), set once LAUNCHED.
	"goal_id" text,
	"mission_id" text,
	"launch_job_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cognitive_turn_refs_turn_kind_unique" UNIQUE("turn_id","kind"),
	CONSTRAINT "cognitive_turn_refs_kind_check" CHECK ("kind" in ('goal_proposal','action_request')),
	-- PROPOSED → APPROVAL_REQUIRED → APPROVED → LAUNCHING → LAUNCHED | FAILED ; or REJECTED.
	-- LAUNCHED means the mission is durably accepted by CORE3 (fixed missionId), not that it succeeded.
	CONSTRAINT "cognitive_turn_refs_status_check" CHECK ("status" in ('proposed','approval_required','approved','launching','launched','rejected','failed','not_connected')),
	CONSTRAINT "cognitive_turn_refs_decision_check" CHECK ("status" in ('proposed','approval_required') or "decided_by" is not null),
	CONSTRAINT "cognitive_turn_refs_launched_check" CHECK ("status" <> 'launched' or ("goal_id" is not null and "mission_id" is not null and "launch_job_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cognitive_turn_refs_mission_unique" ON "cognitive_turn_refs" ("mission_id") WHERE "mission_id" is not null;
--> statement-breakpoint
CREATE INDEX "cognitive_turn_refs_pending_launch_idx" ON "cognitive_turn_refs" ("tenant_id","status") WHERE "status" in ('approved','launching');
--> statement-breakpoint
CREATE TABLE "cognitive_context_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL REFERENCES "cognitive_conversations"("id") ON DELETE RESTRICT,
	"turn_id" text NOT NULL REFERENCES "cognitive_turns"("id") ON DELETE RESTRICT,
	"policy_version" text NOT NULL,
	"scope" jsonb NOT NULL,
	"items" jsonb NOT NULL,
	"excluded" jsonb NOT NULL,
	"token_budget" integer NOT NULL,
	"tokens_used" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cognitive_context_snapshots_turn_unique" UNIQUE("turn_id")
);
--> statement-breakpoint
CREATE TABLE "cognitive_events" (
	"conversation_id" text NOT NULL REFERENCES "cognitive_conversations"("id") ON DELETE RESTRICT,
	"seq" integer NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"turn_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "cognitive_events_pk" PRIMARY KEY ("conversation_id","seq")
);
--> statement-breakpoint
CREATE TABLE "memory_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text,
	"project_id" text,
	"aliases" text[] NOT NULL DEFAULT '{}',
	"sensitivity" text NOT NULL DEFAULT 'normal',
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_entities_key_unique" UNIQUE("tenant_id","kind","key"),
	CONSTRAINT "memory_entities_kind_check" CHECK ("kind" in ('person','company','client','project','asset','service','objective','mission','decision')),
	CONSTRAINT "memory_entities_sensitivity_check" CHECK ("sensitivity" in ('normal','sensitive','restricted')),
	CONSTRAINT "memory_entities_tenant_check" CHECK (length("tenant_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "memory_relations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"from_entity_id" text NOT NULL REFERENCES "memory_entities"("id") ON DELETE RESTRICT,
	"to_entity_id" text NOT NULL REFERENCES "memory_entities"("id") ON DELETE RESTRICT,
	"type" text NOT NULL,
	"epistemic" text NOT NULL,
	"confidence" double precision NOT NULL,
	"source_id" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_relations_type_check" CHECK ("type" in ('OWNS','WORKS_ON','CLIENT_OF','DEPENDS_ON','HAS_GOAL','HAS_BLOCKER','RELATED_TO','SUPERSEDES')),
	CONSTRAINT "memory_relations_epistemic_check" CHECK ("epistemic" in ('USER_ASSERTED','SYSTEM_OBSERVED','TOOL_CONFIRMED','MODEL_INFERRED','DERIVED')),
	CONSTRAINT "memory_relations_confidence_check" CHECK ("confidence" between 0 and 1),
	CONSTRAINT "memory_relations_no_self_check" CHECK ("from_entity_id" <> "to_entity_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_relations_current_unique" ON "memory_relations" ("tenant_id","from_entity_id","to_entity_id","type") WHERE "valid_until" is null;
--> statement-breakpoint
CREATE INDEX "memory_relations_to_idx" ON "memory_relations" ("tenant_id","to_entity_id");
--> statement-breakpoint
CREATE TABLE "memory_records" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"type" text NOT NULL,
	"subject_key" text NOT NULL,
	"entity_id" text REFERENCES "memory_entities"("id") ON DELETE RESTRICT,
	"content" text NOT NULL,
	"epistemic" text NOT NULL,
	"statement_kind" text NOT NULL,
	"status" text NOT NULL,
	"confidence" double precision NOT NULL,
	"origin_trust" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"client_id" text,
	"project_id" text,
	"owner_user_id" text,
	"conversation_id" text,
	"mission_id" text,
	"tags" text[] NOT NULL DEFAULT '{}',
	"sensitivity" text NOT NULL,
	"retention" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_until" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"supersedes_id" text REFERENCES "memory_records"("id") ON DELETE RESTRICT,
	"contradicts_id" text REFERENCES "memory_records"("id") ON DELETE RESTRICT,
	"recorded_by" text NOT NULL,
	-- Human review of a candidate (MODEL_INFERRED or untrusted origin) before it may be used.
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_records_tenant_check" CHECK (length("tenant_id") > 0),
	CONSTRAINT "memory_records_type_check" CHECK ("type" in ('working','episodic','semantic','entity','decision','procedural','project','self')),
	CONSTRAINT "memory_records_epistemic_check" CHECK ("epistemic" in ('USER_ASSERTED','SYSTEM_OBSERVED','TOOL_CONFIRMED','MODEL_INFERRED','DERIVED')),
	CONSTRAINT "memory_records_statement_check" CHECK ("statement_kind" in ('fact','inference','instruction','suggestion','observation')),
	CONSTRAINT "memory_records_status_check" CHECK ("status" in ('active','candidate','superseded','rejected','retracted','deleted')),
	CONSTRAINT "memory_records_confidence_check" CHECK ("confidence" between 0 and 1),
	CONSTRAINT "memory_records_trust_check" CHECK ("origin_trust" in ('trusted','untrusted')),
	CONSTRAINT "memory_records_sensitivity_check" CHECK ("sensitivity" in ('normal','sensitive','restricted')),
	CONSTRAINT "memory_records_retention_check" CHECK ("retention" in ('session','standard','long_term')),
	CONSTRAINT "memory_records_content_check" CHECK (length("content") <= 2000),
	-- A model's inference is never an active fact on its own authority.
	CONSTRAINT "memory_records_model_not_fact_check" CHECK ("epistemic" <> 'MODEL_INFERRED' or "statement_kind" in ('inference','suggestion')),
	-- Untrusted (retrieved/tool) text is never stored as an instruction.
	CONSTRAINT "memory_records_untrusted_instruction_check" CHECK ("origin_trust" <> 'untrusted' or "statement_kind" <> 'instruction'),
	-- A model inference or untrusted text is never active without a recorded human review.
	CONSTRAINT "memory_records_reviewed_promotion_check" CHECK ("status" <> 'active' or ("epistemic" <> 'MODEL_INFERRED' and "origin_trust" <> 'untrusted') or ("reviewed_by" is not null and "reviewed_at" is not null)),
	CONSTRAINT "memory_records_project_client_check" CHECK ("project_id" is null or "client_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_records_one_active" ON "memory_records" ("tenant_id","type","subject_key",coalesce("client_id",''),coalesce("project_id",''),coalesce("owner_user_id",'')) WHERE "status" = 'active' AND "type" not in ('episodic','working');
--> statement-breakpoint
CREATE INDEX "memory_records_scope_idx" ON "memory_records" ("tenant_id","client_id","status");
--> statement-breakpoint
CREATE INDEX "memory_records_subject_idx" ON "memory_records" ("tenant_id","subject_key");
--> statement-breakpoint
CREATE INDEX "memory_records_entity_idx" ON "memory_records" ("entity_id");
--> statement-breakpoint
CREATE INDEX "memory_records_contradicts_idx" ON "memory_records" ("contradicts_id") WHERE "contradicts_id" is not null;
--> statement-breakpoint
CREATE TRIGGER cognitive_events_append_only BEFORE UPDATE OR DELETE ON cognitive_events
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER cognitive_snapshots_append_only BEFORE UPDATE OR DELETE ON cognitive_context_snapshots
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER cognitive_turns_no_delete BEFORE DELETE ON cognitive_turns
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER memory_records_no_delete BEFORE DELETE ON memory_records
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER memory_relations_no_delete BEFORE DELETE ON memory_relations
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
-- Historical turns are immutable: only the lifecycle columns move, and a terminal status is final.
CREATE FUNCTION icos_cognitive_turn_guard() RETURNS trigger AS $$
BEGIN
	IF NEW.content IS DISTINCT FROM OLD.content OR NEW.seq <> OLD.seq OR NEW.role <> OLD.role
		OR NEW.author_id <> OLD.author_id OR NEW.conversation_id <> OLD.conversation_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'cognitive_turns: historical turn content is immutable';
	END IF;
	IF OLD.status in ('completed','failed','cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
		RAISE EXCEPTION 'cognitive_turns: status % is terminal', OLD.status;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER cognitive_turns_immutable BEFORE UPDATE ON cognitive_turns
	FOR EACH ROW EXECUTE FUNCTION icos_cognitive_turn_guard();
--> statement-breakpoint
-- A memory's claim and provenance never change in place: a new value is a new record that
-- supersedes the old one. Deletion is a tombstone that erases content but keeps provenance.
CREATE FUNCTION icos_memory_record_guard() RETURNS trigger AS $$
BEGIN
	IF NEW.type <> OLD.type OR NEW.subject_key <> OLD.subject_key OR NEW.epistemic <> OLD.epistemic
		OR NEW.provenance IS DISTINCT FROM OLD.provenance OR NEW.tenant_id <> OLD.tenant_id
		OR NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.project_id IS DISTINCT FROM OLD.project_id
		OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'memory_records: claim/provenance/scope are immutable (write a superseding record)';
	END IF;
	IF NEW.content IS DISTINCT FROM OLD.content AND NOT (NEW.status = 'deleted' AND NEW.content = '[deleted]') THEN
		RAISE EXCEPTION 'memory_records: content is immutable except for deletion tombstones';
	END IF;
	IF OLD.reviewed_by IS NOT NULL AND (NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN
		RAISE EXCEPTION 'memory_records: a recorded review is immutable';
	END IF;
	IF OLD.status = 'deleted' AND NEW IS DISTINCT FROM OLD THEN
		RAISE EXCEPTION 'memory_records: deleted is terminal';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER memory_records_immutable BEFORE UPDATE ON memory_records
	FOR EACH ROW EXECUTE FUNCTION icos_memory_record_guard();
