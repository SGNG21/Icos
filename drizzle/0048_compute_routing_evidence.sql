-- 0048_compute_routing_evidence
--
-- Governed multi-model worker routing (decision 0054).
--
-- WHY THIS EXISTS
-- 1. `failure_class` could not say "we killed it for its budget": a timeout was stored as
--    STREAM_FAILED, the class for a dropped transport. Self-build run 5 lost both correction
--    attempts to 20-minute budget timeouts and the ledger recorded them as stream failures, so
--    routing had nothing to route away from. Three classes are added: EXECUTION_TIMEOUT,
--    AUTH_FAILURE, MODEL_UNAVAILABLE.
-- 2. `routing_decision` is the ROUTING_DECISION evidence for the attempt: candidate set,
--    exclusions and why, scores, policy version, budget, lease. Written in the SAME
--    transaction that creates the attempt, and never updated, so the "why this compute" of an
--    attempt survives a restart exactly as long as the attempt does.
-- 3. `execution_duration_ms` is what the worker process actually took. It feeds latency and
--    timeout history; `updated_at - created_at` includes queueing and is not it.
--
-- DATA SAFETY
-- Additive only. Both columns are nullable and NULL on every existing row, which reads
-- correctly as "routed before decision 0054" / "duration not observed". The CHECK is only
-- WIDENED: every value it admitted before it still admits, so no existing row can fail it.
-- Guarded and idempotent: re-running is a no-op.
--
-- ROLLBACK
--   Rows carrying one of the three new classes must be mapped back first, or the narrower
--   CHECK cannot be re-added:
--     UPDATE dispatch_attempts SET failure_class = 'STREAM_FAILED'
--       WHERE failure_class = 'EXECUTION_TIMEOUT';
--     UPDATE dispatch_attempts SET failure_class = 'PROVIDER_UNAVAILABLE'
--       WHERE failure_class IN ('AUTH_FAILURE', 'MODEL_UNAVAILABLE');
--   then re-run the DO block of 0046, and
--     ALTER TABLE dispatch_attempts DROP COLUMN IF EXISTS routing_decision,
--       DROP COLUMN IF EXISTS execution_duration_ms;
--   Rolling back loses routing evidence and duration history; it corrupts no mission, task
--   or attempt state (routing reads neither to decide eligibility of an existing attempt).

ALTER TABLE dispatch_attempts
  ADD COLUMN IF NOT EXISTS routing_decision jsonb,
  ADD COLUMN IF NOT EXISTS execution_duration_ms integer;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_attempts_failure_class_check') THEN
    ALTER TABLE dispatch_attempts DROP CONSTRAINT dispatch_attempts_failure_class_check;
  END IF;

  ALTER TABLE dispatch_attempts ADD CONSTRAINT dispatch_attempts_failure_class_check
    CHECK (failure_class IS NULL OR failure_class IN (
      'SESSION_EXHAUSTED',
      'PROVIDER_UNAVAILABLE',
      'RATE_LIMITED',
      'STREAM_FAILED',
      'WORKER_CRASHED',
      'EXECUTION_TIMEOUT',
      'AUTH_FAILURE',
      'MODEL_UNAVAILABLE',
      'LEASE_EXPIRED',
      'FAILED_RETRYABLE',
      'FAILED_TERMINAL'
    ));

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dispatch_attempts_execution_duration_check'
  ) THEN
    ALTER TABLE dispatch_attempts ADD CONSTRAINT dispatch_attempts_execution_duration_check
      CHECK (execution_duration_ms IS NULL OR execution_duration_ms >= 0);
  END IF;
END
$$;

-- Routing history reads recent terminal attempts that name a worker, newest first.
CREATE INDEX IF NOT EXISTS dispatch_attempts_compute_history_idx
  ON dispatch_attempts (updated_at DESC)
  WHERE worker_id IS NOT NULL AND state IN ('completed', 'failed');
