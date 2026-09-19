-- Phase 7B — Operational Memory. Migration ADDITIVE (aucune table existante modifiée).
-- Écrite à la main (snapshots drizzle-kit périmés) ; parité vérifiée par
-- src/server/memory/memory-schema.integration.test.ts.
-- ATTENTION INTÉGRATION : la Phase 7A crée `0030_scheduled_jobs` en parallèle. Ce fichier est numéroté
-- 0031 (`when` > celui de 7A). Si 7A change de numéro/horodatage, renuméroter ce fichier ET son entrée
-- de journal en gardant `when` strictement croissant (sinon Drizzle l'ignore silencieusement).
-- Rollback (données de test/dev uniquement) : DROP TABLE memory_retrieval_log, procedural_memory_evidence,
-- procedural_memory_entries, business_memory_entries, mission_memory_entries CASCADE;
-- DROP FUNCTION icos_forbid_memory_mutation(), icos_business_memory_guard(); puis retirer l'entrée du journal.
-- Aucune donnée existante n'est touchée ; en production la mémoire est de la preuve : ne pas rollback sans export.

CREATE TABLE "mission_memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"recorded_by_type" text NOT NULL,
	"recorded_by" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"stale_after" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"confidence" double precision NOT NULL,
	"confidence_basis" text NOT NULL,
	"visibility" text NOT NULL,
	"owner_subject" text,
	"required_permission" text,
	"mission_id" text NOT NULL,
	"mission_task_id" text,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"supersedes_id" text,
	CONSTRAINT "mission_memory_source_unique" UNIQUE("tenant_id","kind","source_type","source_id"),
	CONSTRAINT "mission_memory_source_type_check" CHECK ("source_type" in ('execution_result','review_decision','audit_entry','mission','mission_plan','checkpoint','human_input','agent_report','system')),
	CONSTRAINT "mission_memory_recorded_by_type_check" CHECK ("recorded_by_type" in ('human','agent','system')),
	CONSTRAINT "mission_memory_confidence_check" CHECK ("confidence" between 0 and 1),
	CONSTRAINT "mission_memory_confidence_basis_check" CHECK ("confidence_basis" in ('observed','derived','declared','validated')),
	CONSTRAINT "mission_memory_visibility_check" CHECK ("visibility" in ('tenant','restricted','private')),
	CONSTRAINT "mission_memory_visibility_owner_check" CHECK ("visibility" <> 'private' or "owner_subject" is not null),
	CONSTRAINT "mission_memory_visibility_permission_check" CHECK ("visibility" <> 'restricted' or "required_permission" is not null),
	CONSTRAINT "mission_memory_tenant_check" CHECK (length("tenant_id") > 0),
	CONSTRAINT "mission_memory_kind_check" CHECK ("kind" in ('objective','plan','decision','result','error','retry','review','artifact','terminal_state')),
	CONSTRAINT "mission_memory_scope_check" CHECK ("scope" in ('mission','task')),
	CONSTRAINT "mission_memory_scope_task_check" CHECK (("scope" = 'task') = ("mission_task_id" is not null)),
	CONSTRAINT "mission_memory_text_check" CHECK (length("title") <= 200 and length("summary") <= 2000),
	CONSTRAINT "mission_memory_payload_size_check" CHECK (octet_length("payload"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "procedural_memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"recorded_by_type" text NOT NULL,
	"recorded_by" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"stale_after" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"confidence" double precision NOT NULL,
	"confidence_basis" text NOT NULL,
	"visibility" text NOT NULL,
	"owner_subject" text,
	"required_permission" text,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"signature" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"occurrence_count" integer NOT NULL,
	"success_count" integer NOT NULL,
	"failure_count" integer NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"validated_by" text,
	"validated_at" timestamp with time zone,
	"validated_source_type" text,
	"validated_source_id" text,
	CONSTRAINT "procedural_memory_signature_unique" UNIQUE("tenant_id","kind","scope","scope_key","signature"),
	CONSTRAINT "procedural_memory_source_type_check" CHECK ("source_type" in ('execution_result','review_decision','audit_entry','mission','mission_plan','checkpoint','human_input','agent_report','system')),
	CONSTRAINT "procedural_memory_recorded_by_type_check" CHECK ("recorded_by_type" in ('human','agent','system')),
	CONSTRAINT "procedural_memory_confidence_check" CHECK ("confidence" between 0 and 1),
	CONSTRAINT "procedural_memory_confidence_basis_check" CHECK ("confidence_basis" in ('observed','derived','declared','validated')),
	CONSTRAINT "procedural_memory_visibility_check" CHECK ("visibility" in ('tenant','restricted','private')),
	CONSTRAINT "procedural_memory_visibility_owner_check" CHECK ("visibility" <> 'private' or "owner_subject" is not null),
	CONSTRAINT "procedural_memory_visibility_permission_check" CHECK ("visibility" <> 'restricted' or "required_permission" is not null),
	CONSTRAINT "procedural_memory_tenant_check" CHECK (length("tenant_id") > 0),
	CONSTRAINT "procedural_memory_kind_check" CHECK ("kind" in ('successful_plan','strategy','skill_usage','recovery_pattern','recurring_error','validated_remediation')),
	CONSTRAINT "procedural_memory_scope_check" CHECK ("scope" in ('tenant','capability','worker_kind')),
	CONSTRAINT "procedural_memory_scope_key_check" CHECK (("scope" = 'tenant') = ("scope_key" = '*')),
	CONSTRAINT "procedural_memory_status_check" CHECK ("status" in ('candidate','validated','deprecated')),
	CONSTRAINT "procedural_memory_counters_check" CHECK ("occurrence_count" >= 1 and "success_count" >= 0 and "failure_count" >= 0 and "occurrence_count" = "success_count" + "failure_count"),
	CONSTRAINT "procedural_memory_validation_check" CHECK ("status" <> 'validated' or ("validated_by" is not null and "validated_at" is not null and "validated_source_type" is not null and "validated_source_id" is not null)),
	CONSTRAINT "procedural_memory_remediation_check" CHECK ("kind" <> 'validated_remediation' or "status" in ('validated','deprecated')),
	CONSTRAINT "procedural_memory_text_check" CHECK (length("title") <= 200 and length("summary") <= 2000 and length("signature") <= 300),
	CONSTRAINT "procedural_memory_payload_size_check" CHECK (octet_length("payload"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "procedural_memory_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"mission_id" text,
	"outcome" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "procedural_evidence_source_unique" UNIQUE("entry_id","source_type","source_id"),
	CONSTRAINT "procedural_evidence_outcome_check" CHECK ("outcome" in ('success','failure')),
	CONSTRAINT "procedural_evidence_source_type_check" CHECK ("source_type" in ('execution_result','review_decision','audit_entry','mission','mission_plan','checkpoint','human_input','agent_report','system'))
);
--> statement-breakpoint
CREATE TABLE "business_memory_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"recorded_by_type" text NOT NULL,
	"recorded_by" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone NOT NULL,
	"stale_after" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"confidence" double precision NOT NULL,
	"confidence_basis" text NOT NULL,
	"visibility" text NOT NULL,
	"owner_subject" text,
	"required_permission" text,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"scope_key" text NOT NULL,
	"subject_key" text NOT NULL,
	"summary" text NOT NULL,
	"value" jsonb NOT NULL,
	"version" integer,
	"status" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"supersedes_id" text,
	CONSTRAINT "business_memory_version_unique" UNIQUE("tenant_id","scope","scope_key","subject_key","version"),
	CONSTRAINT "business_memory_source_type_check" CHECK ("source_type" in ('execution_result','review_decision','audit_entry','mission','mission_plan','checkpoint','human_input','agent_report','system')),
	CONSTRAINT "business_memory_recorded_by_type_check" CHECK ("recorded_by_type" in ('human','agent','system')),
	CONSTRAINT "business_memory_confidence_check" CHECK ("confidence" between 0 and 1),
	CONSTRAINT "business_memory_confidence_basis_check" CHECK ("confidence_basis" in ('observed','derived','declared','validated')),
	CONSTRAINT "business_memory_visibility_check" CHECK ("visibility" in ('tenant','restricted','private')),
	CONSTRAINT "business_memory_visibility_owner_check" CHECK ("visibility" <> 'private' or "owner_subject" is not null),
	CONSTRAINT "business_memory_visibility_permission_check" CHECK ("visibility" <> 'restricted' or "required_permission" is not null),
	CONSTRAINT "business_memory_tenant_check" CHECK (length("tenant_id") > 0),
	CONSTRAINT "business_memory_kind_check" CHECK ("kind" in ('preference','business_fact','constraint','guideline')),
	CONSTRAINT "business_memory_scope_check" CHECK ("scope" in ('user','tenant')),
	CONSTRAINT "business_memory_scope_key_check" CHECK (("scope" = 'tenant') = ("scope_key" = '*')),
	CONSTRAINT "business_memory_status_check" CHECK ("status" in ('proposed','active','superseded','retracted','rejected')),
	CONSTRAINT "business_memory_version_check" CHECK (("version" is null or "version" >= 1) and ("status" not in ('active','superseded') or "version" is not null)),
	CONSTRAINT "business_memory_decision_check" CHECK ("status" = 'proposed' or "decided_by" is not null),
	CONSTRAINT "business_memory_decision_pair_check" CHECK (("decided_by" is null) = ("decided_at" is null)),
	CONSTRAINT "business_memory_text_check" CHECK (length("summary") <= 2000 and length("subject_key") <= 200),
	CONSTRAINT "business_memory_value_size_check" CHECK (octet_length("value"::text) <= 65536)
);
--> statement-breakpoint
CREATE TABLE "memory_retrieval_log" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"memory_type" text NOT NULL,
	"requester_type" text NOT NULL,
	"requester_id" text NOT NULL,
	"on_behalf_of_user_id" text,
	"purpose" text,
	"mission_id" text,
	"query" jsonb NOT NULL,
	"result" jsonb NOT NULL,
	"returned_count" integer NOT NULL,
	"stats" jsonb NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "memory_retrieval_type_check" CHECK ("memory_type" in ('mission','procedural','business')),
	CONSTRAINT "memory_retrieval_requester_type_check" CHECK ("requester_type" in ('human','agent','system')),
	CONSTRAINT "memory_retrieval_tenant_check" CHECK (length("tenant_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "mission_memory_entries" ADD CONSTRAINT "mission_memory_entries_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "mission_memory_entries" ADD CONSTRAINT "mission_memory_entries_supersedes_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."mission_memory_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "procedural_memory_evidence" ADD CONSTRAINT "procedural_memory_evidence_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."procedural_memory_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "business_memory_entries" ADD CONSTRAINT "business_memory_entries_supersedes_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."business_memory_entries"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "mission_memory_terminal_unique" ON "mission_memory_entries" USING btree ("tenant_id","mission_id") WHERE "kind" = 'terminal_state' and "supersedes_id" is null;
--> statement-breakpoint
CREATE INDEX "mission_memory_timeline_idx" ON "mission_memory_entries" USING btree ("tenant_id","mission_id","occurred_at");
--> statement-breakpoint
CREATE INDEX "mission_memory_supersedes_idx" ON "mission_memory_entries" USING btree ("supersedes_id");
--> statement-breakpoint
CREATE INDEX "procedural_memory_lookup_idx" ON "procedural_memory_entries" USING btree ("tenant_id","kind","status","confidence");
--> statement-breakpoint
CREATE INDEX "procedural_evidence_entry_idx" ON "procedural_memory_evidence" USING btree ("entry_id","observed_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "business_memory_active_unique" ON "business_memory_entries" USING btree ("tenant_id","scope","scope_key","subject_key") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "business_memory_lookup_idx" ON "business_memory_entries" USING btree ("tenant_id","scope","scope_key","status");
--> statement-breakpoint
CREATE INDEX "memory_retrieval_requester_idx" ON "memory_retrieval_log" USING btree ("tenant_id","requester_id","retrieved_at");
--> statement-breakpoint
CREATE INDEX "memory_retrieval_mission_idx" ON "memory_retrieval_log" USING btree ("tenant_id","mission_id","retrieved_at");
--> statement-breakpoint
-- Durcissement SQL (défense en profondeur, en plus des garanties applicatives).
-- IC002 : append-only ; IC003 : colonnes immuables / transitions interdites de la mémoire business.
-- Les triggers ROW ne se déclenchent pas sur TRUNCATE (nettoyage des tests inchangé).
CREATE FUNCTION icos_forbid_memory_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% est append-only : % interdit', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'IC002';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER mission_memory_append_only BEFORE UPDATE OR DELETE ON mission_memory_entries
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER procedural_evidence_append_only BEFORE UPDATE OR DELETE ON procedural_memory_evidence
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER memory_retrieval_append_only BEFORE UPDATE OR DELETE ON memory_retrieval_log
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER procedural_memory_no_delete BEFORE DELETE ON procedural_memory_entries
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE TRIGGER business_memory_no_delete BEFORE DELETE ON business_memory_entries
	FOR EACH ROW EXECUTE FUNCTION icos_forbid_memory_mutation();
--> statement-breakpoint
CREATE FUNCTION icos_business_memory_guard() RETURNS trigger AS $$
BEGIN
	IF (NEW.id, NEW.tenant_id, NEW.kind, NEW.scope, NEW.scope_key, NEW.subject_key, NEW.summary, NEW.value,
	    NEW.source_type, NEW.source_id, NEW.recorded_by_type, NEW.recorded_by, NEW.occurred_at, NEW.recorded_at,
	    NEW.confidence, NEW.confidence_basis, NEW.visibility, NEW.owner_subject, NEW.required_permission)
	   IS DISTINCT FROM
	   (OLD.id, OLD.tenant_id, OLD.kind, OLD.scope, OLD.scope_key, OLD.subject_key, OLD.summary, OLD.value,
	    OLD.source_type, OLD.source_id, OLD.recorded_by_type, OLD.recorded_by, OLD.occurred_at, OLD.recorded_at,
	    OLD.confidence, OLD.confidence_basis, OLD.visibility, OLD.owner_subject, OLD.required_permission) THEN
		RAISE EXCEPTION 'business_memory_entries : valeur/provenance immuables (créer une nouvelle version)'
			USING ERRCODE = 'IC003';
	END IF;
	IF OLD.status IN ('superseded','retracted','rejected') AND NEW.status <> OLD.status THEN
		RAISE EXCEPTION 'business_memory_entries : statut % terminal', OLD.status
			USING ERRCODE = 'IC003';
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER business_memory_immutable BEFORE UPDATE ON business_memory_entries
	FOR EACH ROW EXECUTE FUNCTION icos_business_memory_guard();
