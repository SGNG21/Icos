CREATE TABLE "autonomous_mission_runtime" (
  "mission_id" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL,

  "started_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "last_heartbeat_at" timestamp with time zone NOT NULL,
  "last_progress_at" timestamp with time zone NOT NULL,

  "cycle_count" integer NOT NULL,
  "replan_count" integer NOT NULL,
  "stagnation_count" integer NOT NULL,

  "max_cycles" integer NOT NULL,
  "max_replans" integer NOT NULL,
  "max_runtime_ms" integer NOT NULL,
  "max_stagnation_cycles" integer NOT NULL,

  "last_fingerprint" text,
  "last_reason" text,

  CONSTRAINT "autonomous_mission_runtime_state_check"
    CHECK (
      "state" IN (
        'running',
        'waiting',
        'replanning',
        'succeeded',
        'failed',
        'blocked',
        'cancelled',
        'escalated'
      )
    ),

  CONSTRAINT "autonomous_mission_runtime_cycle_count_check"
    CHECK ("cycle_count" >= 0),

  CONSTRAINT "autonomous_mission_runtime_replan_count_check"
    CHECK ("replan_count" >= 0),

  CONSTRAINT "autonomous_mission_runtime_stagnation_count_check"
    CHECK ("stagnation_count" >= 0),

  CONSTRAINT "autonomous_mission_runtime_max_cycles_check"
    CHECK ("max_cycles" >= 1),

  CONSTRAINT "autonomous_mission_runtime_max_replans_check"
    CHECK ("max_replans" >= 0),

  CONSTRAINT "autonomous_mission_runtime_max_runtime_ms_check"
    CHECK ("max_runtime_ms" >= 1),

  CONSTRAINT "autonomous_mission_runtime_max_stagnation_check"
    CHECK ("max_stagnation_cycles" >= 1)
);
--> statement-breakpoint
ALTER TABLE "autonomous_mission_runtime"
ADD CONSTRAINT "autonomous_mission_runtime_mission_id_missions_id_fk"
FOREIGN KEY ("mission_id")
REFERENCES "public"."missions"("id")
ON DELETE cascade;
--> statement-breakpoint
CREATE INDEX "autonomous_mission_runtime_state_idx"
ON "autonomous_mission_runtime" ("state");
--> statement-breakpoint
CREATE INDEX "autonomous_mission_runtime_heartbeat_idx"
ON "autonomous_mission_runtime" ("last_heartbeat_at");
