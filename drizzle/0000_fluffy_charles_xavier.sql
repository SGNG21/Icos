CREATE TABLE "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"initiated_by_agent_id" text NOT NULL,
	"task_id" text,
	"kind" text NOT NULL,
	"risk" text NOT NULL,
	"requires_human_approval" boolean NOT NULL,
	"approval_status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "actions_risk_check" CHECK ("actions"."risk" in ('read_only','reversible','sensitive')),
	CONSTRAINT "actions_approval_status_check" CHECK ("actions"."approval_status" in ('not_required','pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"authorization_level" smallint NOT NULL,
	"description" text NOT NULL,
	CONSTRAINT "agents_status_check" CHECK ("agents"."status" in ('available','standby','offline')),
	CONSTRAINT "agents_auth_level_check" CHECK ("agents"."authorization_level" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"action_id" text NOT NULL,
	"decision" text NOT NULL,
	"decided_by_label" text NOT NULL,
	"reason" text,
	"decided_at" timestamp with time zone NOT NULL,
	CONSTRAINT "approvals_action_id_unique" UNIQUE("action_id"),
	CONSTRAINT "approvals_decision_check" CHECK ("approvals"."decision" in ('approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "audit_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_label" text NOT NULL,
	"task_id" text,
	"action_id" text,
	"details" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_event_type_check" CHECK ("audit_entries"."event_type" in ('task.created','task.transitioned','approval.recorded','action.decided')),
	CONSTRAINT "audit_actor_type_check" CHECK ("audit_entries"."actor_type" in ('agent','human','system'))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"assigned_agent_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK ("tasks"."status" in ('draft','queued','awaiting_approval','running','succeeded','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_initiated_by_agent_id_agents_id_fk" FOREIGN KEY ("initiated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_entries_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_agent_id_agents_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_task_idx" ON "actions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "actions_approval_status_idx" ON "actions" USING btree ("approval_status");--> statement-breakpoint
CREATE INDEX "actions_initiator_idx" ON "actions" USING btree ("initiated_by_agent_id");--> statement-breakpoint
CREATE INDEX "audit_event_type_idx" ON "audit_entries" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_entries" USING btree ("action_id");--> statement-breakpoint
CREATE INDEX "audit_task_idx" ON "audit_entries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "audit_actor_label_idx" ON "audit_entries" USING btree ("actor_label");--> statement-breakpoint
CREATE INDEX "audit_occurred_at_idx" ON "audit_entries" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "tasks_assigned_agent_idx" ON "tasks" USING btree ("assigned_agent_id");