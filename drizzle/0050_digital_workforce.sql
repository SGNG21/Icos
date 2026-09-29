-- 0050_digital_workforce
--
-- Digital workforce / Mini-ICOS foundation (decision 0056, lane D).
-- Schema mirror: src/server/database/workforce-schema.ts.
--
-- TENANT KEY: tenant_id is part of every primary and foreign key; the application filters
-- every query on it. RLS is NOT enabled: ICOS has no RLS and no runtime TenantContext yet
-- (COMPLIANCE-1). Cross-tenant references are impossible by construction of the composite FKs.
--
-- GOVERNANCE AT THE DATABASE BOUNDARY
--   * workforce_events and workforce_performance_observations are append-only (IC002).
--   * a blocked/retired agent and a blocked/synthesized assignment never change again (IC003).
--   * closed value sets are re-asserted by CHECK constraints.
-- Triggers do not fire on TRUNCATE, so test cleanup keeps working (same as 0001 / 0031).
--
-- DATA SAFETY: additive only — seven new tables, two functions, four triggers. No existing
-- table, column or row is read, altered or rewritten. Nothing existing references these tables.
--
-- ROLLBACK (loses all workforce data; nothing else is affected):
--   DROP TABLE IF EXISTS workforce_events, workforce_performance_observations,
--     workforce_assignments, workforce_agents, workforce_departments, workforce_roles,
--     workforce_skills;
--   DROP FUNCTION IF EXISTS icos_workforce_forbid_mutation();
--   DROP FUNCTION IF EXISTS icos_workforce_terminal_status();

CREATE TABLE IF NOT EXISTS "workforce_skills" (
	"tenant_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_skills_tenant_id_skill_id_version_pk" PRIMARY KEY("tenant_id","skill_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workforce_roles" (
	"tenant_id" text NOT NULL,
	"role_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text NOT NULL,
	"spec" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workforce_roles_tenant_id_role_id_version_pk" PRIMARY KEY("tenant_id","role_id","version"),
	CONSTRAINT "workforce_roles_status_check" CHECK ("status" in ('draft','certified','active','retired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workforce_departments" (
	"tenant_id" text NOT NULL,
	"department_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	CONSTRAINT "workforce_departments_tenant_id_department_id_pk" PRIMARY KEY("tenant_id","department_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workforce_agents" (
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"role_id" text NOT NULL,
	"role_version" text NOT NULL,
	"supervisor_agent_id" text,
	"parent_agent_id" text,
	"depth" integer NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workforce_agents_tenant_id_agent_id_pk" PRIMARY KEY("tenant_id","agent_id"),
	CONSTRAINT "workforce_agents_role_fk" FOREIGN KEY ("tenant_id","role_id","role_version") REFERENCES "workforce_roles"("tenant_id","role_id","version") ON DELETE restrict,
	CONSTRAINT "workforce_agents_supervisor_fk" FOREIGN KEY ("tenant_id","supervisor_agent_id") REFERENCES "workforce_agents"("tenant_id","agent_id") ON DELETE restrict,
	CONSTRAINT "workforce_agents_parent_fk" FOREIGN KEY ("tenant_id","parent_agent_id") REFERENCES "workforce_agents"("tenant_id","agent_id") ON DELETE restrict,
	CONSTRAINT "workforce_agents_kind_check" CHECK ("kind" in ('DURABLE_AGENT','EPHEMERAL_SPECIALIST','EXECUTION_WORKER')),
	CONSTRAINT "workforce_agents_status_check" CHECK ("status" in ('active','suspended','retired','blocked')),
	CONSTRAINT "workforce_agents_depth_check" CHECK ("depth" >= 0 and (("supervisor_agent_id" is null) = ("depth" = 0)))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workforce_agents_supervisor_idx" ON "workforce_agents" USING btree ("tenant_id","supervisor_agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workforce_assignments" (
	"tenant_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"task_id" text NOT NULL,
	"parent_assignment_id" text,
	"supervisor_agent_id" text NOT NULL,
	"assignee_agent_id" text NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workforce_assignments_tenant_id_assignment_id_pk" PRIMARY KEY("tenant_id","assignment_id"),
	CONSTRAINT "workforce_assignments_parent_fk" FOREIGN KEY ("tenant_id","parent_assignment_id") REFERENCES "workforce_assignments"("tenant_id","assignment_id") ON DELETE restrict,
	CONSTRAINT "workforce_assignments_supervisor_fk" FOREIGN KEY ("tenant_id","supervisor_agent_id") REFERENCES "workforce_agents"("tenant_id","agent_id") ON DELETE restrict,
	CONSTRAINT "workforce_assignments_assignee_fk" FOREIGN KEY ("tenant_id","assignee_agent_id") REFERENCES "workforce_agents"("tenant_id","agent_id") ON DELETE restrict,
	CONSTRAINT "workforce_assignments_status_check" CHECK ("status" in ('assigned','executing','in_review','changes_requested','accepted','blocked','synthesized'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workforce_assignments_mission_idx" ON "workforce_assignments" USING btree ("tenant_id","mission_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workforce_assignments_assignee_idx" ON "workforce_assignments" USING btree ("tenant_id","assignee_agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workforce_performance_observations" (
	"tenant_id" text NOT NULL,
	"observation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"assignment_id" text NOT NULL,
	"spec" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workforce_performance_observations_tenant_id_observation_id_pk" PRIMARY KEY("tenant_id","observation_id"),
	CONSTRAINT "workforce_observations_assignment_fk" FOREIGN KEY ("tenant_id","assignment_id") REFERENCES "workforce_assignments"("tenant_id","assignment_id") ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workforce_events" (
	"tenant_id" text NOT NULL,
	"event_id" text NOT NULL,
	"seq" integer GENERATED ALWAYS AS IDENTITY,
	"type" text NOT NULL,
	"actor_kind" text NOT NULL,
	"actor_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"details" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workforce_events_tenant_id_event_id_pk" PRIMARY KEY("tenant_id","event_id"),
	CONSTRAINT "workforce_events_actor_kind_check" CHECK ("actor_kind" in ('human','agent','system'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workforce_events_subject_idx" ON "workforce_events" USING btree ("tenant_id","subject_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION icos_workforce_forbid_mutation() RETURNS trigger AS $$
BEGIN
	RAISE EXCEPTION '% est append-only : % interdit', TG_TABLE_NAME, TG_OP
		USING ERRCODE = 'IC002';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION icos_workforce_terminal_status() RETURNS trigger AS $$
BEGIN
	IF (TG_TABLE_NAME = 'workforce_agents' AND OLD.status IN ('blocked','retired'))
		OR (TG_TABLE_NAME = 'workforce_assignments' AND OLD.status IN ('blocked','synthesized')) THEN
		RAISE EXCEPTION '% % est terminal (%) : % interdit', TG_TABLE_NAME, OLD.status, TG_OP, TG_OP
			USING ERRCODE = 'IC003';
	END IF;
	IF TG_OP = 'DELETE' THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workforce_events_append_only ON workforce_events;
--> statement-breakpoint
CREATE TRIGGER workforce_events_append_only
	BEFORE UPDATE OR DELETE ON workforce_events
	FOR EACH ROW EXECUTE FUNCTION icos_workforce_forbid_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workforce_observations_append_only ON workforce_performance_observations;
--> statement-breakpoint
CREATE TRIGGER workforce_observations_append_only
	BEFORE UPDATE OR DELETE ON workforce_performance_observations
	FOR EACH ROW EXECUTE FUNCTION icos_workforce_forbid_mutation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workforce_agents_terminal ON workforce_agents;
--> statement-breakpoint
CREATE TRIGGER workforce_agents_terminal
	BEFORE UPDATE OR DELETE ON workforce_agents
	FOR EACH ROW EXECUTE FUNCTION icos_workforce_terminal_status();
--> statement-breakpoint
DROP TRIGGER IF EXISTS workforce_assignments_terminal ON workforce_assignments;
--> statement-breakpoint
CREATE TRIGGER workforce_assignments_terminal
	BEFORE UPDATE OR DELETE ON workforce_assignments
	FOR EACH ROW EXECUTE FUNCTION icos_workforce_terminal_status();
