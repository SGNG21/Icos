--> statement-breakpoint
CREATE TABLE "checkpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"missionId" text NOT NULL,
	"state" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"label" text
);
--> statement-breakpoint
CREATE INDEX "checkpoints_missionId_idx" ON "checkpoints" USING btree ("missionId");
--> statement-breakpoint
CREATE INDEX "checkpoints_created_at_idx" ON "checkpoints" USING btree ("created_at");