-- WHY a worker's probe failed, and a governed trail for fleet retirement.
--
-- 1. `workers.last_probe_error_class`. The prober wrote `unhealthy/failed` and threw the
--    reason away, so a provider with no credential configured read exactly like a provider
--    that was down, and nothing could say how much of the fleet was blocked by a deployment
--    gap versus an outage. The column holds a CLOSED class derived by
--    `classifyProbeFailure` — never the raw error text, which may be a gateway's own and may
--    embed a header or a URL. NULL = the current evidence is not a failure.
--    A second CHECK ties it to the evidence it explains: a class may accompany a `failed`
--    probe or the `stale` expiry of one, never `ok`/`unsupported`/`never`.
--
-- 2. `audit_event_type_check` is widened with `worker.fleet.retired` and
--    `worker.fleet.reinstated`: the compute fleet reconciler now takes a model the provider
--    no longer lists out of rotation (and puts it back when it is listed again), and every
--    such write is audited. The list below is the UNION of 0052's list and the two new
--    events, never a rewrite.
--
-- DATA SAFETY. Purely additive: one nullable column (no default, no rewrite of existing
-- rows, every existing row is NULL and satisfies both new CHECKs) and a strictly wider
-- audit CHECK (every row valid before is valid after). No row is modified. Idempotent.
--
-- ROLLBACK (forward-only in this repository; run by hand if ever needed, after confirming
-- no audit row uses the two new events — delete or keep them under a wider check first):
--   ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_last_probe_error_class_outcome_check;
--   ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_last_probe_error_class_check;
--   ALTER TABLE workers DROP COLUMN IF EXISTS last_probe_error_class;
--   then re-create audit_event_type_check with exactly 0052_tool_gateway's list.
-- Dropping the column loses only failure classes, which the next probe sweep re-derives.
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_probe_error_class text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workers_last_probe_error_class_check'
  ) THEN
    ALTER TABLE workers ADD CONSTRAINT workers_last_probe_error_class_check
      CHECK (last_probe_error_class IS NULL OR last_probe_error_class IN
        ('NOT_CONFIGURED','AUTH_FAILURE','RATE_LIMITED','UNAVAILABLE','UNKNOWN'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workers_last_probe_error_class_outcome_check'
  ) THEN
    ALTER TABLE workers ADD CONSTRAINT workers_last_probe_error_class_outcome_check
      CHECK (last_probe_error_class IS NULL OR last_probe_outcome IN ('failed','stale'));
  END IF;
END
$$;

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
      -- 0049_control_plane (decision 0058): kept — this list is the UNION, never a rewrite.
      'control.command.rejected','control.command.admitted','control.command.executed',
      'control.command.failed',
      -- 0052: Tool Gateway (decisions 0058, 0059).
      'tool.execution.recorded','tool.approval.requested','tool.approval.decided',
      'tool.approval.consumed','tool.grant.changed','tool.request.denied',
      -- 0062: governed compute fleet retirement.
      'worker.fleet.retired','worker.fleet.reinstated'
    ));
END
$$;
