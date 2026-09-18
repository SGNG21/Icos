CREATE TABLE "dispatch_attempts" (
  "id" text PRIMARY KEY NOT NULL,
  "mission_id" text NOT NULL,
  "mission_task_id" text NOT NULL,
  "task_id" text NOT NULL,
  "attempt" integer NOT NULL,
  "workflow_id" text NOT NULL,
  "prompt" text NOT NULL,
  "worker_kind" text,
  "capability" text,
  "state" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "dispatched_at" timestamp with time zone,
  "last_error" text,

  CONSTRAINT "dispatch_attempts_workflow_id_unique"
    UNIQUE ("workflow_id"),

  CONSTRAINT "dispatch_attempts_mission_task_attempt_unique"
    UNIQUE ("mission_task_id", "attempt"),

  CONSTRAINT "dispatch_attempts_attempt_check"
    CHECK ("attempt" >= 1),

  CONSTRAINT "dispatch_attempts_state_check"
    CHECK ("state" IN ('prepared','dispatched','completed','failed'))
);

ALTER TABLE "dispatch_attempts"
  ADD CONSTRAINT "dispatch_attempts_mission_id_missions_id_fk"
  FOREIGN KEY ("mission_id")
  REFERENCES "public"."missions"("id")
  ON DELETE cascade;

ALTER TABLE "dispatch_attempts"
  ADD CONSTRAINT "dispatch_attempts_mission_task_id_mission_tasks_id_fk"
  FOREIGN KEY ("mission_task_id")
  REFERENCES "public"."mission_tasks"("id")
  ON DELETE cascade;

ALTER TABLE "dispatch_attempts"
  ADD CONSTRAINT "dispatch_attempts_task_id_tasks_id_fk"
  FOREIGN KEY ("task_id")
  REFERENCES "public"."tasks"("id")
  ON DELETE restrict;

CREATE INDEX "dispatch_attempts_mission_idx"
  ON "dispatch_attempts" ("mission_id");

CREATE INDEX "dispatch_attempts_state_idx"
  ON "dispatch_attempts" ("state");
