-- Integration gate reports are durable (ADR 0075, amendment H1).
--
-- `IntegrationGate.integrate` produced an `IntegrationReport` and returned it; nothing kept
-- it (only the manual CLI wrote a text file). The gate now records every report in the
-- append-only audit journal BEFORE it transitions the workspace, under the new event type
-- `workspace.gate.reported`. The list below is the UNION of 0062's list and the new event,
-- never a rewrite.
--
-- DATA SAFETY. A strictly wider CHECK: every row valid before is valid after. No column, no
-- row is modified. Idempotent.
--
-- ROLLBACK (forward-only in this repository; by hand if ever needed, after confirming no
-- audit row uses the new event — audit rows cannot be deleted, so keep a wider check if any
-- exist): re-create audit_event_type_check with exactly 0062_fleet_readiness_evidence's list.
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
      'goal.created','goal.status_updated','goal.converted','goal.idempotency_key_set',
      'control.command.rejected','control.command.admitted','control.command.executed',
      'control.command.failed',
      'tool.execution.recorded','tool.approval.requested','tool.approval.decided',
      'tool.approval.consumed','tool.grant.changed','tool.request.denied',
      'worker.fleet.retired','worker.fleet.reinstated',
      -- 0063: integration gate reports.
      'workspace.gate.reported'
    ));
END
$$;
