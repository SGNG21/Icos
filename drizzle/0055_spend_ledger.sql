-- 0055_spend_ledger
--
-- DURABLE SPEND LEDGER (autonomy blocker B1).
--
-- WHY THIS EXISTS
-- The spend meter (`src/server/budget/`) shipped with an in-memory ledger only, so EVERY
-- restart forgot every euro and every token already spent. A crash-loop could therefore spend
-- without any bound while the system still claimed an enforced budget. This table is the
-- durable accumulator: one immutable row per observed provider call, and the spend window is
-- obtained by READING those rows back — never by trusting a running total held in a process.
--
-- AN ABSENCE IS NEVER A ZERO
-- The row SHAPE carries the distinction, not application convention:
--   * usage_kind = 'UNMETERED'  -> prompt/completion/total_tokens are NULL and
--                                 unmetered_reason is NOT NULL. A call whose consumption
--                                 could not be read can never be read back as 0 tokens.
--   * cost_kind  = 'UNPRICED'   -> amount IS NULL and unpriced_reason is NOT NULL. A model
--                                 absent from the price table is not a free call.
--   * cost_kind  = 'COST'       -> amount and currency are NOT NULL.
-- A genuinely metered zero (0 prompt + 0 completion tokens) is usage_kind = 'METERED' with
-- three zeros, which stays distinguishable from NULL for the lifetime of the row.
-- `spend_ledger_usage_shape` and `spend_ledger_cost_shape` make every other combination
-- unrepresentable, so no writer — present or future — can launder an unknown into a zero.
--
-- TENANT
-- TENANT KEY: `tenant_id`, NOT NULL, non-empty, and the FIRST column of the only read index.
-- It is a mandatory predicate of every query in `postgres-spend-ledger.ts`; the ledger refuses
-- to be constructed without a tenant id, so no tenant-less write or read is reachable.
-- RLS STRATEGY: RLS is NOT enabled — consistent with every other ICOS table (see the TENANT
-- headers of `workforce-schema.ts`, `tool-gateway-schema.ts` and 0053_proactive_supervisor.sql).
-- ICOS is single-tenant today (`CURRENT_SINGLE_TENANT_ID`); isolation is enforced in the
-- service layer and will move to RLS with the TenantContext of COMPLIANCE-1. This migration
-- deliberately does NOT invent a different approach for one table: a lone RLS policy here
-- would be the only one in the database and would read as protection that does not exist
-- anywhere else. Access is only through the ledger, never direct agent SQL.
--
-- NOTE: `goals` itself carries no tenant_id in this schema, so a goal cap is resolved by
-- goal id alone (`goal-budget-cap-resolver.ts`). That is a pre-existing property of `goals`,
-- recorded here as a finding; this migration does not change any existing table.
--
-- CONCURRENCY
-- No reservation row and no lock. `checkBudget()` is a pre-flight read and `record()` happens
-- after the provider answers, so concurrent callers can all pass the check before any of them
-- records. That gap is BOUNDED AND DOCUMENTED rather than closed, because the consumption of
-- the call about to be made is unknown before the provider answers: there is no honest amount
-- to reserve, and reserving an invented estimate would enforce a fabricated ceiling. The exact
-- bound, and why option (b) was rejected, are in the header of `postgres-spend-ledger.ts`.
-- What the table must therefore guarantee is that no process ever answers from a stale cache:
-- hence append-only rows plus a read on every check.
--
-- APPEND-ONLY
-- The ledger is evidence, like audit_entries (0001) and supervisor_events (0053): UPDATE and
-- DELETE are refused by trigger with ERRCODE 42501 (insufficient_privilege). A recorded
-- observation can never be rewritten or erased, so spend history cannot be quietly reduced.
-- TRUNCATE is not covered by a row-level trigger, which keeps the test helpers usable.
--
-- DATA SAFETY (forward)
-- Additive only: ONE new table, one index, one function, one trigger. No existing table,
-- column, constraint or row is read, rewritten or dropped. The forward migration is therefore
-- safe on a NON-EMPTY database: nothing can fail on existing data because no existing data is
-- touched, and every statement is guarded (`IF NOT EXISTS` / `CREATE OR REPLACE` /
-- `DROP TRIGGER IF EXISTS`), so re-running the migration is a no-op.
--
-- ROLLBACK
--   DROP TRIGGER IF EXISTS spend_ledger_append_only ON spend_ledger;
--   DROP FUNCTION IF EXISTS spend_ledger_append_only();
--   DROP TABLE IF EXISTS spend_ledger;
-- Order matters only in that the trigger and function must go before the table is dropped if
-- the table is kept; dropping the table removes its trigger with it. Rolling back loses the
-- whole spend history and nothing else: no other table references spend_ledger, and
-- spend_ledger references no other table (attribution ids are recorded as plain text,
-- deliberately NOT as foreign keys — a spend observation is evidence that must survive the
-- deletion of the goal or mission it was imputed to). The cost of a rollback is therefore
-- exactly the loss this migration exists to prevent: after it, the meter forgets spend again
-- and no budget is enforceable. There is no data migration to undo.
--
-- NUMBERING
-- 0055 is the first free prefix observed on this branch (0054_client_context is the journal
-- tail, idx 51). Parallel lanes in this repository have silently collided on migration numbers
-- before (differing filenames merge with no git conflict), so this number MUST be re-checked
-- at integration time and renumbered if another lane also claimed 0055.

CREATE TABLE IF NOT EXISTS spend_ledger (
  id text PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) > 0),
  -- `attributionKey()` of core/budget/contracts: the accumulation key. 'UNATTRIBUTED' for an
  -- unattributed call — recorded as such, never given an invented imputation.
  attribution_key text NOT NULL CHECK (length(attribution_key) > 0),
  -- The attribution as REPORTED, field by field, for reporting. Plain text on purpose: no FK.
  mission_id text,
  goal_id text,
  brain_id text,
  -- The model the provider says actually ran, so the one that bills.
  model_id text NOT NULL CHECK (length(model_id) > 0),
  usage_kind text NOT NULL CHECK (usage_kind IN ('METERED', 'UNMETERED')),
  prompt_tokens bigint CHECK (prompt_tokens >= 0),
  completion_tokens bigint CHECK (completion_tokens >= 0),
  total_tokens bigint CHECK (total_tokens >= 0),
  unmetered_reason text,
  cost_kind text CHECK (cost_kind IN ('COST', 'UNPRICED')),
  currency text,
  amount double precision,
  unpriced_reason text,
  -- When the observation was made (the entry's own timestamp), vs when the row landed.
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_ledger_usage_shape CHECK (
    CASE usage_kind
      WHEN 'METERED' THEN prompt_tokens IS NOT NULL AND completion_tokens IS NOT NULL
        AND total_tokens IS NOT NULL AND unmetered_reason IS NULL AND cost_kind IS NOT NULL
      ELSE prompt_tokens IS NULL AND completion_tokens IS NULL AND total_tokens IS NULL
        AND unmetered_reason IS NOT NULL AND cost_kind IS NULL
    END
  ),
  CONSTRAINT spend_ledger_cost_shape CHECK (
    CASE coalesce(cost_kind, 'NONE')
      WHEN 'COST' THEN amount IS NOT NULL AND currency IS NOT NULL AND unpriced_reason IS NULL
      WHEN 'UNPRICED' THEN amount IS NULL AND unpriced_reason IS NOT NULL
      ELSE amount IS NULL AND currency IS NULL AND unpriced_reason IS NULL
    END
  )
);--> statement-breakpoint

-- The only read: the window of one imputation inside one tenant, in insertion order.
CREATE INDEX IF NOT EXISTS spend_ledger_window_idx
  ON spend_ledger (tenant_id, attribution_key, recorded_at, id);--> statement-breakpoint

-- Evidence, like audit_entries (0001) and supervisor_events (0053).
CREATE OR REPLACE FUNCTION spend_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'spend_ledger est append-only : % interdit', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS spend_ledger_append_only ON spend_ledger;--> statement-breakpoint
CREATE TRIGGER spend_ledger_append_only BEFORE UPDATE OR DELETE ON spend_ledger
  FOR EACH ROW EXECUTE FUNCTION spend_ledger_append_only();
