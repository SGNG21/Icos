ALTER TABLE "dispatch_attempts"
ADD COLUMN "claim_token" text;
--> statement-breakpoint
ALTER TABLE "dispatch_attempts"
ADD COLUMN "claim_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX "dispatch_attempts_recovery_claim_idx"
ON "dispatch_attempts" ("state", "claim_until");
