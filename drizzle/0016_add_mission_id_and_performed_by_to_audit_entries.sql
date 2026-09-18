--> statement-breakpoint
ALTER TABLE "audit_entries" ADD COLUMN IF NOT EXISTS "mission_id" text;
--> statement-breakpoint
ALTER TABLE "audit_entries" ADD COLUMN IF NOT EXISTS "performed_by" text;