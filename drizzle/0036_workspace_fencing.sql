-- Workspace Fencing Migration
-- Self-contained because the workspace registry predates the Drizzle migration chain.

CREATE TABLE IF NOT EXISTS icos_workspace_registry (
  workspace_id TEXT PRIMARY KEY,
  worker_id TEXT NOT NULL,
  mission_id TEXT,
  task_id TEXT,
  slug TEXT NOT NULL,
  branch TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  base_commit TEXT NOT NULL,
  integration_target TEXT NOT NULL,
  file_scope_owns TEXT[] NOT NULL DEFAULT '{}',
  file_scope_shared TEXT[] NOT NULL DEFAULT '{}',
  file_scope_forbidden TEXT[] NOT NULL DEFAULT '{}',
  migration_from INTEGER,
  migration_to INTEGER,
  migration_namespace TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ,
  source_commit TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  workflow_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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