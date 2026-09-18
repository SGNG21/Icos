import { z } from "zod";
import { idSchema } from "./common";

/**
 * Type of dependency between tasks.
 */
export const dependencyTypeSchema = z.enum([
  "blocking", // This task must succeed before the dependent task can start
  "non_blocking", // This task does not block the dependent task (e.g., for informational purposes)
]);

export const taskDependencySchema = z.object({
  id: idSchema,
  missionId: z.string(),
  dependentTaskId: z.string(), // The task that depends on another
  dependencyTaskId: z.string(), // The task being depended upon
  type: dependencyTypeSchema,
  // Optional: a delay or condition
  // delayMs: z.number().int().nonnegative().optional(),
  // condition: z.string().optional(), // e.g., a Zod schema string for a condition
});

export type TaskDependency = z.infer<typeof taskDependencySchema>;
