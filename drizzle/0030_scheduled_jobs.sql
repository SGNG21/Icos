-- Phase 7A — Durable Scheduler (ADR-0025). Additive: one new table.
CREATE TABLE IF NOT EXISTS "scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"backoff_base_ms" integer DEFAULT 5000 NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"mission_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "scheduled_jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "scheduled_jobs_kind_check" CHECK ("kind" in ('start_mission','wake_mission')),
	CONSTRAINT "scheduled_jobs_state_check" CHECK ("state" in ('scheduled','running','succeeded','dead','expired')),
	CONSTRAINT "scheduled_jobs_attempts_check" CHECK ("max_attempts" >= 1 and "attempt_count" >= 0),
	CONSTRAINT "scheduled_jobs_backoff_check" CHECK ("backoff_base_ms" >= 0),
	CONSTRAINT "scheduled_jobs_running_lease_check" CHECK ("state" <> 'running' or ("lease_owner" is not null and "lease_until" is not null))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_jobs_due_idx" ON "scheduled_jobs" USING btree ("state","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_jobs_lease_idx" ON "scheduled_jobs" USING btree ("state","lease_until");
