-- A verified free tier is a third cost word, never a zero by default (decision 0078).
--
-- WHAT CHANGES
-- `spend_ledger.cost_kind` gains 'FREE_TIER' beside 'COST' and 'UNPRICED', and the row SHAPE
-- carries the distinction, as 0055 does for the other two:
--   * cost_kind = 'FREE_TIER' -> amount IS NOT NULL AND amount = 0, currency NOT NULL,
--                                unpriced_reason NULL, free_tier_provenance non-blank and
--                                free_tier_verified_on NOT NULL. A non-zero or NULL amount on
--                                a FREE_TIER row is unrepresentable.
--   * every other cost_kind   -> both free_tier_* columns NULL.
-- The two new nullable columns hold the dated proof (source of the terms read, day of the
-- verification): for a rate the amount is the proof, for a free tier the amount (0) proves
-- nothing. Option (b) of decision 0078 (COST + amount 0 + a side column) was rejected: every
-- reader written before it would read a measured zero cost on real consumption.
--
-- DATA SAFETY
-- Adding two nullable columns without defaults is catalog-only: no row is rewritten or
-- backfilled. Every existing row has cost_kind 'COST', 'UNPRICED' or NULL (UNMETERED) and both
-- new columns NULL, so it satisfies the widened cost_kind CHECK and the new cost shape exactly
-- as it satisfied 0055's; the re-added constraints are validated against those rows and cannot
-- fail on data written under 0055/0065. No row is modified; the append-only UPDATE/DELETE
-- trigger is not fired by ALTER TABLE. CHECK validation scans the table; ALTER takes ACCESS
-- EXCLUSIVE locks for its duration, as 0065 did. One DO statement keeps the changes atomic.
-- Guards: ADD COLUMN IF NOT EXISTS, and each constraint is replaced only when its current
-- definition does not already name 'FREE_TIER', so reapplying this migration is a no-op.
--
-- ROLLBACK
-- Restore 0055's two constraints; keep both columns and every row (the ledger is evidence,
-- append-only by trigger: a FREE_TIER row cannot and must not be deleted). NOT VALID keeps any
-- FREE_TIER row already written while narrowing every new write back to 'COST'/'UNPRICED':
--   ALTER TABLE spend_ledger
--     DROP CONSTRAINT IF EXISTS spend_ledger_cost_shape,
--     DROP CONSTRAINT IF EXISTS spend_ledger_cost_kind_check;
--   ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cost_kind_check
--     CHECK (cost_kind IN ('COST', 'UNPRICED')) NOT VALID;
--   ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cost_shape CHECK (
--     CASE coalesce(cost_kind, 'NONE')
--       WHEN 'COST' THEN amount IS NOT NULL AND currency IS NOT NULL AND unpriced_reason IS NULL
--       WHEN 'UNPRICED' THEN amount IS NULL AND unpriced_reason IS NOT NULL
--       ELSE amount IS NULL AND currency IS NULL AND unpriced_reason IS NULL
--     END
--   ) NOT VALID;
-- When no FREE_TIER row exists, `ALTER TABLE spend_ledger VALIDATE CONSTRAINT …` on both
-- returns them to 0055's validated state. Code older than 0078 must not run against a table
-- holding FREE_TIER rows: its reader would fold them as COST (that is why the reader changed in
-- the same commit). Reapplying this file restores the widened constraints (validated).
--
-- TENANT
-- Tenant key `tenant_id` and the only read index are unchanged; RLS strategy unchanged
-- (applicative isolation, as for every ICOS table — see 0055).
--
-- NUMBERING
-- 0066 was free on every local branch and worktree on 2026-10-14; re-check at integration.

DO $$
BEGIN
  ALTER TABLE spend_ledger
    ADD COLUMN IF NOT EXISTS free_tier_provenance text,
    ADD COLUMN IF NOT EXISTS free_tier_verified_on date;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'spend_ledger'::regclass
       AND conname = 'spend_ledger_cost_kind_check'
       AND pg_get_constraintdef(oid) LIKE '%FREE_TIER%'
  ) THEN
    ALTER TABLE spend_ledger DROP CONSTRAINT IF EXISTS spend_ledger_cost_kind_check;
    ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cost_kind_check
      CHECK (cost_kind IN ('COST', 'UNPRICED', 'FREE_TIER'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'spend_ledger'::regclass
       AND conname = 'spend_ledger_cost_shape'
       AND pg_get_constraintdef(oid) LIKE '%FREE_TIER%'
  ) THEN
    ALTER TABLE spend_ledger DROP CONSTRAINT IF EXISTS spend_ledger_cost_shape;
    ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cost_shape CHECK (
      CASE coalesce(cost_kind, 'NONE')
        WHEN 'COST' THEN amount IS NOT NULL AND currency IS NOT NULL AND unpriced_reason IS NULL
          AND free_tier_provenance IS NULL AND free_tier_verified_on IS NULL
        WHEN 'UNPRICED' THEN amount IS NULL AND unpriced_reason IS NOT NULL
          AND free_tier_provenance IS NULL AND free_tier_verified_on IS NULL
        WHEN 'FREE_TIER' THEN amount IS NOT NULL AND amount = 0 AND currency IS NOT NULL
          AND unpriced_reason IS NULL
          AND free_tier_provenance IS NOT NULL AND length(btrim(free_tier_provenance)) > 0
          AND free_tier_verified_on IS NOT NULL
        ELSE amount IS NULL AND currency IS NULL AND unpriced_reason IS NULL
          AND free_tier_provenance IS NULL AND free_tier_verified_on IS NULL
      END
    );
  END IF;
END
$$;
