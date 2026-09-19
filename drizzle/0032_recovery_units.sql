-- Phase 7C — Runtime Recovery (ADR-0027). Additive: one new coordination table, no FK, no existing table touched.
-- Rollback: DROP TABLE "recovery_units"; (rebuildable — scans recompute everything from business state).
-- Integration note: 7B (memory) may also claim 0031; renumber one of them (file, journal tag/idx/when).
CREATE TABLE IF NOT EXISTS "recovery_units" (
	"kind" text NOT NULL,
	"unit_key" text NOT NULL,
	"mission_id" text NOT NULL,
	"owner_token" text,
	"lease_until" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"last_error" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "recovery_units_pk" PRIMARY KEY("kind","unit_key"),
	CONSTRAINT "recovery_units_attempts_check" CHECK ("attempt_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recovery_units_mission_idx" ON "recovery_units" USING btree ("mission_id");
