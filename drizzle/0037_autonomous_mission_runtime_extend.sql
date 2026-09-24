ALTER TABLE "autonomous_mission_runtime"
ADD COLUMN "workerId" text,
ADD COLUMN "workspaceId" text,
ADD COLUMN "attemptId" text,
ADD COLUMN "workflowId" text;
