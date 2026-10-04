-- `cancelled` is a real assignment status.
--
-- The CHECK predates the transition, so the database refused every withdrawal while the
-- domain logic happily computed one — the update failed and the assignment stayed
-- `assigned`. A status the code can reach and the table cannot hold is not a status.
--
-- Withdrawal is the only exit that does not require the work to be done. Without it an
-- assignment left `assigned` only by being executed and reviewed, so a mission that
-- failed early stranded its delegations for ever and they went on consuming the
-- delegant's parallel-assignment capacity until Chief could delegate nothing at all.
ALTER TABLE workforce_assignments
  DROP CONSTRAINT IF EXISTS workforce_assignments_status_check;

ALTER TABLE workforce_assignments
  ADD CONSTRAINT workforce_assignments_status_check
  CHECK (status = ANY (ARRAY[
    'assigned'::text,
    'executing'::text,
    'in_review'::text,
    'changes_requested'::text,
    'accepted'::text,
    'blocked'::text,
    'synthesized'::text,
    'cancelled'::text
  ]));
