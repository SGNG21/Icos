-- 0064_scheduler_reconcile_compute_fleet
--
-- Periodic compute fleet reconciliation as a durable scheduled job (P1 of the ICOS voice
-- diagnosis « je ne vois pas Claude »).
--
-- WHY THIS EXISTS
-- The fleet was reconciled with what OmniRoute serves only at boot: a model the provider
-- started serving after the last restart stayed invisible to routing until the next restart.
--
-- WHY A JOB AND NOT A TIMER (same reasoning as 0045 `probe_workers`)
-- A `setInterval` runs once PER PROCESS and vanishes on restart. `scheduled_jobs` (ADR-0025)
-- holds the next run time durably and hands out a lease, so exactly one process reconciles at
-- a time across replicas and the recurrence survives a restart.
--
-- WHAT THIS CHANGES
-- Exactly one CHECK constraint: the `kind` allow-list gains 'reconcile_compute_fleet'. It
-- remains an ALLOW-list; the list below is 0053's list plus the new kind, never a rewrite.
--
-- DATA SAFETY
-- No column added, dropped, renamed or retyped. No row read or rewritten. The constraint is
-- WIDENED, never narrowed, so no existing row can become invalid. Guarded and idempotent.
--
-- ROLLBACK
--   DELETE FROM scheduled_jobs WHERE kind = 'reconcile_compute_fleet';
--   ALTER TABLE scheduled_jobs DROP CONSTRAINT IF EXISTS scheduled_jobs_kind_check;
--   ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_kind_check
--     CHECK (kind IN ('start_mission','wake_mission','probe_workers','supervisor_observe'));
-- Rolling back returns to boot-only reconciliation (ICOS_COMPUTE_BOOTSTRAP still reconciles at
-- every boot). It corrupts no worker, mission, task or dispatch state.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_kind_check') THEN
    ALTER TABLE scheduled_jobs DROP CONSTRAINT scheduled_jobs_kind_check;
  END IF;

  ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_kind_check
    CHECK (kind IN ('start_mission','wake_mission','probe_workers','supervisor_observe','reconcile_compute_fleet'));
END
$$;
