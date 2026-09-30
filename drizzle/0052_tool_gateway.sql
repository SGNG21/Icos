-- 0052_tool_gateway
--
-- Governed Tool Gateway (decisions 0058, 0059).
--
-- NUMBERING: this migration was written on feat/tool-gateway-connectors against a journal that
-- ended at 0048. The integration lane may renumber it (see
-- docs/icos/tool-gateway-migration-manifest.md); its content is order-independent except for
-- the audit CHECK at the end, which must be MERGED with any other lane's list, never replaced.
--
-- WHY THIS EXISTS
-- 1. `tool_executions` is the durable evidence of every tool request and the idempotency
--    ledger: UNIQUE (tenant_id, idempotency_key) makes a duplicate side effect impossible to
--    even claim, and `version` is the compare-and-set that lets exactly one runner dispatch.
--    `operation_fingerprint` (+ index) finds the SAME operation under a DIFFERENT key, for the
--    per-action duplicate policy.
-- 2. `tool_approval_requests` binds a human (or, for MEDIUM and below, policy-allowed agent)
--    decision to ONE request fingerprint (tenant, requester, tool, action, instance, input), with
--    an expiry, the secret-screened input the approver decides on, and single-use consumption.
--    HIGH/CRITICAL rows can only carry a human decision (CHECK). Its FK to the execution is
--    tenant-composite: an approval can never point at another tenant's execution.
-- 3. `tool_grants` is the explicit per-(tenant, agent, tool, action) permission, with the grantor,
--    a mandatory reason, and soft revocation (who, when, why) kept as evidence.
-- 4. `tool_connector_health` is dated, expirable health evidence: a restart reads it, and stale
--    or missing evidence reads UNKNOWN (never an assumed HEALTHY).
-- 5. `audit_event_type_check` is widened with the six `tool.*` events.
--
-- TENANT / DATA SAFETY
-- tenant_id is NOT NULL (and non-empty) on every table and part of every unique key; every
-- store query filters on it. No column holds a secret or a raw third-party payload:
-- `result_summary` is a bounded (8 KiB) digest, `input_preview` a bounded (16 KiB) copy of the
-- secret-screened approval input. Additive only: four new tables, and a CHECK that is only
-- WIDENED (every value admitted before is still admitted). Guarded, idempotent.
--
-- ROLLBACK (never deletes audit rows: audit_entries is append-only evidence)
--   Keep the widened CHECK (harmless once nothing writes tool.* events), or re-add the 0047
--   list as `... CHECK (...) NOT VALID` so existing tool.* audit rows are preserved; then
--     DROP TABLE IF EXISTS tool_approval_requests, tool_grants, tool_connector_health,
--       tool_executions;
--   Rolling back loses tool evidence rows, grants and health evidence (export them first if
--   needed); it touches no mission, task, action or audit row.

CREATE TABLE IF NOT EXISTS tool_executions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  operation_fingerprint text NOT NULL,
  duplicate_of text,
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
  result_trust text,
  audit_references jsonb NOT NULL,
  version integer NOT NULL,
  created_at timestamp with time zone NOT NULL,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  updated_at timestamp with time zone NOT NULL,
  CONSTRAINT tool_executions_tenant_key_unique UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT tool_executions_tenant_id_unique UNIQUE (tenant_id, id),
  CONSTRAINT tool_executions_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_executions_action_check CHECK (action IN ('READ','SEARCH','CREATE','WRITE','UPDATE','SEND','PUBLISH','DEPLOY','DELETE','EXECUTE','PURCHASE','PAY','GRANT_ACCESS','REVOKE_ACCESS','CONFIGURE','MERGE')),
  CONSTRAINT tool_executions_risk_check CHECK (risk_class IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT tool_executions_side_effects_check CHECK (side_effects IN ('none','internal','external')),
  CONSTRAINT tool_executions_status_check CHECK (status IN ('REQUESTED','AWAITING_APPROVAL','DENIED','REJECTED','EXECUTING','SUCCEEDED','FAILED')),
  CONSTRAINT tool_executions_settlement_check CHECK (settlement_state IN ('NOT_STARTED','DISPATCHED','APPLIED','NOT_APPLIED','UNKNOWN')),
  CONSTRAINT tool_executions_failure_class_check CHECK (failure_class IS NULL OR failure_class IN ('AUTH_FAILURE','PERMISSION_DENIED','RATE_LIMIT','PROVIDER_UNAVAILABLE','NETWORK_ERROR','TIMEOUT','INVALID_INPUT','CONFLICT','NOT_FOUND','IDEMPOTENCY_CONFLICT','POLICY_DENIED','APPROVAL_REQUIRED','APPROVAL_REJECTED','APPROVAL_EXPIRED','SETTLEMENT_UNKNOWN','NOT_CONNECTED','DUPLICATE_OPERATION','UNKNOWN')),
  CONSTRAINT tool_executions_fingerprint_check CHECK (request_fingerprint ~ '^[a-f0-9]{64}$' AND operation_fingerprint ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tool_executions_result_trust_check CHECK (result_trust IS NULL OR result_trust = 'UNTRUSTED_EXTERNAL_DATA'),
  CONSTRAINT tool_executions_success_settlement_check CHECK ((status = 'SUCCEEDED') = (settlement_state = 'APPLIED')),
  CONSTRAINT tool_executions_counters_check CHECK (attempt_count >= 0 AND version >= 0),
  CONSTRAINT tool_executions_summary_size_check CHECK (result_summary IS NULL OR octet_length(result_summary::text) <= 8192)
);
CREATE INDEX IF NOT EXISTS tool_executions_tenant_status_idx ON tool_executions (tenant_id, status, updated_at);
CREATE INDEX IF NOT EXISTS tool_executions_tenant_settlement_idx ON tool_executions (tenant_id, settlement_state);
CREATE INDEX IF NOT EXISTS tool_executions_tenant_operation_idx ON tool_executions (tenant_id, operation_fingerprint, created_at);

CREATE TABLE IF NOT EXISTS tool_approval_requests (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  tool_execution_id text NOT NULL,
  request_fingerprint text NOT NULL,
  requester_agent_id text NOT NULL,
  tool_id text NOT NULL,
  action text NOT NULL,
  risk_class text NOT NULL,
  input_preview jsonb NOT NULL,
  status text NOT NULL,
  decided_by_kind text,
  decided_by_id text,
  reason text,
  duplicate_of text,
  consumed_at timestamp with time zone,
  requested_at timestamp with time zone NOT NULL,
  decided_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT tool_approval_execution_fk FOREIGN KEY (tenant_id, tool_execution_id)
    REFERENCES tool_executions (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT tool_approval_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_approval_consumed_check CHECK (consumed_at IS NULL OR status = 'APPROVED'),
  CONSTRAINT tool_approval_preview_size_check CHECK (octet_length(input_preview::text) <= 16384),
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
  reason text NOT NULL,
  revoked_at timestamp with time zone,
  revoked_by text,
  revoke_reason text,
  CONSTRAINT tool_grants_pk PRIMARY KEY (tenant_id, agent_id, tool_id, action),
  CONSTRAINT tool_grants_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_grants_action_check CHECK (action IN ('READ','SEARCH','CREATE','WRITE','UPDATE','SEND','PUBLISH','DEPLOY','DELETE','EXECUTE','PURCHASE','PAY','GRANT_ACCESS','REVOKE_ACCESS','CONFIGURE','MERGE')),
  CONSTRAINT tool_grants_reason_check CHECK (length(reason) > 0),
  CONSTRAINT tool_grants_revocation_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);

CREATE TABLE IF NOT EXISTS tool_connector_health (
  tenant_id text NOT NULL,
  instance_id text NOT NULL,
  status text NOT NULL,
  checked_at timestamp with time zone NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  rate_limited_until timestamp with time zone,
  detail text,
  CONSTRAINT tool_connector_health_pk PRIMARY KEY (tenant_id, instance_id),
  CONSTRAINT tool_connector_health_tenant_check CHECK (length(tenant_id) > 0),
  CONSTRAINT tool_connector_health_status_check CHECK (status IN ('REGISTERED','CONFIGURED','HEALTHY','DEGRADED','RATE_LIMITED','AUTH_FAILED','DISABLED','UNKNOWN'))
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
      -- 0049_control_plane (decision 0058): kept — this list is the UNION, never a rewrite.
      'control.command.rejected','control.command.admitted','control.command.executed',
      'control.command.failed',
      -- 0052: Tool Gateway (decisions 0058, 0059).
      'tool.execution.recorded','tool.approval.requested','tool.approval.decided',
      'tool.approval.consumed','tool.grant.changed','tool.request.denied'
    ));
END
$$;
