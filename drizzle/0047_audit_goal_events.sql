-- 0047_audit_goal_events
--
-- Allow the goal lifecycle's audit events (M12).
--
-- WHY THIS EXISTS
-- `PostgresGoalRepository` writes `goal.created`, `goal.status_updated`, `goal.converted` and
-- `goal.idempotency_key_set`, and none of them were in the `audit_event_type_check`
-- allow-list. Every goal write therefore failed on PostgreSQL with a constraint violation.
-- Nothing noticed because nothing created a goal through that repository until
-- self-development did: the goal path was built, and never exercised.
--
-- WHAT THIS CHANGES
-- Exactly one CHECK constraint: four event types are added to the allow-list.
-- It remains an ALLOW-list — an unknown or typo'd event type is still rejected at the
-- database boundary, which is the property that makes the audit trail trustworthy.
--
-- DATA SAFETY
-- No column added, dropped, renamed or retyped. No row read or rewritten. The constraint is
-- WIDENED, never narrowed, so no existing row can become invalid.
-- Guarded and idempotent: re-running is a no-op.
--
-- ROLLBACK
--   Delete any goal.* audit rows, then restore the narrower CHECK:
--     DELETE FROM audit_entries WHERE event_type LIKE 'goal.%';
--     ALTER TABLE audit_entries DROP CONSTRAINT IF EXISTS audit_event_type_check;
--     ALTER TABLE audit_entries ADD CONSTRAINT audit_event_type_check
--       CHECK (event_type IN (<the 37 pre-0047 values>));
-- Rolling back makes every goal write fail again; it corrupts nothing.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_event_type_check') THEN
    ALTER TABLE audit_entries DROP CONSTRAINT audit_event_type_check;
  END IF;

  ALTER TABLE audit_entries ADD CONSTRAINT audit_event_type_check
    CHECK (event_type IN (
      'task.created','task.transitioned','task.execution.dispatched','task.execution.started',
      'task.execution.completed','approval.recorded','action.decided','user.created',
      'role.changed','auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded',
      'auth.login.rejected','auth.logout.succeeded','auth.access.denied','human_user.created',
      'human_user.role_changed','human_user.enabled','human_user.disabled',
      'human_agent_link.created','human_agent_link.removed','human_user.administration_denied',
      'capability.created','capability.updated','capability.status_changed',
      'agent_capability.granted','agent_capability.revoked','skill.created','skill.imported',
      'skill.content_changed','skill.trust_changed','skill.activation_changed',
      'skill.security_scan_recorded','skill.eval_recorded','mission.created',
      'mission.transitioned','mission.task.dispatched',
      -- M12: the goal lifecycle, previously unwritable.
      'goal.created','goal.status_updated','goal.converted','goal.idempotency_key_set'
    ));
END
$$;
