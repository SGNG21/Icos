-- N2.1 — PostgreSQL schema parity with src/server/database/schema.ts
-- Additive/normalizing migration for durable autonomy foundations.

-- ---------------------------------------------------------------------------
-- checkpoints
-- Historical migration 0010 created "missionId"; current Drizzle schema uses
-- mission_id.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'checkpoints'
      AND column_name = 'missionId'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'checkpoints'
      AND column_name = 'mission_id'
  )
  THEN
    ALTER TABLE checkpoints RENAME COLUMN "missionId" TO mission_id;
  END IF;
END
$$;

DROP INDEX IF EXISTS "checkpoints_missionId_idx";
CREATE INDEX IF NOT EXISTS checkpoints_mission_id_idx
  ON checkpoints (mission_id);

-- ---------------------------------------------------------------------------
-- mission_tasks
-- capability exists in the domain/repository but was never added by the
-- historical migrations.
-- ---------------------------------------------------------------------------

ALTER TABLE mission_tasks
  ADD COLUMN IF NOT EXISTS capability text;

-- ---------------------------------------------------------------------------
-- task_execution_results
-- Bring the durable execution evidence table in sync with schema.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE task_execution_results
  ADD COLUMN IF NOT EXISTS capability text,
  ADD COLUMN IF NOT EXISTS digitalos_execution_id text,
  ADD COLUMN IF NOT EXISTS observations jsonb,
  ADD COLUMN IF NOT EXISTS confidence double precision,
  ADD COLUMN IF NOT EXISTS artifacts jsonb,
  ADD COLUMN IF NOT EXISTS evidence jsonb,
  ADD COLUMN IF NOT EXISTS findings jsonb;

-- Historical 0007 allowed only hermes / openhands / other.
-- Current runtime also supports digitalos and agent.
ALTER TABLE task_execution_results
  DROP CONSTRAINT IF EXISTS task_execution_results_worker_kind_check;

ALTER TABLE task_execution_results
  ADD CONSTRAINT task_execution_results_worker_kind_check
  CHECK (
    worker_kind IS NULL
    OR worker_kind IN ('hermes', 'openhands', 'digitalos', 'other', 'agent')
  );
