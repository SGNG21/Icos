-- C2 — Skill Registry & Trust Lifecycle
-- Migration additive : crée les tables skills, skill_security_scans,
-- skill_security_findings, skill_evaluations et étend le check constraint d'audit.

--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"skill_key" text NOT NULL,
	"version" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"capability_keys" jsonb NOT NULL DEFAULT '[]',
	"category" text NOT NULL,
	"trust_state" text NOT NULL,
	"activation_state" text NOT NULL,
	"scripts" jsonb,
	"resources" jsonb,
	"references" jsonb,
	"dependency_declarations" jsonb,
	"network_requirements" jsonb,
	"credential_requirements" jsonb,
	"execution_isolation_requirement" jsonb,
	"tool_requirements" jsonb,
	"input_schema" jsonb,
	"output_schema" jsonb,
	"data_category" text,
	"sensitivity_level" text,
	"content_hash" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skills_tenant_key_version_unique" UNIQUE("tenant_id","skill_key","version"),
	CONSTRAINT "skills_trust_state_check" CHECK ("skills"."trust_state" in ('untrusted','quarantined','reviewed','approved','rejected')),
	CONSTRAINT "skills_activation_state_check" CHECK ("skills"."activation_state" in ('inactive','active','suspended','revoked')),
	CONSTRAINT "skills_data_category_check" CHECK ("skills"."data_category" is null or "skills"."data_category" in ('PUBLIC','INTERNAL','PERSONAL','SENSITIVE_PERSONAL','CONFIDENTIAL_CLIENT','AUTH_SECRET','FINANCIAL','LEGAL','HEALTH','HR','CHILD_DATA','BIOMETRIC','DERIVED_PROFILE')),
	CONSTRAINT "skills_sensitivity_level_check" CHECK ("skills"."sensitivity_level" is null or "skills"."sensitivity_level" in ('C0','C1','C2','C3'))
);
--> statement-breakpoint
CREATE TABLE "skill_security_scans" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"evaluated_content_hash" text NOT NULL,
	"scanner_id" text NOT NULL,
	"scanner_version" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_security_scans_status_check" CHECK ("skill_security_scans"."status" in ('running','passed','failed','error'))
);
--> statement-breakpoint
CREATE TABLE "skill_security_findings" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"severity" text NOT NULL,
	"category" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"location" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_security_findings_severity_check" CHECK ("skill_security_findings"."severity" in ('low','medium','high','critical'))
);
--> statement-breakpoint
CREATE TABLE "skill_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"evaluated_content_hash" text NOT NULL,
	"evaluator_type" text NOT NULL,
	"evaluator_version" text,
	"status" text NOT NULL,
	"score" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "skill_evaluations_status_check" CHECK ("skill_evaluations"."status" in ('running','passed','failed','error'))
);
--> statement-breakpoint
-- Partial unique index : une seule version ACTIVE par (tenant_id, skill_key)
CREATE UNIQUE INDEX IF NOT EXISTS "skills_single_active_per_key" ON "skills" ("tenant_id", "skill_key") WHERE "activation_state" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_trust_state_idx" ON "skills" ("trust_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_activation_state_idx" ON "skills" ("activation_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_skill_key_idx" ON "skills" ("skill_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_content_hash_idx" ON "skills" ("content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_capability_keys_idx" ON "skills" USING gin ("capability_keys");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_security_scans_skill_hash_idx" ON "skill_security_scans" ("skill_id", "evaluated_content_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_security_findings_scan_idx" ON "skill_security_findings" ("scan_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_evaluations_skill_hash_idx" ON "skill_evaluations" ("skill_id", "evaluated_content_hash");
--> statement-breakpoint
-- Foreign keys (après création des index pour respecter l'ordre Drizzle)
ALTER TABLE "skill_security_scans" ADD CONSTRAINT "skill_security_scans_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_security_findings" ADD CONSTRAINT "skill_security_findings_scan_id_skill_security_scans_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."skill_security_scans"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_evaluations" ADD CONSTRAINT "skill_evaluations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
-- Extension du check constraint d'audit (DROP + ADD)
ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_event_type_check";
--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("audit_entries"."event_type" in ('task.created','task.transitioned','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked','skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed','skill.security_scan_recorded','skill.eval_recorded'));
