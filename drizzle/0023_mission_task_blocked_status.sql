ALTER TABLE "mission_tasks"
DROP CONSTRAINT IF EXISTS "mission_tasks_status_check";
--> statement-breakpoint
ALTER TABLE "mission_tasks"
ADD CONSTRAINT "mission_tasks_status_check"
CHECK (
  "status" IN (
    'draft',
    'queued',
    'awaiting_approval',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'blocked'
  )
);
