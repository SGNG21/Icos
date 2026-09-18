-- Phase 6.1 — QC hardening.
-- 1) `review_unavailable`: reviewer outage parks the review (recoverable) instead of failing the task.
-- 2) `wakeup_pending`: durable outbox set atomically with the applied action.
ALTER TABLE "quality_control_jobs" ADD COLUMN IF NOT EXISTS "wakeup_pending" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "quality_control_jobs" DROP CONSTRAINT IF EXISTS "quality_control_jobs_state_check";
--> statement-breakpoint
ALTER TABLE "quality_control_jobs" ADD CONSTRAINT "quality_control_jobs_state_check" CHECK ("state" in ('review_pending','reviewing','decision_ready','review_unavailable','action_applied','escalated'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quality_control_jobs_wakeup_idx" ON "quality_control_jobs" USING btree ("mission_id") WHERE "wakeup_pending";
