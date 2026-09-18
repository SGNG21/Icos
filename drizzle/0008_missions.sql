-- Migration: add missions and mission_tasks tables

CREATE TABLE IF NOT EXISTS "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "mission_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"worker_kind" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);

DO $$ BEGIN
 ALTER TABLE "missions" ADD CONSTRAINT "missions_status_check" CHECK ("status" IN ('draft','planning','ready','running','blocked','awaiting_approval','succeeded','failed','cancelled'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
 ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_status_check" CHECK ("status" IN ('draft','queued','awaiting_approval','running','succeeded','failed','cancelled'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "missions_status_idx" ON "missions" ("status");
CREATE INDEX IF NOT EXISTS "mission_tasks_mission_idx" ON "mission_tasks" ("mission_id");
CREATE INDEX IF NOT EXISTS "mission_tasks_status_idx" ON "mission_tasks" ("status");

-- Update audit_entries check constraint
ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_event_type_check";
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("event_type" IN ('task.created','task.transitioned','task.execution.dispatched','task.execution.started','task.execution.completed','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked','skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed','skill.security_scan_recorded','skill.eval_recorded','mission.created','mission.transitioned','mission.task.dispatched'));
