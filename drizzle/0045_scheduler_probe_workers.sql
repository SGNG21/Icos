-- 0045_scheduler_probe_workers
--
-- Autonomous worker probing as a durable scheduled job (M6, defect 16).
--
-- WHY THIS EXISTS
-- 0043 made health evidence expirable and M6.1 made the probe real, but NOTHING
-- called it. A probe nobody runs is a probe that does not exist: evidence expires,
-- every worker becomes ineligible, and the fleet sits idle in a way that looks
-- like a routing defect rather than a missing caller.
--
-- WHY A JOB AND NOT A TIMER
-- A `setInterval` would run once PER PROCESS, so N replicas would probe the same
-- fleet N times, and it would vanish on restart. `scheduled_jobs` (ADR-0025)
-- already holds the next run time durably and hands out a lease, so exactly one
-- process sweeps at a time and the recurrence survives a restart. Timers only
-- trigger a consultation of this table; they are never the source of truth.
--
-- WHAT THIS CHANGES
-- Exactly one CHECK constraint: the `kind` allow-list gains 'probe_workers'.
-- It remains an ALLOW-list — a kind not named here still cannot be stored, so a
-- typo'd or unknown job kind is rejected at the database boundary.
--
-- DATA SAFETY
-- No column added, dropped, renamed or retyped. No row read or rewritten. The
-- constraint is WIDENED, never narrowed, so no existing row can become invalid.
-- Guarded and idempotent: re-running is a no-op.
--
-- ROLLBACK
--   Delete any remaining probe_workers rows, then restore the narrower CHECK:
--     DELETE FROM scheduled_jobs WHERE kind = 'probe_workers';
--     ALTER TABLE scheduled_jobs DROP CONSTRAINT IF EXISTS scheduled_jobs_kind_check;
--     ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_kind_check
--       CHECK (kind IN ('start_mission','wake_mission'));
-- Rolling back stops autonomous probing: evidence then expires and the fleet
-- fails closed. It corrupts no mission, task or dispatch state.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_kind_check') THEN
    ALTER TABLE scheduled_jobs DROP CONSTRAINT scheduled_jobs_kind_check;
  END IF;

  ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_kind_check
    CHECK (kind IN ('start_mission','wake_mission','probe_workers'));
END
$$;
