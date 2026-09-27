import { describe, expect, it, vi } from "vitest";

import { HEALTH_EVIDENCE_MAX_AGE_MS } from "@/core/workers/worker-eligibility";
import { InMemoryScheduledJobRepository } from "@/server/scheduler/in-memory-scheduled-job-repository";
import { InMemoryWorkerRegistryStore } from "@/server/services/in-memory/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { PermanentJobError } from "@/server/scheduler/durable-scheduler";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import type { ScheduledJob } from "@/core/contracts/scheduler";
import {
  assertProbeIntervalWithinHorizon,
  createWorkerProbeHandler,
  enqueueWorkerProbeSweep,
  nextOccurrenceAt,
  seedWorkerProbeSweep,
  DEFAULT_WORKER_PROBE_INTERVAL_MS,
  WORKER_PROBE_JOB_KIND,
} from "./worker-probe-schedule";

/*
 * M6 AUTONOMOUS PROBE SWEEP — second half of defect 16.
 *
 * A probe nobody runs is a probe that does not exist. These prove the recurrence
 * is durable, once-per-fleet, self-perpetuating and idempotent, and that a
 * misconfiguration that would make it useless is refused instead of accepted.
 */

const W1 = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-27T12:00:00.000Z");

function harness() {
  let current = NOW;
  const clock = { now: () => current, set: (d: Date) => void (current = d) };
  const store = new InMemoryWorkerRegistryStore();
  const registration = new WorkerRegistrationService(store, clock.now);
  const prober = new WorkerHealthProber(store, registration, {
    adapters: {
      node: { probe: async () => ({ health: "healthy", availability: "available" }) },
    },
    now: clock.now,
  });
  return { clock, store, registration, prober, jobs: new InMemoryScheduledJobRepository() };
}

const job = (over: Partial<ScheduledJob> = {}) =>
  ({ id: "j", kind: WORKER_PROBE_JOB_KIND, payload: {} , ...over }) as ScheduledJob;
const context = { signal: new AbortController().signal };

describe("M6 worker probe schedule", () => {
  it("THE INTERVAL IS DERIVED from the evidence horizon, never guessed", () => {
    expect(DEFAULT_WORKER_PROBE_INTERVAL_MS).toBe(Math.floor(HEALTH_EVIDENCE_MAX_AGE_MS / 4));
    expect(DEFAULT_WORKER_PROBE_INTERVAL_MS).toBeLessThan(HEALTH_EVIDENCE_MAX_AGE_MS);
  });

  it("AN INTERVAL THAT CANNOT KEEP EVIDENCE FRESH IS REFUSED", () => {
    // At or above the horizon, evidence is always stale by the next sweep: the
    // fleet could never take work, and it would look like a routing bug.
    expect(() => assertProbeIntervalWithinHorizon(HEALTH_EVIDENCE_MAX_AGE_MS)).toThrow(
      /EXCEEDS_HORIZON/,
    );
    expect(() => assertProbeIntervalWithinHorizon(HEALTH_EVIDENCE_MAX_AGE_MS + 1)).toThrow(
      /EXCEEDS_HORIZON/,
    );
    expect(() => assertProbeIntervalWithinHorizon(0)).toThrow(/INVALID/);
    expect(() => assertProbeIntervalWithinHorizon(-1)).toThrow(/INVALID/);
    // A sane interval is accepted.
    expect(() => assertProbeIntervalWithinHorizon(1_000)).not.toThrow();
  });

  it("the handler refuses to be built with an unusable interval", () => {
    const h = harness();
    expect(() =>
      createWorkerProbeHandler({
        prober: h.prober,
        jobs: h.jobs,
        intervalMs: HEALTH_EVIDENCE_MAX_AGE_MS,
      }),
    ).toThrow(/EXCEEDS_HORIZON/);
  });

  it("THE SWEEP ACTUALLY PROBES: a registered worker becomes healthy", async () => {
    const h = harness();
    await h.registration.register({
      id: W1,
      workerKind: "agent",
      displayName: "w",
      capabilities: ["code-generation"],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });
    expect((await h.store.get(W1))!.health).toBe("unknown");

    const handler = createWorkerProbeHandler({
      prober: h.prober,
      jobs: h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });
    await handler(job(), context);

    expect((await h.store.get(W1))!.health).toBe("healthy");
  });

  it("RECURRENCE IS SELF-PERPETUATING: each sweep schedules the next one, durably", async () => {
    const h = harness();
    const handler = createWorkerProbeHandler({
      prober: h.prober,
      jobs: h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });

    await handler(job(), context);

    /*
     * The successor exists, at exactly now + interval. Asserted by trying to
     * enqueue that same occurrence: `created: false` means the handler already
     * created it. This is clock-independent — asserting "nothing is claimable yet"
     * would depend on the repository's own wall clock rather than on the handler.
     */
    const expectedNext = new Date(NOW.getTime() + 30_000);
    expect((await enqueueWorkerProbeSweep(h.jobs, expectedNext)).created).toBe(false);

    // A DIFFERENT instant is a different occurrence, so the chain can advance.
    expect(
      (await enqueueWorkerProbeSweep(h.jobs, new Date(NOW.getTime() + 60_000))).created,
    ).toBe(true);
  });

  it("REPLAY IS IDEMPOTENT: two sweeps at the same instant schedule ONE successor", async () => {
    const h = harness();
    const handler = createWorkerProbeHandler({
      prober: h.prober,
      jobs: h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });

    // The scheduler is at-least-once: the same job may run twice.
    await handler(job(), context);
    await handler(job(), context);

    const at = new Date(NOW.getTime() + 30_000);
    const again = await enqueueWorkerProbeSweep(h.jobs, at);
    // The occurrence already exists, so a third attempt creates nothing.
    expect(again.created).toBe(false);
  });

  it("PROBING TWICE IS HARMLESS: a replayed sweep does not corrupt evidence", async () => {
    const h = harness();
    await h.registration.register({
      id: W1,
      workerKind: "agent",
      displayName: "w",
      capabilities: ["code-generation"],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });
    const handler = createWorkerProbeHandler({
      prober: h.prober,
      jobs: h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });

    await handler(job(), context);
    const first = (await h.store.get(W1))!;
    await handler(job(), context);

    expect(await h.store.get(W1)).toEqual(first);
  });

  it("A LOST RECURRENCE IS A DEAD JOB, never silent success", async () => {
    const h = harness();
    const handler = createWorkerProbeHandler({
      prober: h.prober,
      jobs: {
        ...h.jobs,
        enqueue: vi.fn(async () => {
          throw new Error("DB_DOWN");
        }),
      } as unknown as typeof h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });

    // Stopping all probing silently would be catastrophic and invisible.
    await expect(handler(job(), context)).rejects.toBeInstanceOf(PermanentJobError);
  });

  it("A FAILING SWEEP IS RETRIED, not replaced by a successor", async () => {
    const h = harness();
    const enqueue = vi.fn(h.jobs.enqueue.bind(h.jobs));
    const handler = createWorkerProbeHandler({
      prober: {
        sweep: async () => {
          throw new Error("PROBE_INFRA_DOWN");
        },
      } as unknown as typeof h.prober,
      jobs: { ...h.jobs, enqueue } as unknown as typeof h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });

    await expect(handler(job(), context)).rejects.toThrow(/PROBE_INFRA_DOWN/);
    // No successor scheduled: the scheduler retries THIS job with its own backoff,
    // so one recurrence chain exists rather than two.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("ONCE PER FLEET: the durable scheduler runs the sweep under a lease, not per process", async () => {
    const h = harness();
    await h.registration.register({
      id: W1,
      workerKind: "agent",
      displayName: "w",
      capabilities: ["code-generation"],
      runtime: "node",
      runtimeSupport: "SUPPORTED_RUNTIME",
    });
    await enqueueWorkerProbeSweep(h.jobs, new Date(Date.now() - 1_000));

    /*
     * The successor is scheduled far ahead so it cannot be picked up in this same
     * test; only the ONE due occurrence is under test here.
     */
    const far = () => new Date(Date.now() + 3_600_000);
    const handlers = createSchedulerHandlers({
      ignite: {} as never,
      missions: { findById: async () => null } as never,
      wakeup: { wake: async () => undefined },
      workerProbe: { prober: h.prober, jobs: h.jobs, intervalMs: 30_000, now: far },
    });

    // Two schedulers sweep concurrently; the atomic claim serialises them, so the
    // fleet is probed once rather than once per process.
    const options = { maxJobsPerSweep: 1 };
    const [ra, rb] = await Promise.all([
      new DurableScheduler(h.jobs, handlers, options).sweep(),
      new DurableScheduler(h.jobs, handlers, options).sweep(),
    ]);

    expect(ra.discovered + rb.discovered).toBe(1);
    expect(ra.succeeded + rb.succeeded).toBe(1);
    expect((await h.store.get(W1))!.health).toBe("healthy");
  });

  it("a deployment that schedules probing with NO prober gets a permanent error", async () => {
    const handlers = createSchedulerHandlers({
      ignite: {} as never,
      missions: { findById: async () => null } as never,
      wakeup: { wake: async () => undefined },
      // workerProbe deliberately absent
    });

    await expect(handlers.probe_workers(job(), context)).rejects.toBeInstanceOf(PermanentJobError);
  });

  /*
   * GRID ALIGNMENT + IGNITION (M6.2).
   *
   * These use an INJECTED clock on purpose. The equivalent assertions at the
   * composition level could not distinguish a grid from `now + interval`: two boots
   * land in the same second, and the idempotency key is second-granular, so the
   * naive version deduplicated by accident. Only a controlled clock separates
   * "aligned to a shared grid" from "aligned to whoever asked first".
   */
  it("AN OCCURRENCE IS SNAPPED TO A SHARED GRID, not offset from the caller's clock", () => {
    // 12:00:07.500 with a 30s grid belongs to the bucket ending at 12:00:30 —
    // NOT at 12:00:37.500, which is where `now + interval` would put it.
    const unaligned = new Date("2026-09-27T12:00:07.500Z");
    expect(nextOccurrenceAt(unaligned, 30_000).toISOString()).toBe("2026-09-27T12:00:30.000Z");
    expect(nextOccurrenceAt(new Date("2026-09-27T12:00:29.999Z"), 30_000).toISOString()).toBe(
      "2026-09-27T12:00:30.000Z",
    );
    // Exactly on a boundary advances to the NEXT bucket, so a sweep never reschedules itself.
    expect(nextOccurrenceAt(new Date("2026-09-27T12:00:30.000Z"), 30_000).toISOString()).toBe(
      "2026-09-27T12:01:00.000Z",
    );
  });

  it("IGNITION IS IDEMPOTENT ACROSS RESTARTS: boots seconds apart share ONE occurrence", async () => {
    const h = harness();
    const at = (iso: string) => () => new Date(iso);

    // A boot, then a restart 7 seconds later — different instants, same bucket.
    const first = await seedWorkerProbeSweep(h.jobs, {
      intervalMs: 30_000,
      now: at("2026-09-27T12:00:01.000Z"),
    });
    const second = await seedWorkerProbeSweep(h.jobs, {
      intervalMs: 30_000,
      now: at("2026-09-27T12:00:08.000Z"),
    });

    expect(first.created).toBe(true);
    // THE kill for `now + interval`: that version would mint 12:00:31 and 12:00:38 —
    // two live chains, each invisible to the other, probing the fleet twice forever.
    expect(second.created).toBe(false);
    expect(second.at.toISOString()).toBe(first.at.toISOString());
    expect(first.at.toISOString()).toBe("2026-09-27T12:00:30.000Z");
  });

  it("the chain still ADVANCES: a boot in a later bucket ignites the next occurrence", async () => {
    const h = harness();
    const a = await seedWorkerProbeSweep(h.jobs, {
      intervalMs: 30_000,
      now: () => new Date("2026-09-27T12:00:01.000Z"),
    });
    const b = await seedWorkerProbeSweep(h.jobs, {
      intervalMs: 30_000,
      now: () => new Date("2026-09-27T12:00:45.000Z"),
    });

    // Idempotence must not become paralysis: a genuinely later bucket is a new link.
    expect(a.at.toISOString()).toBe("2026-09-27T12:00:30.000Z");
    expect(b.created).toBe(true);
    expect(b.at.toISOString()).toBe("2026-09-27T12:01:00.000Z");
  });

  it("THE HANDLER'S SUCCESSOR IS ON THE SAME GRID as ignition", async () => {
    const h = harness();
    h.clock.set(new Date("2026-09-27T12:00:07.500Z"));
    const handler = createWorkerProbeHandler({
      prober: h.prober,
      jobs: h.jobs,
      intervalMs: 30_000,
      now: h.clock.now,
    });

    await handler(job(), context);

    /*
     * A sweep running mid-bucket must schedule the bucket boundary, not
     * boundary + drift. Otherwise every retry or late claim would ratchet the chain
     * off the grid and a concurrent boot's seed would no longer deduplicate.
     */
    const onGrid = new Date("2026-09-27T12:00:30.000Z");
    expect((await enqueueWorkerProbeSweep(h.jobs, onGrid)).created).toBe(false);
    const drifted = new Date("2026-09-27T12:00:37.500Z");
    expect((await enqueueWorkerProbeSweep(h.jobs, drifted)).created).toBe(true);
  });
});
