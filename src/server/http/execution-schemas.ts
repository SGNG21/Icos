import { z } from "zod";

import {
  executionErrorCodeSchema,
  executionOutcomeSchema,
  isoDateTimeSchema,
  workerKindSchema,
  workflowIdSchema,
  EXECUTION_RESULT_MAX_LENGTH,
} from "@/core/contracts";
import { idSchema } from "@/core/contracts";

/**
 * Corps du callback `execution.started` : Temporal signale à ICOS le démarrage
 * réel du travail par un worker. Idempotent côté ICOS (rejeu = no-op).
 */
export const executionStartedBodySchema = z
  .object({
    taskId: idSchema,
    workflowId: workflowIdSchema,
    startedAt: isoDateTimeSchema,
  })
  .strict();

export type ExecutionStartedBody = z.infer<typeof executionStartedBodySchema>;

/**
 * What a worker may ask about its own execution. Deliberately only identifiers: the
 * ANSWER carries the authority, and every field of it is read from ICOS's durable state.
 * A worker that invents a worktree path or claims write access changes nothing, because
 * no such field is accepted here.
 */
export const executionGrantBodySchema = z
  .object({
    taskId: idSchema,
    workflowId: workflowIdSchema,
  })
  .strict();

export type ExecutionGrantBody = z.infer<typeof executionGrantBodySchema>;

const executionErrorInputSchema = z
  .object({
    code: executionErrorCodeSchema,
    message: z.string().min(1).max(2_000),
  })
  .strict();

/**
 * Corps du callback `execution.completed` : Temporal remonte l'issue métier.
 * La validation refuse (fail-closed) tout couple (outcome, error/result)
 * incohérent — même contrat que `taskExecutionResultSchema`.
 */
export const executionCompletedBodySchema = z
  .object({
    taskId: idSchema,
    workflowId: workflowIdSchema,
    outcome: executionOutcomeSchema,
    workerKind: workerKindSchema.optional(),
    /* Observations about the real executor, not a copy of the routing request. */
    actualExecutor: z.string().min(1).max(200).optional(),
    actualProvider: z.string().min(1).max(200).optional(),
    actualModel: z.string().min(1).max(200).optional(),
    result: z.string().max(EXECUTION_RESULT_MAX_LENGTH).optional(),
    error: executionErrorInputSchema.optional(),
    startedAt: isoDateTimeSchema.optional(),
    completedAt: isoDateTimeSchema,
  })
  .strict()
  .refine((value) => value.outcome !== "failure" || value.error !== undefined, {
    message: "un échec doit porter une erreur normalisée",
    path: ["error"],
  })
  .refine((value) => value.outcome !== "success" || value.error === undefined, {
    message: "un succès ne peut pas porter d'erreur",
    path: ["error"],
  });

export type ExecutionCompletedBody = z.infer<typeof executionCompletedBodySchema>;
