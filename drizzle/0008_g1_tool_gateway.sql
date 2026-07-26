-- G1 — Tool Gateway Foundation
-- Migration additive uniquement : crée les tables d'execution_grants,
-- idempotency_entries et execution_records.

-- ExecutionGrant : autorisation atomique à usage unique
CREATE TABLE "execution_grants" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "mission_id" text NOT NULL,
  "run_id" text NOT NULL,
  "tool_id" text NOT NULL,
  "tool_definition_hash" text NOT NULL,
  "tool_version" text,
  "capability" text NOT NULL,
  "operation" text NOT NULL,
  "resource" text NOT NULL,
  "request_hash" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "policy_provenance" jsonb NOT NULL,
  "credential_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "network_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "isolation_requirements" jsonb NOT NULL,
  "issued_at" timestamp with time zone NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);

CREATE INDEX "execution_grants_tenant_idx" ON "execution_grants" USING btree ("tenant_id");
CREATE INDEX "execution_grants_principal_idx" ON "execution_grants" USING btree ("principal_id");
CREATE INDEX "execution_grants_request_hash_idx" ON "execution_grants" USING btree ("request_hash");
CREATE INDEX "execution_grants_consumed_at_idx" ON "execution_grants" USING btree ("consumed_at");

-- IdempotencyEntry : suivi d'état d'idempotence
CREATE TABLE "idempotency_entries" (
  "idempotency_key" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL,
  "request_hash" text NOT NULL,
  "tenant_id" text NOT NULL,
  "principal_id" text NOT NULL,
  "mission_id" text NOT NULL,
  "run_id" text NOT NULL,
  "grant_id" text,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "replay_result" jsonb,
  CONSTRAINT "idempotency_state_check"
    CHECK ("idempotency_entries"."state" in ('RESERVED','EXECUTING','COMPLETED','FAILED_SAFE','UNKNOWN'))
);

CREATE INDEX "idempotency_entries_tenant_idx" ON "idempotency_entries" USING btree ("tenant_id");
CREATE INDEX "idempotency_entries_principal_idx" ON "idempotency_entries" USING btree ("principal_id");
CREATE INDEX "idempotency_entries_state_idx" ON "idempotency_entries" USING btree ("state");

-- ExecutionRecord : append-only, historique du cycle de vie
CREATE TABLE "execution_records" (
  "id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "mission_id" text NOT NULL,
  "run_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "grant_id" text,
  "principal_id" text NOT NULL,
  "sensitivity_level" text NOT NULL,
  "events" jsonb NOT NULL,
  "output_hash" text,
  "artifact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "error_code" text,
  "error_message" text,
  "duration_ms" smallint DEFAULT 0 NOT NULL,
  "usage" jsonb,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "execution_records_sensitivity_check"
    CHECK ("execution_records"."sensitivity_level" in ('C0','C1','C2','C3'))
);

CREATE INDEX "execution_records_tenant_idx" ON "execution_records" USING btree ("tenant_id");
CREATE INDEX "execution_records_principal_idx" ON "execution_records" USING btree ("principal_id");
CREATE INDEX "execution_records_idempotency_key_idx" ON "execution_records" USING btree ("idempotency_key");
CREATE INDEX "execution_records_request_hash_idx" ON "execution_records" USING btree ("request_hash");
