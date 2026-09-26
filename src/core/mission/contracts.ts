import { z } from "zod";

export const MissionStatusSchema = z.enum([
  "draft",
  "planning",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "succeeded",
  "failed",
  "cancelled",
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const MissionTaskStatusSchema = z.enum([
  "draft",
  "queued",
  "awaiting_approval",
  "running",
  "review_pending",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
  "superseded",
]);

export const MissionTaskSchema = z.object({
  id: z.string(),
  missionId: z.string(),
  title: z.string(),
  description: z.string().optional().nullable(),
  dependsOn: z.array(z.string()),
  status: MissionTaskStatusSchema,
  workerKind: z.string().optional().nullable(),
  capability: z.string().optional().nullable(),
  // Reference to the canonical task in the tasks table
  taskId: z.string(),
});

export const MissionSchema = z.object({
  id: z.string(),
  title: z.string(),
  objective: z.string(),
  // Optional goalId for missions originating from a goal (CORE3)
  goalId: z.string().optional(),
  // Optional planId for missions that have an associated autonomous plan (CORE3)
  planId: z.string().optional(),
  status: MissionStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type Mission = z.infer<typeof MissionSchema>;
export type MissionTask = z.infer<typeof MissionTaskSchema>;

export interface CreateMissionInput {
  title: string;
  objective: string;
  goalId?: string;
  tasks: Omit<MissionTask, "id" | "missionId" | "status" | "taskId">[];
}
