--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"missionId" text NOT NULL,
	"taskId" text,
	"decision" text NOT NULL,
	"reasons" text[] NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "decisions_mission_id_idx" ON "decisions" USING btree ("missionId");
--> statement-breakpoint
CREATE INDEX "decisions_task_id_idx" ON "decisions" USING btree ("taskId");
--> statement-breakpoint
CREATE TABLE "learned_patterns" (
	"id" text PRIMARY KEY NOT NULL,
	"capability" text,
	"workerKind" text,
	"signature" text NOT NULL,
	"description" text,
	"outcome" text NOT NULL,
	"observations" jsonb NOT NULL,
	"confidence" double precision NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_items" (
	"id" text PRIMARY KEY NOT NULL,
	"missionId" text NOT NULL,
	"scope" text NOT NULL,
	"type" text NOT NULL,
	"summary" text NOT NULL,
	"contentReference" text,
	"createdAt" timestamp with time zone NOT NULL,
	"priority" integer NOT NULL,
	"tokenEstimate" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "context_items_mission_id_idx" ON "context_items" USING btree ("missionId");
--> statement-breakpoint
CREATE INDEX "context_items_scope_idx" ON "context_items" USING btree ("scope");
--> statement-breakpoint
CREATE INDEX "context_items_type_idx" ON "context_items" USING btree ("type");
--> statement-breakpoint
CREATE TABLE "handoff_packages" (
	"id" text PRIMARY KEY NOT NULL,
	"missionId" text NOT NULL,
	"fromAgent" text NOT NULL,
	"toAgent" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"instructions" text,
	"missionContext" jsonb NOT NULL,
	"workingMemorySlice" jsonb,
	"durableRefs" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "handoff_packages_mission_id_idx" ON "handoff_packages" USING btree ("missionId");
--> statement-breakpoint
CREATE INDEX "handoff_packages_from_agent_idx" ON "handoff_packages" USING btree ("fromAgent");
--> statement-breakpoint
CREATE INDEX "handoff_packages_to_agent_idx" ON "handoff_packages" USING btree ("toAgent");