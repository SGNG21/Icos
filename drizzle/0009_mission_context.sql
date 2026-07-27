-- CTX-SUP-1B — MissionContext Persistence + Versioning
-- Migration additive uniquement : crée la table mission_contexts (snapshots
-- versionnés immuables, append-only).
--
-- La clé primaire composite (tenant_id, mission_id, version) EST le verrou
-- optimiste : deux writers en course sur la même version → une seule ligne
-- réussit, l'autre reçoit 23505 unique_violation (concurrence fail-closed).
-- Le « latest » est dérivé de MAX(version) via l'index DESC.

CREATE TABLE "mission_contexts" (
  "tenant_id" text NOT NULL,
  "mission_id" text NOT NULL,
  "version" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "built_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "mission_contexts_pkey" PRIMARY KEY ("tenant_id", "mission_id", "version"),
  CONSTRAINT "mission_contexts_version_check" CHECK ("mission_contexts"."version" >= 0)
);

CREATE INDEX "mission_contexts_latest_idx"
  ON "mission_contexts" USING btree ("tenant_id", "mission_id", "version" DESC);
