-- Align decisions table with ReviewDecisionRecord contract
-- Add missing columns and enforce constraints (table is known to be empty in this env)

ALTER TABLE decisions
  ADD COLUMN "workflowId" text NOT NULL,
  ADD COLUMN "reviewerKind" text NOT NULL,
  ADD COLUMN "severity" text NOT NULL,
  ADD COLUMN "requestedChanges" jsonb,
  ADD COLUMN "evidenceRefs" text[],
  ADD COLUMN "findingRefs" text[],
  ADD COLUMN "policyRefs" text[],
  ADD COLUMN "providerMetadata" jsonb,
  ADD COLUMN "confidence" double precision,
  ADD COLUMN "humanOverridden" boolean NOT NULL DEFAULT false,
  ADD COLUMN "overriddenBy" text;

-- Ensure existing columns are NOT NULL as per contract
ALTER TABLE decisions ALTER COLUMN "taskId" SET NOT NULL;

-- Add CHECK constraints for enum‑like columns
ALTER TABLE decisions
  ADD CONSTRAINT decisions_reviewerKind_check
    CHECK ("reviewerKind" IN ('deterministic','llm')),
  ADD CONSTRAINT decisions_severity_check
    CHECK ("severity" IN ('info','warning','critical')),
  ADD CONSTRAINT decisions_decision_check
    CHECK ("decision" IN ('APPROVE','REQUEST_CHANGES','BLOCK','ESCALATE_TO_HUMAN'));

-- Add unique constraint on workflowId
ALTER TABLE decisions ADD CONSTRAINT decisions_workflowId_unique UNIQUE ("workflowId");