CREATE TABLE "goals" (
	"id" text PRIMARY KEY NOT NULL,
	"goalId" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"rawInput" text NOT NULL,
	"normalizedIntent" text NOT NULL,
	"constraints" text[] NOT NULL DEFAULT '{}',
	"successCriteria" text[] NOT NULL DEFAULT '{}',
	"priority" integer NOT NULL DEFAULT 3,
	"riskLevel" text NOT NULL DEFAULT 'reversible',
	"deadline" timestamp with time zone,
	"budget" double precision,
	"allowedCapabilities" text[] NOT NULL DEFAULT '{}',
	"forbiddenCapabilities" text[] NOT NULL DEFAULT '{}',
	"humanApprovalPolicy" text NOT NULL DEFAULT 'if_risky',
	"metadata" jsonb NOT NULL DEFAULT '{}',
	"status" text NOT NULL DEFAULT 'pending',
	"convertedAt" timestamp with time zone,
	"resultingMissionId" text,
	"idempotencyKey" text,
	"createdAt" timestamp with time zone NOT NULL,
	"updatedAt" timestamp with time zone NOT NULL,
	CONSTRAINT "goals_goalId_unique" UNIQUE("goalId")
);
--> statement-breakpoint
CREATE TABLE "goal_previews" (
	"id" text PRIMARY KEY NOT NULL,
	"goalId" text NOT NULL,
	"missionTitle" text NOT NULL,
	"missionObjective" text NOT NULL,
	"tasks" jsonb NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	CONSTRAINT "goal_previews_goalId_goals_goalId_fk" FOREIGN KEY ("goalId") REFERENCES "goals"("goalId") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "goal_previews_goalId_idx" ON "goal_previews" USING btree ("goalId");