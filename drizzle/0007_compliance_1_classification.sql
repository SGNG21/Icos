-- COMPLIANCE-1 — Schema classification & data classification columns
-- Migration additive uniquement : ne modifie aucune colonne ou contrainte existante.

-- Capabilities: ajout de la classification des données et politique de rétention
ALTER TABLE "capabilities" ADD COLUMN "sensitivity_level" text;
ALTER TABLE "capabilities" ADD COLUMN "data_category" text;
ALTER TABLE "capabilities" ADD COLUMN "retention_policy_ref" jsonb;

ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_sensitivity_level_check"
  CHECK ("sensitivity_level" IS NULL OR "sensitivity_level" IN ('C0','C1','C2','C3'));

ALTER TABLE "capabilities" ADD CONSTRAINT "capabilities_data_category_check"
  CHECK ("data_category" IS NULL OR "data_category" IN (
    'PUBLIC','INTERNAL','PERSONAL','SENSITIVE_PERSONAL','CONFIDENTIAL_CLIENT',
    'AUTH_SECRET','FINANCIAL','LEGAL','HEALTH','HR','CHILD_DATA','BIOMETRIC','DERIVED_PROFILE'
  ));

CREATE INDEX IF NOT EXISTS "capabilities_sensitivity_level_idx"
  ON "capabilities" ("sensitivity_level");
