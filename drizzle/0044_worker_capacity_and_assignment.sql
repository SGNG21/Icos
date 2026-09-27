-- 0044_worker_capacity_and_assignment
--
-- Durable worker load, capacity semantics and work attribution
-- (M5.3 + M5.5, defects 12 and 15).
--
-- WHY THIS EXISTS
-- After 0043 routing could tell a healthy worker from a stale one, but
-- selection was still `first-eligible-by-id`: ten ready tasks and three healthy
-- capable workers all went to ONE worker. That is not multi-worker
-- orchestration, it is a queue with extra steps.
--
-- Fixing it needs two things the schema did not have:
--
--   1. SOMETHING TO COUNT. `dispatch_attempts` recorded which worker KIND was
--      routed, never WHICH WORKER. Load per worker was therefore unknowable, and
--      so was attribution: "which worker produced this?" had no durable answer,
--      which also left reviewer independence without a real producer identity
--      (defect 12).
--   2. A CEILING TO COUNT AGAINST. Without a declared concurrency a worker is
--      implicitly an unlimited execution slot, so "least loaded" has no meaning
--      and oversubscription cannot even be defined.
--
-- WHY LOAD IS NOT A COLUMN
-- There is deliberately NO `workers.current_load` counter. A counter is a second
-- authority that can disagree with the ledger, and every disagreement is a lost
-- or duplicated dispatch. Load is DERIVED by counting non-terminal rows in
-- `dispatch_attempts` — the same rows that already certify exactly-once dispatch
-- per task (CORE2). One source of truth, and it survives a restart for free,
-- which an in-memory round-robin counter would not: decision 0031 requires
-- routing to be a pure function of durable state.
--
-- WHAT THIS ADDS
--   workers.max_concurrency      — concurrent executions this worker may hold.
--                                  NOT NULL DEFAULT 1: a worker is not an
--                                  unlimited slot.
--   workers.capacity_pool        — opaque name of a SHARED capacity pool. This
--                                  is how several distinct workers competing for
--                                  ONE provider/account quota is expressed
--                                  without conflating Worker with Provider,
--                                  Model, Account or CapacitySlot. No provider
--                                  is named here, by design.
--   workers.capacity_pool_limit  — concurrent executions the whole pool may hold.
--   dispatch_attempts.worker_id  — WHICH worker this attempt was assigned to.
--
-- NO FOREIGN KEY ON worker_id, ON PURPOSE
-- Attribution must outlive the worker. A RESTRICT reference would make
-- deregistering a worker impossible once it had done any work; a SET NULL
-- reference would silently erase the historical record of who did it. The column
-- is therefore a plain text assignment record, and routing never reads it to
-- decide eligibility — only to count load.
--
-- FAIL CLOSED
-- max_concurrency defaults to 1, so an existing row admits ONE concurrent
-- execution rather than unlimited: the upgrade can only make routing MORE
-- restrictive. capacity_pool defaults to NULL (no pool), which bounds nothing
-- extra and cannot loosen the per-worker ceiling. A NULL worker_id on a
-- pre-0044 attempt counts toward no worker, which under-counts load rather than
-- over-granting capacity — the safe direction.
--
-- DATA SAFETY
-- Additive only: three defaulted/nullable columns on `workers`, one nullable
-- column plus one index on `dispatch_attempts`. Nothing is dropped, renamed or
-- retyped; no existing row is rewritten; no constraint is relaxed. Every
-- statement is guarded, so re-running is a no-op.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS dispatch_attempts_worker_active_idx;
--   ALTER TABLE dispatch_attempts DROP COLUMN IF EXISTS worker_id;
--   ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_capacity_pool_limit_check;
--   ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_max_concurrency_check;
--   ALTER TABLE workers DROP COLUMN IF EXISTS capacity_pool_limit;
--   ALTER TABLE workers DROP COLUMN IF EXISTS capacity_pool;
--   ALTER TABLE workers DROP COLUMN IF EXISTS max_concurrency;
-- Rolling back returns selection to first-eligible-by-id and loses per-worker
-- attribution. It corrupts no mission, task or dispatch state.

ALTER TABLE workers ADD COLUMN IF NOT EXISTS max_concurrency integer NOT NULL DEFAULT 1;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS capacity_pool text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS capacity_pool_limit integer;

ALTER TABLE dispatch_attempts ADD COLUMN IF NOT EXISTS worker_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_max_concurrency_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_max_concurrency_check
      CHECK (max_concurrency >= 1);
  END IF;

  -- A pool limit is meaningless without a pool to bound, and a zero/negative
  -- ceiling would silently disable a worker instead of declaring a capacity.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workers_capacity_pool_limit_check') THEN
    ALTER TABLE workers ADD CONSTRAINT workers_capacity_pool_limit_check
      CHECK (
        (capacity_pool_limit IS NULL)
        OR (capacity_pool IS NOT NULL AND capacity_pool_limit >= 1)
      );
  END IF;
END
$$;

-- Load is a count of non-terminal attempts per worker: index exactly that.
CREATE INDEX IF NOT EXISTS dispatch_attempts_worker_active_idx
  ON dispatch_attempts (worker_id, state);
