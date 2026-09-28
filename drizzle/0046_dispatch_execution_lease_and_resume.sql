-- 0046_dispatch_execution_lease_and_resume
--
-- Durable retry/resume and execution fencing for external workers (M6.3).
--
-- WHY THIS EXISTS
-- M6.3 launches real external worker processes. Three facts about a run have to
-- outlive the process that observed them, or autonomy is impossible:
--   1. HOW it failed, finely enough to decide whether retrying is sensible. The
--      business record (`task_execution_results.error_code`) is deliberately coarse
--      and Cockpit-facing; "the provider throttled us" and "this task is
--      impossible" are both WORKER_FAILED there, and that difference is the whole
--      retry decision.
--   2. WHAT the worker had already done, so the next attempt CONTINUES the same
--      logical task instead of starting over.
--   3. WHO is currently running the attempt, so a second runner cannot report a
--      result for work someone else owns.
--
-- WHY A SEPARATE EXECUTION LEASE, NOT claim_token/claim_until
-- Those columns already exist and already have a meaning: they fence WHO MAY
-- DISPATCH a `prepared` attempt during crash recovery. An execution lease fences
-- WHO IS CURRENTLY RUNNING a `dispatched` attempt. Different state, different
-- lifetime, different owner — and they can be held at the same time by different
-- processes. Sharing the columns would let a recovery sweeper and a running
-- executor silently overwrite each other's fence, which is precisely the
-- double-execution bug the fence exists to prevent. This answers the question
-- STATE.md left open for M7 for the EXECUTION half; recovery claims are untouched.
--
-- WHAT THIS CHANGES
-- Five ADDITIVE, NULLABLE columns on dispatch_attempts, plus one CHECK constraint
-- restricting failure_class to the M6.3 taxonomy, plus one partial index for
-- finding resumable attempts.
--
-- DATA SAFETY
-- No column dropped, renamed or retyped. No existing row read or rewritten. Every
-- new column is NULL on existing rows, which reads correctly as "never executed by
-- an external worker": no failure class, no resume token, no lease. The CHECK
-- admits NULL, so no existing row can become invalid.
-- Guarded and idempotent: re-running is a no-op.
--
-- ROLLBACK
--   ALTER TABLE dispatch_attempts DROP CONSTRAINT IF EXISTS dispatch_attempts_failure_class_check;
--   DROP INDEX IF EXISTS dispatch_attempts_resumable_idx;
--   ALTER TABLE dispatch_attempts
--     DROP COLUMN IF EXISTS failure_class,
--     DROP COLUMN IF EXISTS resume_token,
--     DROP COLUMN IF EXISTS handoff,
--     DROP COLUMN IF EXISTS execution_lease_owner,
--     DROP COLUMN IF EXISTS execution_lease_until;
-- Rolling back LOSES resume state, so in-flight retries restart from scratch
-- instead of continuing. It corrupts no mission, task or dispatch state, and
-- exactly-once dispatch per attempt is unaffected (that rests on the pre-existing
-- unique constraints, not on anything here).

ALTER TABLE dispatch_attempts
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS resume_token text,
  ADD COLUMN IF NOT EXISTS handoff jsonb,
  ADD COLUMN IF NOT EXISTS execution_lease_owner text,
  ADD COLUMN IF NOT EXISTS execution_lease_until timestamptz;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_attempts_failure_class_check') THEN
    ALTER TABLE dispatch_attempts DROP CONSTRAINT dispatch_attempts_failure_class_check;
  END IF;

  -- ALLOW-list, NULL permitted. An unknown class cannot be stored even by a caller
  -- that bypasses the Zod contract, so a typo can never become an unreadable
  -- retry decision.
  ALTER TABLE dispatch_attempts ADD CONSTRAINT dispatch_attempts_failure_class_check
    CHECK (failure_class IS NULL OR failure_class IN (
      'SESSION_EXHAUSTED',
      'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED',
      'STREAM_FAILED',
      'WORKER_CRASHED',
      'LEASE_EXPIRED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL'
    ));
END
$$;

-- Finding "the attempt whose work the next attempt should continue" is a lookup by
-- mission task, newest first, over the few rows that carry resume state. Partial,
-- so it stays small on a table that is mostly completed attempts.
CREATE INDEX IF NOT EXISTS dispatch_attempts_resumable_idx
  ON dispatch_attempts (mission_task_id, attempt DESC)
  WHERE resume_token IS NOT NULL;
