-- 0043_worker_probe_evidence
--
-- Durable health-probe evidence (M5.2, defect 14).
--
-- WHY THIS EXISTS
-- 0042 gave a worker `health` and `availability`, and M5.1 gave it a write side
-- (WorkerRegistrationService.probe). Nothing recorded WHEN that evidence was
-- produced, and nothing produced it on a loop. Two consequences, both bad:
--   1. `health = 'healthy'` written once stayed 'healthy' forever. A worker
--      whose process died kept looking eligible indefinitely, because the row
--      has no way to age.
--   2. A process restart re-read 'healthy' and believed it — evidence with no
--      timestamp cannot be distinguished from evidence recorded a week ago.
-- A health claim that cannot be dated cannot be trusted, so it must not be
-- allowed to route work.
--
-- WHAT THIS ADDS
--   last_probe_at      — when a PROBE last recorded evidence. NULL = never
--                        probed. Registration leaves it NULL on purpose:
--                        announcing yourself is not evidence that you work.
--   last_probe_outcome — what the probe actually did. 'failed' and
--                        'unsupported' are deliberately distinct from 'never':
--                        a runtime/provider probe that failed must stay visible
--                        as a failure and must never silently read as "healthy"
--                        or as "not looked at yet".
--
-- FAIL CLOSED
-- Both columns default to the no-evidence state (NULL / 'never'). The canonical
-- matcher (src/core/workers/worker-eligibility.ts) refuses a worker whose
-- evidence is missing or older than the configured horizon, and
-- WorkerHealthProber.expireStaleEvidence() additionally resets expired rows to
-- health='unknown', availability='unknown', last_probe_outcome='stale' so the
-- DURABLE state converges to ineligible even for a consumer that passes no
-- horizon. Stale health therefore fails closed at BOTH the read boundary and
-- in the stored state.
--
-- NO PROVIDER SEMANTICS
-- Nothing here names a model, a provider or an account. A probe adapter is
-- resolved from data (worker kind), so adding a worker type needs no schema and
-- no code change here.
--
-- DATA SAFETY
-- Additive only: two nullable/defaulted columns on `workers`. No column is
-- dropped, renamed or retyped, no row is rewritten, no constraint is relaxed.
-- Existing rows become "never probed", which is the fail-closed reading — an
-- upgrade can therefore only make routing MORE restrictive, never less.
-- Every statement is guarded, so re-running is a no-op.
--
-- ROLLBACK
--   ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_last_probe_outcome_check;
--   ALTER TABLE workers DROP COLUMN IF EXISTS last_probe_outcome;
--   ALTER TABLE workers DROP COLUMN IF EXISTS last_probe_at;
-- Rolling back loses probe timestamps and returns routing to M5.1 behaviour
-- (health trusted without an age). It corrupts nothing.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_probe_at timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_probe_outcome text NOT NULL DEFAULT 'never';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_last_probe_outcome_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_last_probe_outcome_check
      CHECK (last_probe_outcome IN ('never','ok','failed','unsupported','stale'));
  END IF;

  -- An 'ok' probe without a timestamp is undatable evidence: the matcher would
  -- have to guess its age. Refuse the combination at the database boundary.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_probe_evidence_dated_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_probe_evidence_dated_check
      CHECK (last_probe_outcome = 'never' OR last_probe_at IS NOT NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS workers_last_probe_at_idx ON workers (last_probe_at);
