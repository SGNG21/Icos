import { z } from "zod";

import { approvalStatusSchema, idSchema, taskStatusSchema } from "@/core/contracts";
import { dependencyTypeSchema } from "@/core/contracts/task-dependency";
import { riskClassSchema } from "@/core/contracts/task";
import { reviewPolicySchema } from "@/core/contracts/task";
import { integrationPolicySchema } from "@/core/contracts/task";

/**
 * Corps de création de tâche. `.strict()` rejette tout champ superflu. Le titre
 * est normalisé (`trim`) avant contrôle de longueur : une chaîne uniquement
 * composée d'espaces est rejetée.
 */
export const createTaskBodySchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().optional(),
    missionId: z.string().optional(),
    goalId: z.string().optional(),
    planId: z.string().optional(),
    objective: z.string().optional(),
    instructions: z.string().optional(),
    dependencies: z
      .array(
        z.object({
          taskId: idSchema,
          type: dependencyTypeSchema,
        })
      )
      .default([]),
    successCriteria: z.array(z.string()).default([]),
    requiredCapabilities: z.array(z.string()).default([]),
    riskClass: riskClassSchema.default("reversible").optional(),
    allowedFileScope: z.array(z.string()).default([]),
    expectedArtifacts: z.array(z.string()).default([]),
    priority: z.number().int().min(1).max(5).default(3).optional(),
    attemptBudget: z.number().int().min(1).default(3).optional(),
    reviewPolicy: reviewPolicySchema.default("if_risky").optional(),
    integrationPolicy: integrationPolicySchema.default("").optional(),
    assignedAgentId: idSchema.optional(),
  })
  .strict();

export type CreateTaskBody = z.infer<typeof createTaskBodySchema>;

export const transitionBodySchema = z.object({ to: taskStatusSchema }).strict();
export type TransitionBody = z.infer<typeof transitionBodySchema>;

/** Filtre de requête pour la liste des actions. */
export const actionQuerySchema = z.object({
  approvalStatus: approvalStatusSchema.optional(),
});

/** Filtre de requête pour le journal d'audit. */
export const auditQuerySchema = z.object({
  eventType: z
    .enum([
      "task.created",
      "task.transitioned",
      "approval.recorded",
      "action.decided",
    ])
    .optional(),
  actorId: z.string().min(1).optional(),
  taskId: idSchema.optional(),
  actionId: idSchema.optional(),
});