-- 0042_worker_registry
--
-- Durable worker registry (mission N15, decision 0031).
--
-- WHY THIS EXISTS
-- container.ts built the worker registry as `new InMemoryWorkerRegistry([])`
-- in BOTH the in-memory and the PostgreSQL composition roots. The registry was
-- therefore empty at boot, not queryable by anything outside the process, and
-- discarded on every restart. `tasks.required_capabilities` has been durable
-- since 0041 but had nothing to match against, so capability routing could not
-- exist, let alone survive a restart.
--
-- WHAT A WORKER IS
-- A Worker is an EXECUTION UNIT. It is NOT a Model, NOT a Provider, NOT an
-- Account and NOT a capacity slot. Those are distinct concerns and are
-- deliberately absent from this table; provider/model/account hints may travel
-- in `metadata` but are NON-AUTHORITATIVE and are never read by routing.
-- No provider name appears in this schema or in the matcher.
--
-- FAIL CLOSED
-- health, availability and runtime_support default to their "unknown" value,
-- and status defaults to 'inactive'. The canonical matcher
-- (src/core/workers/worker-eligibility.ts) admits exactly ONE value per gate:
-- 'active', 'SUPPORTED_RUNTIME', 'healthy', 'available'. A worker inserted with
-- no probe data is therefore routed NOTHING until something proves it healthy.
-- The CHECK constraints below re-assert the closed value sets at the database
-- boundary so a caller bypassing the Zod contract still cannot store garbage.
--
-- DATA SAFETY
-- Additive only: one new table. No existing column is dropped, renamed or
-- retyped; no existing row is read or rewritten. Nothing references this table
-- and this table references nothing, so it cannot break an existing write path.
-- Every statement is guarded, so the migration is safe to re-run.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS workers_status_idx;
--   DROP INDEX IF EXISTS workers_worker_kind_idx;
--   DROP TABLE IF EXISTS workers;
-- Rolling back loses registered workers and returns routing to the
-- ROUTING_UNCONFIGURED state (see capability-router.ts), which dispatches
-- exactly as it did before M4. It does not corrupt missions or tasks.

CREATE TABLE IF NOT EXISTS workers (
  id text PRIMARY KEY,
  worker_kind text NOT NULL,
  display_name text NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  supports_tools boolean NOT NULL DEFAULT false,
  supports_structured_output boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'inactive',
  runtime text NOT NULL DEFAULT 'unknown',
  runtime_support text NOT NULL DEFAULT 'UNKNOWN',
  health text NOT NULL DEFAULT 'unknown',
  availability text NOT NULL DEFAULT 'unknown',
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_status_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_status_check
      CHECK (status IN ('active','inactive','maintenance'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_runtime_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_runtime_check
      CHECK (runtime IN ('node','docker','binary','wasm','unknown'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_runtime_support_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_runtime_support_check
      CHECK (runtime_support IN ('SUPPORTED_RUNTIME','DECLARED_ONLY','UNKNOWN'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_health_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_health_check
      CHECK (health IN ('healthy','degraded','unhealthy','unknown'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_availability_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_availability_check
      CHECK (availability IN ('available','unavailable','unknown'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS workers_worker_kind_idx ON workers (worker_kind);
CREATE INDEX IF NOT EXISTS workers_status_idx ON workers (status);
