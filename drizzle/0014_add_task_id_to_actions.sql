--> statement-breakpoint
ALTER TABLE "actions" ADD COLUMN "task_id" text;
--> statement-breakpoint
CREATE INDEX "actions_task_id_idx" ON "actions" USING btree ("task_id");