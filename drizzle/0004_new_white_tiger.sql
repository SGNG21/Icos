CREATE TABLE "human_agent_links" (
	"id" text PRIMARY KEY NOT NULL,
	"human_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"relation" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_human_user_id" text NOT NULL,
	CONSTRAINT "human_agent_links_human_user_agent_unique" UNIQUE("human_user_id","agent_id"),
	CONSTRAINT "human_agent_links_relation_check" CHECK ("human_agent_links"."relation" in ('supervisor','operator','observer'))
);
--> statement-breakpoint
ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_event_type_check";--> statement-breakpoint
ALTER TABLE "human_agent_links" ADD CONSTRAINT "human_agent_links_human_user_id_user_id_fk" FOREIGN KEY ("human_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_agent_links" ADD CONSTRAINT "human_agent_links_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_agent_links" ADD CONSTRAINT "human_agent_links_created_by_human_user_id_user_id_fk" FOREIGN KEY ("created_by_human_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_agent_links_human_user_idx" ON "human_agent_links" USING btree ("human_user_id");--> statement-breakpoint
CREATE INDEX "human_agent_links_agent_idx" ON "human_agent_links" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "human_agent_links_created_by_idx" ON "human_agent_links" USING btree ("created_by_human_user_id");--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("audit_entries"."event_type" in ('task.created','task.transitioned','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied'));