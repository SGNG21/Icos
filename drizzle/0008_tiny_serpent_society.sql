CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" in ('user','assistant','system'))
);
--> statement-breakpoint
CREATE TABLE "mission_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text NOT NULL,
	"worker_kind" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mission_tasks_status_check" CHECK ("mission_tasks"."status" in ('draft','queued','awaiting_approval','running','succeeded','failed','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "missions_status_check" CHECK ("missions"."status" in ('draft','planning','ready','running','blocked','awaiting_approval','succeeded','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_event_type_check";--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_updated_at_idx" ON "conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "messages_created_at_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "mission_tasks_mission_idx" ON "mission_tasks" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "mission_tasks_status_idx" ON "mission_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "missions_status_idx" ON "missions" USING btree ("status");--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("audit_entries"."event_type" in ('task.created','task.transitioned','task.execution.dispatched','task.execution.started','task.execution.completed','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked','skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed','skill.security_scan_recorded','skill.eval_recorded','mission.created','mission.transitioned','mission.task.dispatched'));