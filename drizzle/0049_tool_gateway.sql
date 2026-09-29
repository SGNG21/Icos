-- 0049_tool_gateway
--
-- Governed Tool Gateway (decision 0055).
--
-- WHY THIS EXISTS
-- 1. `tool_executions` is the durable evidence of every tool request and the idempotency
--    ledger: UNIQUE (tenant_id, idempotency_key) makes a duplicate side effect impossible to
--    even claim, and `version` is the compare-and-set that lets exactly one runner dispatch.
-- 2. `tool_approval_requests` binds a human (or, for MEDIUM and below, policy-allowed agent)
--    decision to ONE request fingerprint, with an expiry. HIGH/CRITICAL rows can only carry a
--    human decision (CHECK), whatever the application does.
-- 3. `tool_grants` is the explicit per-(tenant, agent, tool, action) permission. No wildcard.
-- 4. `audit_event_type_check` is widened with the four `tool.*` events written in the SAME
--    transaction as each state change above.
--
-- TENANT / DATA SAFETY
-- tenant_id is NOT NULL (and non-empty) on every table and part of every unique key; every
-- store query filters on it. No column holds a secret or a raw third-party payload:
-- `result_summary` is a bounded (8 KiB) digest. Additive only: three new tables, and a CHECK
-- that is only WIDENED (every value admitted before is still admitted). Guarded, idempotent.
--
-- ROLLBACK
--   DELETE FROM audit_entries WHERE event_type LIKE 'tool.%';   -- audit is append-only:
--     (disable the append-only trigger for this statement if present, as for 0047)
--   re-run the DO block of 0047 (restores the narrower CHECK), then
--   DROP TABLE IF EXISTS tool_approval_requests, tool_grants, tool_executions;
--   Rolling back loses tool evidence and grants; it touches no mission, task or action row.

CREATE TABLE IF NOT EXISTS tool_executions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  tool_id text NOT NULL,
  tool_version text NOT NULL,
  action text NOT NULL,
  connector_instance_id text NOT NULL,
  requester_agent_id text NOT NULL,
  mission_id text,
  task_id text,
  risk_class text NOT NULL,
  side_effects text NOT NULL,
  status text NOT NULL,
  settlement_state text NOT NULL,
  approval_request_id text,
  attempt_count integer NOT NULL,
  provider_operation_id text,
  failure_class text,
  failure_message text,
  result_summary jsonb,
  result_reference text,
  audit_references jsonb NOT NULL,
  version integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT tool_executions_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT tool_executions_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_executions_action_check CHECK (action IN ('READ','SEARCH','CREATE','WRITE','UPDATE','SEND','PUBLISH','DEPLOY','DELETE','EXECUTE','PURCHASE','PAY','GRANT_ACCESS','REVOKE_ACCESS','CONFIGURE','MERGE')),
  CONSTRAINT tool_executions_risk_check CHECK (risk_class IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT tool_executions_side_effects_check CHECK (side_effects IN ('none','internal','external')),
  CONSTRAINT tool_executions_status_check CHECK (status IN ('REQUESTED','AWAITING_APPROVAL','DENIED','REJECTED','EXECUTING','SUCCEEDED','FAILED')),
  CONSTRAINT tool_executions_settlement_check CHECK (settlement_state IN ('NOT_STARTED','DISPATCHED','APPLIED','NOT_APPLIED','UNKNOWN')),
  CONSTRAINT tool_executions_failure_class_check CHECK (failure_class IS NULL OR failure_class IN ('AUTH_FAILURE','PERMISSION_DENIED','RATE_LIMIT','PROVIDER_UNAVAILABLE','NETWORK_ERROR','TIMEOUT','INVALID_INPUT','CONFLICT','NOT_FOUND','IDEMPOTENCY_CONFLICT','POLICY_DENIED','APPROVAL_REQUIRED','APPROVAL_REJECTED','APPROVAL_EXPIRED','SETTLEMENT_UNKNOWN','NOT_CONNECTED','UNKNOWN')),
  CONSTRAINT tool_executions_fingerprint_check CHECK (request_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_executions_success_settlement_check CHECK ((status = 'SUCCEEDED') = (settlement_state = 'APPLIED')),
  CONSTRAINT tool_executions_counters_check CHECK (attempt_count >= 0 AND version >= 0),
  CONSTRAINT tool_executions_summary_size_check CHECK (result_summary IS NULL OR octet_length(result_summary::text) <= 8192)
);
CREATE INDEX IF NOT EXISTS tool_executions_tenant_status_idx ON tool_executions (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS tool_executions_tenant_settlement_idx ON tool_executions (tenant_id, settlement_state);

CREATE TABLE IF NOT EXISTS tool_approval_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  tool_execution_id text NOT NULL REFERENCES tool_executions(id) ON DELETE RESTRICT,
  request_fingerprint text NOT NULL,
  requester_agent_id text NOT NULL,
  tool_id text NOT NULL,
  action text NOT NULL,
  risk_class text NOT NULL,
  status text NOT NULL,
  decided_by_kind text,
  decided_by_id text,
  reason text,
  requested_at timestamp with time zone NOT NULL,
  decided_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT tool_approval_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_approval_status_check CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  CONSTRAINT tool_approval_action_check CHECK (action IN ('READ','SEARCH','CREATE','WRITE','UPDATE','SEND','PUBLISH','DEPLOY','DELETE','EXECUTE','PURCHASE','PAY','GRANT_ACCESS','REVOKE_ACCESS','CONFIGURE','MERGE')),
  CONSTRAINT tool_approval_risk_check CHECK (risk_class IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT tool_approval_decided_check CHECK ((status = 'PENDING') = (decided_at IS NULL AND decided_by_id IS NULL)),
  CONSTRAINT tool_approval_decider_kind_check CHECK (decided_by_kind IS NULL OR decided_by_kind IN ('human','agent')),
  CONSTRAINT tool_approval_human_for_high_check CHECK (risk_class NOT IN ('HIGH','CRITICAL') OR decided_by_kind IS NULL OR decided_by_kind = 'human'),
  CONSTRAINT tool_approval_reject_reason_check CHECK (status <> 'REJECTED' OR length(coalesce(reason, '')) > 0)
);
CREATE INDEX IF NOT EXISTS tool_approval_tenant_status_idx ON tool_approval_requests (tenant_id, status);

CREATE TABLE IF NOT EXISTS tool_grants (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  tool_id text NOT NULL,
  action text NOT NULL,
  granted_by text NOT NULL,
  granted_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone,
  CONSTRAINT tool_grants_pk PRIMARY KEY (tenant_id, agent_id, tool_id, action),
  CONSTRAINT tool_grants_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_grants_action_check CHECK (action IN ('READ','SEARCH','CREATE','WRITE','UPDATE','SEND','PUBLISH','DEPLOY','DELETE','EXECUTE','PURCHASE','PAY','GRANT_ACCESS','REVOKE_ACCESS','CONFIGURE','MERGE'))
);

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
      -- 0049: Tool Gateway (decision 0055).
      'tool.execution.recorded','tool.approval.requested','tool.approval.decided','tool.grant.changed'
    ));
END
$$;
