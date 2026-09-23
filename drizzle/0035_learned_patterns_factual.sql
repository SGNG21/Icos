-- Align learned_patterns persistence with the factual LearnedPattern contract.
-- Historical factual data is stored in observations and remains untouched.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'learned_patterns'
      AND column_name = 'workerKind'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'learned_patterns'
      AND column_name = 'worker_kind'
  ) THEN
    ALTER TABLE "learned_patterns" RENAME COLUMN "workerKind" TO "worker_kind";
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'learned_patterns'
      AND column_name = 'createdAt'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'learned_patterns'
      AND column_name = 'created_at'
  ) THEN
    ALTER TABLE "learned_patterns" RENAME COLUMN "createdAt" TO "created_at";
  END IF;
END
$$;
--> statement-breakpoint
DROP INDEX IF EXISTS "learned_patterns_confidence_idx";
--> statement-breakpoint
ALTER TABLE "learned_patterns" DROP COLUMN IF EXISTS "confidence";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learned_patterns_capability_idx"
  ON "learned_patterns" USING btree ("capability");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learned_patterns_worker_kind_idx"
  ON "learned_patterns" USING btree ("worker_kind");
