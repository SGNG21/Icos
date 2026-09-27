-- 0041_task_core3_planning_metadata
--
-- Persist CORE3 task planning metadata (mission N11/N12).
--
-- WHY THIS EXISTS
-- `prepareTaskCreation()` has been building canonical Tasks with goalId,
-- planId, objective, instructions, dependencies, successCriteria,
-- requiredCapabilities, riskClass, allowedFileScope, expectedArtifacts,
-- priority, attemptBudget, reviewPolicy and integrationPolicy — and
-- `taskToRow()` then persisted ONLY id/title/description/status/
-- assigned_agent_id/timestamps. Every planning field was validated in memory
-- and silently discarded at the persistence boundary, so none of it survived a
-- restart and `rowToTask()` could never read it back.
--
-- Migration 0039_task_core3_fields.sql is a 0-byte file that is already
-- recorded as applied, so it cannot be edited. This migration supersedes it.
--
-- DATA SAFETY
-- Additive only. No column is dropped, renamed or retyped; no row is deleted or
-- rewritten. Every new column is either nullable or NOT NULL with a default, so
-- pre-existing rows remain valid and the CHECK constraints below are satisfied
-- by those defaults. Safe to re-run: every statement is guarded.
--
-- ROLLBACK
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_attempt_budget_check;
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_review_policy_check;
--   ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_risk_class_check;
--   DROP INDEX IF EXISTS tasks_plan_id_idx;
--   DROP INDEX IF EXISTS tasks_mission_id_idx;
--   ALTER TABLE tasks
--     DROP COLUMN IF EXISTS integration_policy,
--     DROP COLUMN IF EXISTS review_policy,
--     DROP COLUMN IF EXISTS attempt_budget,
--     DROP COLUMN IF EXISTS priority,
--     DROP COLUMN IF EXISTS expected_artifacts,
--     DROP COLUMN IF EXISTS allowed_file_scope,
--     DROP COLUMN IF EXISTS risk_class,
--     DROP COLUMN IF EXISTS required_capabilities,
--     DROP COLUMN IF EXISTS success_criteria,
--     DROP COLUMN IF EXISTS dependencies,
--     DROP COLUMN IF EXISTS instructions,
--     DROP COLUMN IF EXISTS objective,
--     DROP COLUMN IF EXISTS plan_id,
--     DROP COLUMN IF EXISTS goal_id,
--     DROP COLUMN IF EXISTS mission_id;
-- Rolling back returns task planning metadata to being in-memory-only. It does
-- not touch id/title/description/status/assigned_agent_id, so CORE1/CORE2
-- behavior and every foreign key referencing tasks(id) survive.

-- Lineage: which mission/goal/plan version this canonical Task belongs to.
-- Nullable: a generic, non-autonomous Task has no lineage (mission N11).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mission_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS goal_id TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_id TEXT;

-- What the task is for, and how the worker should carry it out.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS objective TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS instructions TEXT;

-- Structured planning metadata.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS success_criteria JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS required_capabilities JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS allowed_file_scope JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS expected_artifacts JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Execution envelope. Defaults match what applyPlan previously hardcoded, so
-- enabling planner-supplied metadata changes nothing for an existing planner.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS risk_class TEXT NOT NULL DEFAULT 'reversible';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attempt_budget INTEGER NOT NULL DEFAULT 3;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS review_policy TEXT NOT NULL DEFAULT 'if_risky';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS integration_policy TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS tasks_mission_id_idx ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS tasks_plan_id_idx ON tasks(plan_id);

/*
 * Fail closed at the database boundary (mission N12).
 *
 * validateMissionPlan already rejects an unknown risk class or review policy,
 * but the database must refuse it too so a caller that bypasses the planning
 * layer cannot persist a task whose safety envelope is unrecognized.
 */
DO $$
BEGIN
   ALTER TABLE tasks ADD CONSTRAINT tasks_risk_class_check
      CHECK (risk_class IN ('read_only','reversible','sensitive'));
EXCEPTION
   WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
   ALTER TABLE tasks ADD CONSTRAINT tasks_review_policy_check
      CHECK (review_policy IN ('never','if_risky','always'));
EXCEPTION
   WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
   ALTER TABLE tasks ADD CONSTRAINT tasks_priority_check
      CHECK (priority BETWEEN 1 AND 5);
EXCEPTION
   WHEN duplicate_object THEN null;
END $$;

DO $$
BEGIN
   ALTER TABLE tasks ADD CONSTRAINT tasks_attempt_budget_check
      CHECK (attempt_budget >= 1);
EXCEPTION
   WHEN duplicate_object THEN null;
END $$;
