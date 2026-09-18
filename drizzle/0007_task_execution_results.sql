-- Boucle d'exécution durable (Temporal → ICOS)
-- Migration ADDITIVE : crée la table task_execution_results (preuve métier
-- canonique) et étend le check constraint d'audit avec les événements
-- d'exécution.
--
-- Note : les tables capability/skill (migrations 0005 et 0006) sont écrites à la
-- main sans snapshot Drizzle correspondant ; ce fichier ne les recrée donc PAS,
-- contrairement à la sortie brute de `drizzle-kit generate`.

CREATE TABLE "task_execution_results" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"outcome" text NOT NULL,
	"worker_kind" text,
	"result" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "task_execution_results_workflow_id_unique" UNIQUE("workflow_id"),
	CONSTRAINT "task_execution_results_outcome_check" CHECK ("task_execution_results"."outcome" in ('success','failure')),
	CONSTRAINT "task_execution_results_worker_kind_check" CHECK ("task_execution_results"."worker_kind" is null or "task_execution_results"."worker_kind" in ('hermes','openhands','other')),
	CONSTRAINT "task_execution_results_error_consistency_check" CHECK (("task_execution_results"."outcome" = 'failure' and "task_execution_results"."error_code" is not null and "task_execution_results"."error_message" is not null) or ("task_execution_results"."outcome" = 'success' and "task_execution_results"."error_code" is null and "task_execution_results"."error_message" is null)),
	CONSTRAINT "task_execution_results_error_code_check" CHECK ("task_execution_results"."error_code" is null or "task_execution_results"."error_code" in ('WORKER_FAILED','WORKER_TIMEOUT','WORKER_UNAVAILABLE','INVALID_RESULT','UNKNOWN_EFFECT','CANCELLED','INTERNAL_ERROR'))
);
--> statement-breakpoint
ALTER TABLE "task_execution_results" ADD CONSTRAINT "task_execution_results_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_execution_results_task_idx" ON "task_execution_results" USING btree ("task_id");--> statement-breakpoint
ALTER TABLE "audit_entries" DROP CONSTRAINT "audit_event_type_check";--> statement-breakpoint
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("audit_entries"."event_type" in ('task.created','task.transitioned','task.execution.dispatched','task.execution.started','task.execution.completed','approval.recorded','action.decided','user.created','role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled','human_agent_link.created','human_agent_link.removed','human_user.administration_denied','capability.created','capability.updated','capability.status_changed','agent_capability.granted','agent_capability.revoked','skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed','skill.security_scan_recorded','skill.eval_recorded'));
