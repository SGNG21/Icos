-- 0040_autonomous_plan_lineage
--
-- Immutable autonomous plan lineage (CORE3 / mission N8-N9).
--
-- planId           : identity of ONE persisted plan version (never a digest)
-- planFingerprint  : deterministic hash of canonical logical plan content,
--                    used only for applyPlan idempotency detection
-- predecessorPlanId: lineage pointer to the superseded version's plan_id
--                    (NOT the internal surrogate id), giving P1 <- P2 <- P3
--
-- DATA SAFETY
-- Additive only. No column is dropped, renamed or retyped, and no row is
-- deleted or rewritten. Safe to re-run: every statement is guarded.
--
-- ROLLBACK
--   DROP INDEX IF EXISTS autonomous_plans_mission_id_plan_fingerprint_unique;
--   ALTER TABLE autonomous_plans
--     DROP CONSTRAINT IF EXISTS autonomous_plans_predecessor_plan_id_fkey;
--   ALTER TABLE autonomous_plans DROP COLUMN IF EXISTS predecessor_plan_id;
--   ALTER TABLE autonomous_plans DROP COLUMN IF EXISTS plan_fingerprint;
--   DROP INDEX IF EXISTS missions_goal_id_idx;
--   ALTER TABLE missions DROP COLUMN IF EXISTS plan_id;
--   ALTER TABLE missions DROP COLUMN IF EXISTS goal_id;
-- Rolling back loses lineage pointers and fingerprints only; plan identities
-- (plan_id) and versions are untouched, so mission -> plan resolution and all
-- CORE1/CORE2 behavior survive a rollback. Dropping missions.goal_id /
-- missions.plan_id reverts autonomous planning to the pre-CORE3 state; it does
-- not affect CORE1/CORE2 columns, which live in other tables.

-- ---------------------------------------------------------------------------
-- missions CORE3 lineage columns.
--
-- The Drizzle schema declared missions.goalId / missions.planId from the
-- goal-mission-plan lineage work, but no migration ever created them, so
-- autonomous plan lineage could not persist at all. Additive and nullable:
-- existing missions keep NULL until a goal/plan is attached.
-- ---------------------------------------------------------------------------
ALTER TABLE missions ADD COLUMN IF NOT EXISTS goal_id TEXT;
ALTER TABLE missions ADD COLUMN IF NOT EXISTS plan_id TEXT;

CREATE INDEX IF NOT EXISTS missions_goal_id_idx ON missions(goal_id);

DO $$
BEGIN
   IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'autonomous_plans') THEN
      CREATE TABLE autonomous_plans (
         id TEXT PRIMARY KEY,
         mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
         goal_id TEXT NOT NULL,
         plan_id TEXT NOT NULL,
         plan_fingerprint TEXT NOT NULL,
         version INTEGER NOT NULL,
         predecessor_plan_id TEXT,
         created_at TIMESTAMP WITH TIME ZONE NOT NULL,
         updated_at TIMESTAMP WITH TIME ZONE NOT NULL
      );
   END IF;
END $$;

-- The table may pre-exist from an earlier schema push without these columns.
-- Add them additively rather than relying on the CREATE TABLE branch above.
ALTER TABLE autonomous_plans
   ADD COLUMN IF NOT EXISTS predecessor_plan_id TEXT;

ALTER TABLE autonomous_plans
   ADD COLUMN IF NOT EXISTS plan_fingerprint TEXT;

/*
 * Backfill plan_fingerprint before enforcing NOT NULL.
 *
 * A true fingerprint cannot be recomputed from the database: plan CONTENT is
 * not stored in autonomous_plans. Pre-existing rows therefore receive a
 * namespaced sentinel derived from their unique plan_id.
 *
 * This is deliberately NOT a sha256 hex digest, so it can never collide with
 * a real fingerprint. applyPlan looks a plan up by (mission_id,
 * plan_fingerprint); a legacy row can therefore never be mistaken for a
 * content match and wrongly reused. Fail-closed: the worst case is that a
 * legacy plan is treated as a new version, never that two different plans are
 * treated as the same one.
 */
UPDATE autonomous_plans
   SET plan_fingerprint = 'legacy-unfingerprinted:' || plan_id
 WHERE plan_fingerprint IS NULL;

ALTER TABLE autonomous_plans
   ALTER COLUMN plan_fingerprint SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS autonomous_plans_plan_id_unique ON autonomous_plans(plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS autonomous_plans_mission_id_version_unique ON autonomous_plans(mission_id, version);
CREATE UNIQUE INDEX IF NOT EXISTS autonomous_plans_mission_id_plan_fingerprint_unique ON autonomous_plans(mission_id, plan_fingerprint);
CREATE INDEX IF NOT EXISTS autonomous_plans_mission_id_idx ON autonomous_plans(mission_id);

-- predecessor_plan_id references the logical plan identity, not the surrogate id.
DO $$
BEGIN
   ALTER TABLE autonomous_plans
      ADD CONSTRAINT autonomous_plans_predecessor_plan_id_fkey
      FOREIGN KEY (predecessor_plan_id)
      REFERENCES autonomous_plans(plan_id);
EXCEPTION
   WHEN duplicate_object THEN null;
   WHEN duplicate_table THEN null;
END $$;
