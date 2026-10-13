-- Independent optional cache counters: absence is unknown, zero is measured.
--
-- DATA SAFETY
-- Adding nullable bigint columns without defaults is catalog-only: existing rows
-- are not rewritten or backfilled. For those rows, cache_read >= 0 and
-- cache_creation >= 0 evaluate to NULL, which CHECK accepts. The usage CHECK
-- usage_kind = 'METERED' OR (cache_read IS NULL AND cache_creation IS NULL) is
-- true for every existing row when the columns are first added. No row is modified;
-- the append-only UPDATE/DELETE trigger is not fired by ALTER TABLE.
-- CHECK validation can scan the table; ALTER takes ACCESS EXCLUSIVE locks.
-- One DO statement keeps the changes atomic. Column and table-scoped constraint
-- guards make reapplication a no-op without changing existing measurements.
--
-- ROLLBACK
-- Drop only the new constraints; keep both columns and every measured value.
-- The cache contract forbids dropping the columns or deleting historical evidence.
--   ALTER TABLE spend_ledger
--     DROP CONSTRAINT IF EXISTS spend_ledger_cache_usage_check,
--     DROP CONSTRAINT IF EXISTS spend_ledger_cache_read_check,
--     DROP CONSTRAINT IF EXISTS spend_ledger_cache_creation_check;
-- Reapplying this migration restores the constraints if all retained data is valid.

DO $$
BEGIN
  ALTER TABLE spend_ledger
    ADD COLUMN IF NOT EXISTS cache_read bigint,
    ADD COLUMN IF NOT EXISTS cache_creation bigint;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'spend_ledger'::regclass
       AND conname = 'spend_ledger_cache_read_check'
  ) THEN
    ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cache_read_check
      CHECK (cache_read >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'spend_ledger'::regclass
       AND conname = 'spend_ledger_cache_creation_check'
  ) THEN
    ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cache_creation_check
      CHECK (cache_creation >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'spend_ledger'::regclass
       AND conname = 'spend_ledger_cache_usage_check'
  ) THEN
    ALTER TABLE spend_ledger ADD CONSTRAINT spend_ledger_cache_usage_check
      CHECK (usage_kind = 'METERED' OR (cache_read IS NULL AND cache_creation IS NULL));
  END IF;
END
$$;
