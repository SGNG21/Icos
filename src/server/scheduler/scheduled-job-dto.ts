import type { ScheduledJob } from "@/core/contracts/scheduler";

/** Vue API d'un job : dates ISO, jamais le jeton de lease. */
export function toScheduledJobDto(job: ScheduledJob) {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    priority: job.priority,
    idempotencyKey: job.idempotencyKey,
    payload: job.payload,
    missionId: job.missionId ?? null,
    nextRunAt: job.nextRunAt.toISOString(),
    deadlineAt: job.deadlineAt?.toISOString() ?? null,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    lastError: job.lastError ?? null,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}
