-- 0053_proactive_supervisor
--
-- Proactive Supervisor foundation (decision 0060).
--
-- WHY THIS EXISTS
-- ICOS only acted when prompted. This adds the durable state that lets it NOTICE:
--   supervisor_events         append-only ledger: every observation + the decision taken on it
--   supervisor_situations     one row per incident/opportunity; repeated events aggregate here
--   supervisor_goal_proposals at most ONE proposal per situation (UNIQUE), handed to CORE3
--   supervisor_attention      at most ONE interruption per (situation, attention class)
-- and one scheduler job kind, `supervisor_observe`, for recurring observations. The
-- supervisor has no scheduler of its own: `scheduled_jobs` (ADR-0025) is the only one.
--
-- TENANT
-- `tenant_id` is NOT NULL on every table and part of every uniqueness key. ICOS is
-- single-tenant today (CURRENT_SINGLE_TENANT_ID); `client_scope` isolates clients inside
-- a tenant and is part of the situation fingerprint. RLS is not enabled, consistent with
-- every other ICOS table until COMPLIANCE-1 lands a TenantContext; access is only through
-- the supervisor store, never direct agent SQL.
--
-- DATA SAFETY
-- Additive only: four new tables, no existing column touched, no row read or rewritten.
-- The scheduled_jobs kind CHECK is only WIDENED, so no existing row can fail it.
-- Guarded and idempotent: re-running is a no-op.
--
-- ROLLBACK
--   DELETE FROM scheduled_jobs WHERE kind = 'supervisor_observe';
--   ALTER TABLE scheduled_jobs DROP CONSTRAINT IF EXISTS scheduled_jobs_kind_check;
--   ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_kind_check
--     CHECK (kind IN ('start_mission','wake_mission','probe_workers'));
--   DROP TABLE IF EXISTS supervisor_attention, supervisor_goal_proposals,
--     supervisor_events, supervisor_situations;
-- Rolling back loses supervisor history only. Goals already submitted to CORE3 stay in
-- `goals` (they carry their proposal id in metadata); no mission/task/dispatch state is
-- affected.

CREATE TABLE IF NOT EXISTS supervisor_situations (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  client_scope text,
  project_scope text,
  fingerprint text NOT NULL,
  domain text NOT NULL,
  event_type text NOT NULL,
  subject text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('problem','opportunity','information')),
  state text NOT NULL CHECK (state IN ('open','resolved','dismissed')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  event_count integer NOT NULL CHECK (event_count >= 1),
  max_attention text CHECK (max_attention IN ('INFO','ACTIONABLE','URGENT','CRITICAL')),
  source_event_id text NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  closed_at timestamptz,
  closed_by text,
  resolution text,
  CHECK ((state = 'open') = (closed_at IS NULL))
);
-- One OPEN situation per fingerprint: 100 identical alerts are one incident.
CREATE UNIQUE INDEX IF NOT EXISTS supervisor_situations_open_fingerprint_unique
  ON supervisor_situations (tenant_id, fingerprint) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS supervisor_situations_terminal_idx
  ON supervisor_situations (tenant_id, fingerprint, closed_at DESC) WHERE state <> 'open';
CREATE INDEX IF NOT EXISTS supervisor_situations_flood_idx
  ON supervisor_situations (tenant_id, domain, first_seen_at);
CREATE INDEX IF NOT EXISTS supervisor_situations_digest_idx
  ON supervisor_situations (tenant_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS supervisor_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  source text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('push','poll','internal','scheduled')),
  event_type text NOT NULL,
  subject text NOT NULL,
  occurred_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  payload_ref text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key text NOT NULL,
  correlation_id text,
  project_scope text,
  client_scope text,
  sensitivity text NOT NULL CHECK (sensitivity IN ('public','internal','confidential','restricted')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  fingerprint text,
  situation_id text REFERENCES supervisor_situations(id) ON DELETE RESTRICT,
  disposition text NOT NULL CHECK (disposition IN
    ('IGNORE','RECORD_ONLY','NOTIFY','PROPOSE_ACTION','CREATE_BOUNDED_GOAL','ESCALATE_HUMAN')),
  initiative_level text NOT NULL,
  policy_version text NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}',
  -- A replayed observation is the SAME event: deduplicated at the database boundary.
  CONSTRAINT supervisor_events_dedup_unique UNIQUE (tenant_id, source, dedup_key)
);
CREATE INDEX IF NOT EXISTS supervisor_events_situation_idx ON supervisor_events (situation_id);
CREATE INDEX IF NOT EXISTS supervisor_events_digest_idx ON supervisor_events (tenant_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS supervisor_goal_proposals (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  situation_id text NOT NULL REFERENCES supervisor_situations(id) ON DELETE RESTRICT,
  source_event_id text NOT NULL,
  domain text NOT NULL,
  action text NOT NULL,
  route text NOT NULL CHECK (route IN ('goal','tool_action')),
  disposition text NOT NULL CHECK (disposition IN ('PROPOSE_ACTION','CREATE_BOUNDED_GOAL','ESCALATE_HUMAN')),
  initiative_level text NOT NULL,
  risk text NOT NULL CHECK (risk IN ('read_only','reversible','sensitive')),
  -- Only a bounded goal is ever submitted automatically; the rest wait for a human
  -- (or are cancelled when their situation closes). Delivery is an outbox: claimed
  -- with a lease, retried up to a bound, then `failed` — never retried forever.
  state text NOT NULL CHECK (state IN ('pending','delivering','awaiting_human','submitted',
    'not_connected','denied','failed','cancelled')),
  CHECK (disposition = 'CREATE_BOUNDED_GOAL' OR state IN ('awaiting_human','cancelled')),
  CHECK ((state = 'delivering') = (claimed_until IS NOT NULL)),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  claimed_until timestamptz,
  CHECK (disposition <> 'CREATE_BOUNDED_GOAL' OR risk <> 'sensitive'),
  proposal jsonb NOT NULL,
  external_ref text,
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  CONSTRAINT supervisor_goal_proposals_situation_unique UNIQUE (situation_id)
);
CREATE INDEX IF NOT EXISTS supervisor_goal_proposals_budget_idx
  ON supervisor_goal_proposals (tenant_id, domain, action, created_at)
  WHERE disposition = 'CREATE_BOUNDED_GOAL';
CREATE INDEX IF NOT EXISTS supervisor_goal_proposals_pending_idx
  ON supervisor_goal_proposals (created_at) WHERE state IN ('pending','delivering');

CREATE TABLE IF NOT EXISTS supervisor_attention (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  situation_id text NOT NULL REFERENCES supervisor_situations(id) ON DELETE RESTRICT,
  attention_class text NOT NULL CHECK (attention_class IN ('INFO','ACTIONABLE','URGENT','CRITICAL')),
  channels text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('pending','delivering','delivered','not_connected',
    'denied','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  claimed_until timestamptz,
  CHECK ((state = 'delivering') = (claimed_until IS NOT NULL)),
  created_at timestamptz NOT NULL,
  settled_at timestamptz,
  CONSTRAINT supervisor_attention_once_unique UNIQUE (situation_id, attention_class)
);
CREATE INDEX IF NOT EXISTS supervisor_attention_pending_idx
  ON supervisor_attention (created_at) WHERE state IN ('pending','delivering');

-- The event ledger is evidence: append-only, like audit_entries (0001).
CREATE OR REPLACE FUNCTION supervisor_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'supervisor_events est append-only : % interdit', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS supervisor_events_append_only ON supervisor_events;
CREATE TRIGGER supervisor_events_append_only BEFORE UPDATE OR DELETE ON supervisor_events
  FOR EACH ROW EXECUTE FUNCTION supervisor_events_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_kind_check') THEN
    ALTER TABLE scheduled_jobs DROP CONSTRAINT scheduled_jobs_kind_check;
  END IF;

  ALTER TABLE scheduled_jobs ADD CONSTRAINT scheduled_jobs_kind_check
    CHECK (kind IN ('start_mission','wake_mission','probe_workers','supervisor_observe'));
END
$$;
