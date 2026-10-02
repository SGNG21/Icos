import { randomUUID } from "node:crypto";

import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  type EnqueueScheduledJobInput,
  type ScheduledJob,
  type ScheduledJobKind,
  type ScheduledJobRepository,
  type ScheduledJobState,
} from "@/core/contracts/scheduler";

const clone = (job: ScheduledJob): ScheduledJob => structuredClone(job);

/** Même sémantique que PostgreSQL (tests unitaires / mode mémoire) ; non durable. */
export class InMemoryScheduledJobRepository implements ScheduledJobRepository {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly byKey = new Map<string, string>();

  async enqueue(input: EnqueueScheduledJobInput): Promise<{ job: ScheduledJob; created: boolean }> {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.jobs.get(existingId)!;
      if (existing.kind !== input.kind || existing.payloadHash !== input.payloadHash) {
        throw new Error("SCHEDULER_IDEMPOTENCY_CONFLICT");
      }
      return { job: clone(existing), created: false };
    }
    const now = new Date();
    const job: ScheduledJob = {
      id: randomUUID(),
      kind: input.kind,
      payload: structuredClone(input.payload),
      payloadHash: input.payloadHash,
      idempotencyKey: input.idempotencyKey,
      state: "scheduled",
      priority: input.priority ?? 0,
      nextRunAt: input.runAt ?? now,
      deadlineAt: input.deadlineAt,
      attemptCount: 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      backoffBaseMs: input.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      missionId: input.missionId,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.byKey.set(job.idempotencyKey, job.id);
    return { job: clone(job), created: true };
  }

  async claimDue(owner: string, leaseMs: number): Promise<ScheduledJob | null> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("SCHEDULER_INVALID_LEASE");
    const now = Date.now();
    const leaseExpired = (job: ScheduledJob) => job.leaseUntil !== undefined && job.leaseUntil.getTime() <= now;

    for (const job of this.jobs.values()) {
      const claimable =
        (job.state === "scheduled" && job.nextRunAt.getTime() <= now) ||
        (job.state === "running" && leaseExpired(job));
      if (claimable && job.deadlineAt && job.deadlineAt.getTime() <= now) {
        this.finish(job, "expired", "SCHEDULER_DEADLINE_PASSED");
      }
    }

    const due = [...this.jobs.values()]
      .filter(
        (job) =>
          (job.state === "scheduled" && job.nextRunAt.getTime() <= now) ||
          (job.state === "running" && leaseExpired(job)),
      )
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          a.nextRunAt.getTime() - b.nextRunAt.getTime() ||
          a.id.localeCompare(b.id),
      );

    for (const job of due) {
      if (job.state === "running" && job.attemptCount >= job.maxAttempts) {
        this.finish(job, "dead", "SCHEDULER_MAX_ATTEMPTS_EXCEEDED: lease expired after the last attempt");
        continue;
      }
      job.state = "running";
      job.attemptCount += 1;
      job.leaseOwner = owner;
      job.leaseUntil = new Date(now + leaseMs);
      job.updatedAt = new Date(now);
      return clone(job);
    }
    return null;
  }

  async renewLease(id: string, owner: string, leaseMs: number): Promise<boolean> {
    const job = this.owned(id, owner);
    if (!job) return false;
    job.leaseUntil = new Date(Date.now() + leaseMs);
    job.updatedAt = new Date();
    return true;
  }

  async complete(id: string, owner: string): Promise<boolean> {
    const job = this.owned(id, owner);
    if (!job) return false;
    this.finish(job, "succeeded");
    return true;
  }

  async fail(
    id: string,
    owner: string,
    error: string,
    options: { retryable: boolean },
  ): Promise<{ ok: boolean; state?: ScheduledJobState }> {
    const job = this.owned(id, owner);
    if (!job) return { ok: false };
    if (options.retryable && job.attemptCount < job.maxAttempts) {
      const backoff = Math.min(job.backoffBaseMs * 2 ** (job.attemptCount - 1), MAX_BACKOFF_MS);
      job.state = "scheduled";
      job.nextRunAt = new Date(Date.now() + backoff);
      job.leaseOwner = undefined;
      job.leaseUntil = undefined;
      job.lastError = error;
      job.updatedAt = new Date();
      return { ok: true, state: "scheduled" };
    }
    this.finish(job, "dead", error);
    return { ok: true, state: "dead" };
  }

  async countScheduledByKind(kind: ScheduledJobKind): Promise<number> {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.kind === kind && (job.state === "scheduled" || job.state === "running")) n += 1;
    }
    return n;
  }

  async getById(id: string): Promise<ScheduledJob | null> {
    const job = this.jobs.get(id);
    return job ? clone(job) : null;
  }

  private owned(id: string, owner: string): ScheduledJob | null {
    const job = this.jobs.get(id);
    return job && job.state === "running" && job.leaseOwner === owner ? job : null;
  }

  private finish(job: ScheduledJob, state: ScheduledJobState, error?: string): void {
    job.state = state;
    job.leaseOwner = undefined;
    job.leaseUntil = undefined;
    if (error !== undefined) job.lastError = error;
    job.completedAt = new Date();
    job.updatedAt = new Date();
  }
}
