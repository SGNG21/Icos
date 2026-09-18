ALTER TABLE "tasks"
  DROP CONSTRAINT "tasks_status_check";
--> statement-breakpoint
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_status_check"
  CHECK ("status" IN (
    'draft',
    'queued',
    'awaiting_approval',
    'running',
    'review_pending',
    'succeeded',
    'failed',
    'cancelled'
  ));
--> statement-breakpoint
ALTER TABLE "mission_tasks"
  DROP CONSTRAINT "mission_tasks_status_check";
--> statement-breakpoint
ALTER TABLE "mission_tasks"
  ADD CONSTRAINT "mission_tasks_status_check"
  CHECK ("status" IN (
    'draft',
    'queued',
    'awaiting_approval',
    'running',
    'review_pending',
    'succeeded',
    'failed',
    'cancelled',
    'blocked',
    'superseded'
  ));
--> statement-breakpoint
ALTER TABLE "decisions"
  DROP CONSTRAINT "decisions_decision_check";
--> statement-breakpoint
ALTER TABLE "decisions"
  ADD CONSTRAINT "decisions_decision_check"
  CHECK ("decision" IN (
    'APPROVE',
    'REQUEST_CHANGES',
    'RETRY',
    'REPLAN',
    'BLOCK',
    'ESCALATE_TO_HUMAN'
  ));
--> statement-breakpoint
CREATE TABLE "quality_control_jobs" (
  "workflow_id" text PRIMARY KEY NOT NULL,
  "execution_result_id" text NOT NULL,
  "mission_id" text NOT NULL,
  "mission_task_id" text NOT NULL,
  "task_id" text NOT NULL,
  "execution_attempt" integer NOT NULL,
  "review_attempt_count" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL,
  "review_decision_id" text,
  "action" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "claim_token" text,
  "claim_until" timestamp with time zone,
  "last_error" text,
  CONSTRAINT "quality_control_jobs_execution_result_unique" UNIQUE ("execution_result_id"),
  CONSTRAINT "quality_control_jobs_execution_attempt_check" CHECK ("execution_attempt" >= 1),
  CONSTRAINT "quality_control_jobs_review_attempt_check" CHECK ("review_attempt_count" >= 0),
  CONSTRAINT "quality_control_jobs_state_check" CHECK ("state" IN (
    'review_pending',
    'reviewing',
    'decision_ready',
    'action_applied',
    'escalated'
  )),
  CONSTRAINT "quality_control_jobs_action_check" CHECK (
    "action" IS NULL OR "action" IN ('ACCEPT','CORRECT','RETRY','REPLAN','ESCALATE')
  )
);
--> statement-breakpoint
ALTER TABLE "quality_control_jobs"
  ADD CONSTRAINT "quality_control_jobs_execution_result_fk"
  FOREIGN KEY ("execution_result_id") REFERENCES "public"."task_execution_results"("id")
  ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "quality_control_jobs"
  ADD CONSTRAINT "quality_control_jobs_mission_fk"
  FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id")
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "quality_control_jobs"
  ADD CONSTRAINT "quality_control_jobs_mission_task_fk"
  FOREIGN KEY ("mission_task_id") REFERENCES "public"."mission_tasks"("id")
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "quality_control_jobs"
  ADD CONSTRAINT "quality_control_jobs_task_fk"
  FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id")
  ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "quality_control_jobs"
  ADD CONSTRAINT "quality_control_jobs_review_decision_fk"
  FOREIGN KEY ("review_decision_id") REFERENCES "public"."decisions"("id")
  ON DELETE restrict;
--> statement-breakpoint
CREATE INDEX "quality_control_jobs_pending_idx"
  ON "quality_control_jobs" ("state", "claim_until", "created_at");
--> statement-breakpoint
CREATE INDEX "quality_control_jobs_mission_idx"
  ON "quality_control_jobs" ("mission_id");
