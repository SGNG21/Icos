import { describe, expect, it, vi } from "vitest";

import { PermanentJobError } from "@/server/scheduler/durable-scheduler";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import {
  COMPUTE_RECONCILE_JOB_KIND,
  createComputeFleetReconcileHandler,
  DEFAULT_COMPUTE_RECONCILE_INTERVAL_MS,
  resolveComputeReconcileIntervalMs,
  seedComputeFleetReconciliation,
} from "./compute-fleet-schedule";

const job = {} as never;
const ctx = { signal: new AbortController().signal };
const APPLIED = { status: "PROVIDER_UNAVAILABLE", error: "down" } as const;

describe("compute fleet reconciliation schedule", () => {
  it("bounds the frequency: default 5 min, refused below 1 min or above 1 h", () => {
    expect(resolveComputeReconcileIntervalMs()).toBe(DEFAULT_COMPUTE_RECONCILE_INTERVAL_MS);
    expect(DEFAULT_COMPUTE_RECONCILE_INTERVAL_MS).toBe(300_000);
    expect(resolveComputeReconcileIntervalMs(600_000)).toBe(600_000);
    expect(() => resolveComputeReconcileIntervalMs(30_000)).toThrow(
      /COMPUTE_RECONCILE_INTERVAL_INVALID/,
    );
    expect(() => resolveComputeReconcileIntervalMs(2 * 3_600_000)).toThrow(/INVALID/);
  });

  it("seeding is grid-aligned and idempotent across replicas", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const now = () => new Date("2026-10-11T10:02:30.000Z");
    const first = await seedComputeFleetReconciliation(jobs, { now });
    const second = await seedComputeFleetReconciliation(jobs, { now });
    expect(first).toEqual({ created: true, at: new Date("2026-10-11T10:05:00.000Z") });
    expect(second.created).toBe(false);
  });

  it("reconciles, then schedules exactly the next grid occurrence — a provider outage is an outcome, not a failure", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const enqueue = vi.spyOn(jobs, "enqueue");
    const reconcile = vi.fn(async () => APPLIED);
    const handler = createComputeFleetReconcileHandler({
      reconcile,
      enabled: () => true,
      jobs,
      now: () => new Date("2026-10-11T10:02:30.000Z"),
    });
    await expect(handler(job, ctx)).resolves.toEqual(APPLIED);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: COMPUTE_RECONCILE_JOB_KIND,
        runAt: new Date("2026-10-11T10:05:00.000Z"),
      }),
    );
  });

  it("disabled (ICOS_COMPUTE_BOOTSTRAP off): no reconciliation and no successor", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const enqueue = vi.spyOn(jobs, "enqueue");
    const reconcile = vi.fn(async () => APPLIED);
    const handler = createComputeFleetReconcileHandler({ reconcile, enabled: () => false, jobs });
    await expect(handler(job, ctx)).resolves.toEqual({ status: "DISABLED" });
    expect(reconcile).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("a lost successor is a PERMANENT job error, never a silently stopped chain", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    vi.spyOn(jobs, "enqueue").mockRejectedValue(new Error("db down"));
    const handler = createComputeFleetReconcileHandler({
      reconcile: async () => APPLIED,
      enabled: () => true,
      jobs,
    });
    await expect(handler(job, ctx)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("a reconciliation that throws is retried by the scheduler: no successor is scheduled", async () => {
    const jobs = new InMemoryScheduledJobRepository();
    const enqueue = vi.spyOn(jobs, "enqueue");
    const handler = createComputeFleetReconcileHandler({
      reconcile: async () => {
        throw new Error("unexpected");
      },
      enabled: () => true,
      jobs,
    });
    await expect(handler(job, ctx)).rejects.toThrow("unexpected");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
