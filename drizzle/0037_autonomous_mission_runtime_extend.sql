ALTER TABLE "autonomous_mission_runtime"
ADD COLUMN "worker_id" text,
ADD COLUMN "workspace_id" text,
ADD COLUMN "attempt_id" text,
ADD COLUMN "workflow_id" text;