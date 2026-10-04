-- DISPATCHED must imply a finite lease, and a finished execution must release it.
--
-- Two fixes landed in code: `markDispatched` now writes the lease in the same statement as
-- the state, and a recorded result now settles its attempt BEFORE the review gate instead
-- of after it. These are the rows written before both.
--
-- They are NOT abandoned runners. All nineteen already carry a recorded
-- `task_execution_results` row — fifteen successful — so the work really landed; only the
-- attempt state was never advanced, and each kept holding a slot on a worker of
-- concurrency 1 until the fleet had no capacity left.
--
-- So they are settled, not deleted and not reclaimed as failures: `completed` is what the
-- canonical settlement would have written had it run, and it is the state their evidence
-- supports. The lease is cleared because releasing it IS releasing the capacity.
--
-- Strictly bounded to rows whose result exists. A dispatched attempt with no result is
-- left alone: that one may still be live, and recovery's lease scan is what decides it.
UPDATE dispatch_attempts d
SET state = 'completed',
    execution_lease_owner = NULL,
    execution_lease_until = NULL,
    claim_token = NULL,
    claim_until = NULL,
    updated_at = now()
WHERE d.state = 'dispatched'
  AND EXISTS (
    SELECT 1 FROM task_execution_results r WHERE r.workflow_id = d.workflow_id
  );

-- Anything still dispatched with no result and no lease gets a finite expiry derived from
-- when it was actually dispatched, so the EXISTING abandoned-execution scan can see it,
-- fence the owner and reclaim it through canonical recovery. A null lease never becomes
-- an infinite one, and nothing is reclaimed by this migration itself.
UPDATE dispatch_attempts d
SET execution_lease_owner = 'legacy:pre-lease-invariant',
    execution_lease_until = COALESCE(d.dispatched_at, d.updated_at, now()),
    updated_at = now()
WHERE d.state = 'dispatched'
  AND d.execution_lease_until IS NULL;
