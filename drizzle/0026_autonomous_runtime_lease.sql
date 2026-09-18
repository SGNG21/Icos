ALTER TABLE "autonomous_mission_runtime"
ADD COLUMN "owner_token" text;

--> statement-breakpoint

ALTER TABLE "autonomous_mission_runtime"
ADD COLUMN "lease_until" timestamp with time zone;

--> statement-breakpoint

CREATE INDEX "autonomous_mission_runtime_lease_idx"
ON "autonomous_mission_runtime" ("lease_until");
