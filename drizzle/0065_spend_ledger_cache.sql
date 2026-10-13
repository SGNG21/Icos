-- Independent optional counters. Historical rows remain unknown; no backfill or default.
ALTER TABLE spend_ledger
  ADD COLUMN cache_read bigint,
  ADD COLUMN cache_creation bigint,
  ADD CONSTRAINT spend_ledger_cache_read_check CHECK (cache_read >= 0),
  ADD CONSTRAINT spend_ledger_cache_creation_check CHECK (cache_creation >= 0),
  ADD CONSTRAINT spend_ledger_cache_usage_check CHECK (
    usage_kind = 'METERED' OR (cache_read IS NULL AND cache_creation IS NULL)
  );
