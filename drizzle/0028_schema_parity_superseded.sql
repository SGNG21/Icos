-- Phase 6.1 — schema parity, forward-only and idempotent (never edits applied history).
-- Replaces the unjournaled 0028/0029 drafts and the in-place edit of 0000.

-- Task and MissionTask states include 'superseded' (replan).
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_status_check";
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("status" in ('draft','queued','awaiting_approval','running','review_pending','succeeded','failed','cancelled','superseded'));
--> statement-breakpoint
ALTER TABLE "mission_tasks" DROP CONSTRAINT IF EXISTS "mission_tasks_status_check";
--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_status_check" CHECK ("status" in ('draft','queued','awaiting_approval','running','review_pending','succeeded','failed','cancelled','blocked','superseded'));
--> statement-breakpoint
-- approvals: schema.ts expects `created_at` (never migrated) and `decided_by_label`
-- (an in-place edit of 0000 had renamed it to `decided_by` on the live database).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'approvals' AND column_name = 'decided_by')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'approvals' AND column_name = 'decided_by_label') THEN
    ALTER TABLE "approvals" RENAME COLUMN "decided_by" TO "decided_by_label";
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "approvals" ALTER COLUMN "created_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "actions" ALTER COLUMN "created_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "created_at" SET DEFAULT now();
