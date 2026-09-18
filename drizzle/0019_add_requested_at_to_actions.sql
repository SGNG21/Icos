--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "requested_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint
CREATE INDEX "actions_requested_at_idx" ON "actions" USING btree ("requested_at");