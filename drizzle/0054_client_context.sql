-- 0054_client_context.sql — client/project context resolution (decision 0062).
--
-- ADDITIVE ONLY. No table is created, no column is dropped, no existing row is rewritten.
-- Every added column is nullable with no default, so applying this migration cannot fail on
-- existing data and cannot change the meaning of any existing row.
--
-- Rollback (safe, data loss limited to the added columns). ORDER MATTERS: the guard function
-- below references NEW.client_id, so it must be restored to its 0050 body FIRST — otherwise any
-- UPDATE of a terminal turn between the DROP COLUMN and the restore raises
-- `record "new" has no field "client_id"`.
--   1. restore icos_cognitive_turn_guard() from 0050_cognitive_runtime.sql (CREATE OR REPLACE);
--   2. drop index if exists "cognitive_turn_refs_client_idx";
--      drop index if exists "cognitive_turns_client_idx";
--   3. alter table "cognitive_turn_refs" drop column "project_id", drop column "client_id";
--      alter table "cognitive_turns" drop column "project_id", drop column "client_id";
--      alter table "cognitive_conversations" drop column "previous_project_id", drop column "previous_client_id";
--
-- Data safety: a pre-0054 conversation keeps `previous_client_id` NULL, so « reviens à … »
-- answers « aucun périmètre précédent » instead of guessing. Pre-0054 turns and proposals
-- keep a NULL scope, which the scope predicate reads as "unscoped": they are visible only in
-- an unscoped context and can never leak into a client's context.
--
-- Numbering: 0054 is the first free prefix on this branch (0053_proactive_supervisor is the
-- journal tail). Decision 0062 is the first free decision number.

ALTER TABLE "cognitive_conversations" ADD COLUMN "previous_client_id" text;--> statement-breakpoint
ALTER TABLE "cognitive_conversations" ADD COLUMN "previous_project_id" text;--> statement-breakpoint
ALTER TABLE "cognitive_conversations" ADD CONSTRAINT "cognitive_conversations_previous_project_client_check" CHECK ("previous_project_id" is null or "previous_client_id" is not null);--> statement-breakpoint

-- A turn records the scope it was spoken under. Without it, the last turns of a conversation
-- would re-enter a DIFFERENT client's context after a switch (cross-client leakage).
ALTER TABLE "cognitive_turns" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "cognitive_turns" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "cognitive_turns" ADD CONSTRAINT "cognitive_turns_project_client_check" CHECK ("project_id" is null or "client_id" is not null);--> statement-breakpoint
CREATE INDEX "cognitive_turns_client_idx" ON "cognitive_turns" ("conversation_id","client_id","status");--> statement-breakpoint

-- A proposal records the scope it was PROPOSED under. The launch uses this, never the
-- conversation's current pointer: approving an LDS mission after switching to another client
-- must still launch under LDS.
ALTER TABLE "cognitive_turn_refs" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "cognitive_turn_refs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "cognitive_turn_refs" ADD CONSTRAINT "cognitive_turn_refs_project_client_check" CHECK ("project_id" is null or "client_id" is not null);--> statement-breakpoint
CREATE INDEX "cognitive_turn_refs_client_idx" ON "cognitive_turn_refs" ("tenant_id","client_id","status");--> statement-breakpoint

-- The turn guard of 0050 gains the scope columns: an in-flight turn may still be stamped with
-- the scope resolution assigns it, but once the turn is terminal its scope is immutable — a
-- historical turn can never be moved into another client's context after the fact.
CREATE OR REPLACE FUNCTION icos_cognitive_turn_guard() RETURNS trigger AS $$
BEGIN
	IF NEW.content IS DISTINCT FROM OLD.content OR NEW.seq <> OLD.seq OR NEW.role <> OLD.role
		OR NEW.author_id <> OLD.author_id OR NEW.conversation_id <> OLD.conversation_id
		OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at <> OLD.created_at THEN
		RAISE EXCEPTION 'cognitive_turns: historical turn content is immutable';
	END IF;
	IF OLD.status in ('completed','failed','cancelled') THEN
		IF NEW.status IS DISTINCT FROM OLD.status THEN
			RAISE EXCEPTION 'cognitive_turns: status % is terminal', OLD.status;
		END IF;
		IF NEW.client_id IS DISTINCT FROM OLD.client_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
			RAISE EXCEPTION 'cognitive_turns: the scope of a terminal turn is immutable';
		END IF;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
