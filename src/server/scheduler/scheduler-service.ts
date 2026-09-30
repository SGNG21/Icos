import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import type { ScheduledJob, ScheduledJobRepository } from "@/core/contracts/scheduler";

const common = {
  idempotencyKey: z.string().trim().min(1).max(200),
  runAt: z.coerce.date().optional(),
  deadlineAt: z.coerce.date().optional(),
  priority: z.number().int().min(-100).max(100).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
  backoffBaseMs: z.number().int().min(0).max(3_600_000).optional(),
};

export const enqueueScheduledJobSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("start_mission"),
        payload: z
          .object({
            title: z.string().trim().min(1).max(200),
            objective: z.string().trim().min(1).max(4000),
            // Optional goal lineage, already honoured by the start_mission handler
            // (decision 0057: a conversation launches its approved goal through here).
            goalId: z.string().trim().min(1).max(5000).optional(),
          })
          .strict(),
        ...common,
      })
      .strict(),
    z
      .object({
        kind: z.literal("wake_mission"),
        payload: z.object({ missionId: z.string().trim().min(1).max(200) }).strict(),
        ...common,
      })
      .strict(),
  ])
  .refine((v) => !v.runAt || !v.deadlineAt || v.deadlineAt >= v.runAt, {
    message: "deadlineAt must not be before runAt",
    path: ["deadlineAt"],
  });

export class SchedulerValidationError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super("SCHEDULER_INVALID_JOB");
    this.name = "SchedulerValidationError";
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Application entry point of the Durable Scheduler: validates a job, fixes the
 * Mission id for `start_mission` at enqueue time (so a replay after any crash can
 * never create a second Mission) and delegates to the durable repository.
 * Idempotency identity = idempotencyKey + kind + caller-supplied payload.
 */
export class SchedulerService {
  constructor(private readonly jobs: ScheduledJobRepository) {}

  async enqueue(input: unknown): Promise<{ job: ScheduledJob; created: boolean }> {
    const parsed = enqueueScheduledJobSchema.safeParse(input);
    if (!parsed.success) throw new SchedulerValidationError(parsed.error);
    const job = parsed.data;

    const payloadHash = createHash("sha256")
      .update(canonical({ kind: job.kind, payload: job.payload }))
      .digest("hex");

    const payload: Record<string, unknown> =
      job.kind === "start_mission" ? { ...job.payload, missionId: randomUUID() } : { ...job.payload };

    return this.jobs.enqueue({
      kind: job.kind,
      payload,
      payloadHash,
      idempotencyKey: job.idempotencyKey,
      runAt: job.runAt,
      deadlineAt: job.deadlineAt,
      priority: job.priority,
      maxAttempts: job.maxAttempts,
      backoffBaseMs: job.backoffBaseMs,
      missionId: payload.missionId as string,
    });
  }

  getJob(id: string): Promise<ScheduledJob | null> {
    return this.jobs.getById(id);
  }
}
