-- 0049_control_plane
--
-- Canonical control plane (decision 0055 — authored as 0044; cockpit BR-10, BR-11, BR-12, BR-18).
--
-- WHAT THIS ADDS (all ADDITIVE, all IF NOT EXISTS):
--   control_commands          one row per control attempt that passed authentication:
--                             durable result, replayed on duplicate requests
--   control_state_versions    monotonic control version per target (optimistic concurrency)
--   runtime_control_flags     ONE row ('global'): safe_mode + dispatch/integration/external
--   mission_control_holds     durable PAUSE (MissionStatus is deliberately not changed)
--   control_reauth_proofs     SHA-256 of single-use, 5-minute re-authentication proofs
--   audit_event_type_check    extended with control.command.{rejected,admitted,executed,failed}
--
-- NUMBERING: authored as 0047 on feat/control-foundation; renumbered to 0048 when integrated on top of
-- CORE3, whose 0047_audit_goal_events is canonical and runs FIRST (owner decision, 2026-09-28); renumbered
-- again to 0049 at central integration (2026-09-30) because CORE3 shipped 0048_compute_routing_evidence,
-- which runs before this file and touches only dispatch_attempts (no shared CHECK).
--
-- DATA SAFETY
--   No existing row is modified. The audit CHECK is replaced by a strict SUPERSET of the list
--   enforced after 0047_audit_goal_events (the 37 historical values + the 4 goal.* values), plus the
--   4 control.command.* values. It is WIDENED, never narrowed, so every existing row — including the
--   goal.* rows 0047 made possible — still satisfies it.
--   The flags row is seeded to normal operation (no safe mode, everything enabled): a
--   deployment of this migration changes no runtime behaviour until a command is issued.
--   If the flags row is ever missing, the runtime reads that as "everything off" (fail closed).
--
-- ROLLBACK (manual, after pg_dump):
--   DROP TABLE control_reauth_proofs, mission_control_holds, runtime_control_flags,
--              control_state_versions, control_commands;
--   and restore audit_event_type_check to the 0047_audit_goal_events list (this list minus the four
--   control.* values) — only possible once no control.* audit row exists; audit is append-only, so in
--   practice keep the wider constraint. NEVER restore a list without the goal.* values: that would
--   re-break goal creation (the defect 0047 fixed).

CREATE TABLE IF NOT EXISTS "control_commands" (
  "command_id" uuid PRIMARY KEY NOT NULL,
  "actor_user_id" text NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "command_type" text NOT NULL,
  "target_kind" text NOT NULL,
  "target_id" text NOT NULL,
  "risk_class" text NOT NULL,
  "reason" text NOT NULL,
  "expected_version" integer NOT NULL,
  "status" text NOT NULL,
  "reauth" text NOT NULL,
  "rejection_code" text,
  "rejection_message" text,
  "version" integer,
  "audit_entry_id" text,
  "created_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "control_commands_actor_key_unique" UNIQUE ("actor_user_id", "idempotency_key"),
  CONSTRAINT "control_commands_type_check" CHECK ("command_type" IN
    ('PAUSE_MISSION','RESUME_MISSION','CANCEL_MISSION','DISABLE_WORKER','ENABLE_WORKER','ENTER_SAFE_MODE','EXIT_SAFE_MODE')),
  CONSTRAINT "control_commands_target_kind_check" CHECK ("target_kind" IN ('mission','worker','runtime')),
  CONSTRAINT "control_commands_risk_check" CHECK ("risk_class" IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  CONSTRAINT "control_commands_status_check" CHECK ("status" IN ('ADMITTED','EXECUTED','REJECTED','FAILED')),
  CONSTRAINT "control_commands_reauth_check" CHECK ("reauth" IN ('NOT_REQUIRED','SATISFIED','REQUIRED','INVALID','EXPIRED'))
);
CREATE INDEX IF NOT EXISTS "control_commands_target_idx" ON "control_commands" ("target_kind", "target_id");
CREATE INDEX IF NOT EXISTS "control_commands_admitted_idx" ON "control_commands" ("created_at") WHERE "status" = 'ADMITTED';

CREATE TABLE IF NOT EXISTS "control_state_versions" (
  "target_kind" text NOT NULL,
  "target_id" text NOT NULL,
  "version" integer NOT NULL DEFAULT 0,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "control_state_versions_pk" PRIMARY KEY ("target_kind", "target_id"),
  CONSTRAINT "control_state_versions_kind_check" CHECK ("target_kind" IN ('mission','worker','runtime')),
  CONSTRAINT "control_state_versions_version_check" CHECK ("version" >= 0)
);

CREATE TABLE IF NOT EXISTS "runtime_control_flags" (
  "id" text PRIMARY KEY NOT NULL,
  "safe_mode" boolean NOT NULL,
  "dispatch_enabled" boolean NOT NULL,
  "integration_enabled" boolean NOT NULL,
  "external_actions_enabled" boolean NOT NULL,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_by_command_id" uuid,
  CONSTRAINT "runtime_control_flags_singleton" CHECK ("id" = 'global')
);
INSERT INTO "runtime_control_flags" ("id", "safe_mode", "dispatch_enabled", "integration_enabled", "external_actions_enabled")
VALUES ('global', false, true, true, true)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "mission_control_holds" (
  "mission_id" text PRIMARY KEY NOT NULL REFERENCES "missions"("id") ON DELETE CASCADE,
  "held_by_command_id" uuid NOT NULL,
  "held_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "control_reauth_proofs" (
  "id" uuid PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "session_id" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  CONSTRAINT "control_reauth_proofs_token_hash_unique" UNIQUE ("token_hash"),
  CONSTRAINT "control_reauth_proofs_ttl_check" CHECK ("expires_at" > "created_at")
);

ALTER TABLE "audit_entries" DROP CONSTRAINT IF EXISTS "audit_event_type_check";
ALTER TABLE "audit_entries" ADD CONSTRAINT "audit_event_type_check" CHECK ("event_type" IN (
  'task.created','task.transitioned','task.execution.dispatched','task.execution.started','task.execution.completed',
  'approval.recorded','action.decided','user.created','role.changed',
  'auth.bootstrap.succeeded','auth.bootstrap.failed','auth.login.succeeded','auth.login.rejected',
  'auth.logout.succeeded','auth.access.denied',
  'human_user.created','human_user.role_changed','human_user.enabled','human_user.disabled',
  'human_agent_link.created','human_agent_link.removed','human_user.administration_denied',
  'capability.created','capability.updated','capability.status_changed',
  'agent_capability.granted','agent_capability.revoked',
  'skill.created','skill.imported','skill.content_changed','skill.trust_changed','skill.activation_changed',
  'skill.security_scan_recorded','skill.eval_recorded',
  'mission.created','mission.transitioned','mission.task.dispatched',
  -- 0047_audit_goal_events (CORE3 M12): preserved.
  'goal.created','goal.status_updated','goal.converted','goal.idempotency_key_set',
  -- 0048 (decision 0044): control plane.
  'control.command.rejected','control.command.admitted','control.command.executed','control.command.failed'
));
