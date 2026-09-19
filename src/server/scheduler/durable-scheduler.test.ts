import { describe, expect, it, vi } from "vitest";

import type { ScheduledJobKind } from "@/core/contracts/scheduler";
import { DurableScheduler, PermanentJobError, type JobHandler } from "@/server/scheduler/durable-scheduler";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const job = (o: Record<string, unknown> = {}) => ({
  kind: "wake_mission" as ScheduledJobKind,
  payload: { missionId: "m" },
  payloadHash: `h${Math.random()}`,
  idempotencyKey: `k${Math.random()}`,
  runAt: new Date(Date.now() - 1_000),
  ...o,
});
const scheduler = (
  repo: InMemoryScheduledJobRepository,
  handler: JobHandler,
  options: { leaseMs?: number; heartbeatMs?: number } = {},
) => new DurableScheduler(repo, { wake_mission: handler, start_mission: handler }, options);

describe("DurableScheduler.sweep", () => {
  it("runs a due job exactly once and completes it, leaving future jobs untouched", async () => {
    const repo = new InMemoryScheduledJobRepository();
    const due = (await repo.enqueue(job())).job;
    const future = (await repo.enqueue(job({ runAt: new Date(Date.now() + 60_000) }))).job;
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await scheduler(repo, handler).sweep();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ discovered: 1, attempted: 1, succeeded: 1, failed: 0 });
    expect((await repo.getById(due.id))?.state).toBe("succeeded");
    expect((await repo.getById(future.id))?.state).toBe("scheduled");
  });

  it("two concurrent schedulers never run the same job twice", async () => {
    const repo = new InMemoryScheduledJobRepository();
    await repo.enqueue(job());
    const handler = vi.fn(async () => sleep(30));
    await Promise.all([scheduler(repo, handler).sweep(), scheduler(repo, handler).sweep()]);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("schedules a durable retry when the handler throws, and does not rerun it before the backoff", async () => {
    const repo = new InMemoryScheduledJobRepository();
    const { job: created } = await repo.enqueue(job({ backoffBaseMs: 60_000 }));
    const handler = vi.fn().mockRejectedValue(new Error("provider down"));
    const s = scheduler(repo, handler);

    const first = await s.sweep();
    expect(first).toMatchObject({ attempted: 1, failed: 1 });
    expect(await repo.getById(created.id)).toMatchObject({ state: "scheduled", lastError: "provider down" });
    await s.sweep();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("kills a job on a permanent error or when no handler exists for its kind", async () => {
    const repo = new InMemoryScheduledJobRepository();
    const a = (await repo.enqueue(job())).job;
    await scheduler(repo, async () => {
      throw new PermanentJobError("SCHEDULER_MISSION_NOT_FOUND");
    }).sweep();
    expect(await repo.getById(a.id)).toMatchObject({ state: "dead", lastError: "SCHEDULER_MISSION_NOT_FOUND" });

    const b = (await repo.enqueue(job())).job;
    await new DurableScheduler(repo, {}).sweep();
    expect(await repo.getById(b.id)).toMatchObject({ state: "dead" });
    expect((await repo.getById(b.id))?.lastError).toContain("SCHEDULER_NO_HANDLER");
  });

  it("crash after claim: a restarted scheduler re-runs the job once the lease expired", async () => {
    const repo = new InMemoryScheduledJobRepository();
    const { job: created } = await repo.enqueue(job());
    await repo.claimDue("crashed-process", 40); // claimed, then the process died: nothing else happens
    const handler = vi.fn().mockResolvedValue(undefined);

    await scheduler(repo, handler).sweep();
    expect(handler).not.toHaveBeenCalled(); // lease still active
    await sleep(80);
    await scheduler(repo, handler).sweep();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(await repo.getById(created.id)).toMatchObject({ state: "succeeded", attemptCount: 2 });
  });

  it("keeps the lease alive with a heartbeat while a handler runs longer than the lease", async () => {
    const repo = new InMemoryScheduledJobRepository();
    const { job: created } = await repo.enqueue(job());
    const handler = vi.fn(async () => sleep(200));
    const first = scheduler(repo, handler, { leaseMs: 60, heartbeatMs: 15 }).sweep();
    await sleep(120);
    await scheduler(repo, handler, { leaseMs: 60, heartbeatMs: 15 }).sweep(); // must not steal it
    await first;
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await repo.getById(created.id))?.state).toBe("succeeded");
  });

  it("aborts the handler signal and ignores its result when the lease was lost", async () => {
    const repo = new InMemoryScheduledJobRepository();
    const { job: created } = await repo.enqueue(job());
    let aborted = false;
    const slow: JobHandler = async (_job, { signal }) => {
      signal.addEventListener("abort", () => (aborted = true));
      await sleep(150);
    };
    // Renewal fails (e.g. the row was reclaimed): the first owner must notice and abort.
    vi.spyOn(repo, "renewLease").mockResolvedValue(false);
    const first = scheduler(repo, slow, { leaseMs: 40, heartbeatMs: 10 }).sweep();
    await sleep(80);
    const fast = vi.fn().mockResolvedValue(undefined);
    await scheduler(repo, fast).sweep(); // reclaims the expired lease
    const result = await first;

    expect(fast).toHaveBeenCalledTimes(1);
    expect(aborted).toBe(true);
    expect(result.succeeded).toBe(0);
    expect(await repo.getById(created.id)).toMatchObject({ state: "succeeded", attemptCount: 2 });
  });

  it("honours maxJobsPerSweep", async () => {
    const repo = new InMemoryScheduledJobRepository();
    for (let i = 0; i < 4; i++) await repo.enqueue(job());
    const handler = vi.fn().mockResolvedValue(undefined);
    const result = await new DurableScheduler(repo, { wake_mission: handler }, { maxJobsPerSweep: 3 }).sweep();
    expect(result.attempted).toBe(3);
  });
});
