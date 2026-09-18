ALTER TABLE "skills" DROP CONSTRAINT "skills_data_category_check";--> statement-breakpoint
ALTER TABLE "skills" DROP CONSTRAINT "skills_sensitivity_level_check";--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD COLUMN "task_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "mission_tasks" ADD CONSTRAINT "mission_tasks_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;