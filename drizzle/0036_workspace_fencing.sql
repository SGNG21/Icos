-- Workspace Fencing Migration
-- Adds fencing token, workflow_id, and constraints for durable workspace ownership

ALTER TABLE icos_workspace_registry
  ADD COLUMN IF NOT EXISTS fencing_token INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS workflow_id TEXT;

-- Add partial unique constraint for active workflows (released_at IS NULL)
-- This allows rebind after workspace is released while preventing duplicate active workflows
CREATE UNIQUE INDEX IF NOT EXISTS uq_icos_workspace_registry_active_workflow
  ON icos_workspace_registry (workflow_id)
  WHERE workflow_id IS NOT NULL AND released_at IS NULL;

-- Add index on lease_owner and lease_expires_at for efficient lease queries
CREATE INDEX IF NOT EXISTS idx_icos_workspace_registry_lease
  ON icos_workspace_registry (lease_owner, lease_expires_at)
  WHERE lease_owner IS NOT NULL;