-- Migration: set default values for created_at and updated_at in missions table
DO $$ BEGIN
   ALTER TABLE missions ALTER COLUMN created_at SET DEFAULT now();
EXCEPTION
   WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
   ALTER TABLE missions ALTER COLUMN updated_at SET DEFAULT now();
EXCEPTION
   WHEN duplicate_object THEN null;
END $$;

-- Update existing rows to have a timestamp if they are null
UPDATE missions SET created_at = now() WHERE created_at IS NULL;
UPDATE missions SET updated_at = now() WHERE updated_at IS NULL;