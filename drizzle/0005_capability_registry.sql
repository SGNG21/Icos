CREATE TABLE "capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"provenance" jsonb,
	"risk_hint" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "capabilities_key_unique" UNIQUE("key"),
	CONSTRAINT "capabilities_status_check" CHECK ("capabilities"."status" in ('proposed','active','deprecated','retired'))
);
--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"capability_id" text NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"assigned_by_user_id" text NOT NULL,
	CONSTRAINT "agent_capabilities_agent_capability_unique" UNIQUE("agent_id","capability_id")
);
--> statement-breakpoint
ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_event_type_check";--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_assigned_by_user_id_user_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capabilities_status_idx" ON "capabilities" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_capabilities_agent_idx" ON "agent_capabilities" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_capabilities_capability_idx" ON "agent_capabilities" USING btree ("capability_id");--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("audit_entries"."event_type" in ('task.created','task.transitioned','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked'));
