import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { WorkerHealthProber } from "@/server/services/worker-registry/worker-health-prober";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { CommandWorkerProbe } from "./command-worker-probe";
import { createWorkerProbeResolver } from "./probe-command-config";
import {
  enqueueWorkerProbeSweep,
  nextOccurrenceAt,
  seedWorkerProbeSweep,
} from "./worker-probe-schedule";

/*
 * M6.2 — THE AUTONOMOUS PROBE SWEEP ON REAL POSTGRESQL (second half of defect 16).
 *
 * M6.1 made the probe real; these prove something actually CALLS it, durably. The
 * distinction that matters here and cannot be made in memory: the claim is a real
 * atomic PostgreSQL transaction, and every "restart" below is a NEW connection
 * handle with new service instances, so nothing survives in process memory. What
 * carries the recurrence across a restart is rows, or nothing.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const W1 = "11111111-1111-4111-8111-111111111111";
const CAPABILITY = "code-generation";
const INTERVAL = 30_000;

const handles: DatabaseHandle[] = [];

/** A restart: new connection, new services, zero shared memory. */
function restart() {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const registration = new WorkerRegistrationService(store);
  const jobs = new PostgresScheduledJobRepository(handle.db);

  return {
    handle,
    store,
    jobs,
    registration,
    /* The REAL probe from M6.1: it runs this process's own Node runtime. */
    prober: new WorkerHealthProber(store, registration, {
      adapters: { node: new CommandWorkerProbe(createWorkerProbeResolver({})) },
      maxEvidenceAgeMs: 60_000,
    }),
  };
}

function schedulerFor(ctx: ReturnType<typeof restart>, now?: () => Date) {
  const handlers = createSchedulerHandlers({
    ignite: {} as never,
    missions: { findById: async () => null } as never,
    wakeup: { wake: async () => undefined },
    workerProbe: { prober: ctx.prober, jobs: ctx.jobs, intervalMs: INTERVAL, now },
  });
  return new DurableScheduler(ctx.jobs, handlers, { leaseMs: 30_000, maxJobsPerSweep: 1 });
}

const seed = restart();

async function registerWorker(ctx: ReturnType<typeof restart>) {
  await ctx.registration.register({
    id: W1,
    workerKind: "agent",
    displayName: W1,
    capabilities: [CAPABILITY],
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    maxConcurrency: 1,
  });
}

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("M6.2 durable worker probe schedule (PostgreSQL)", () => {
  beforeEach(async () => {
    await seed.handle.db.execute(
      sql.raw("TRUNCATE TABLE workers, scheduled_jobs RESTART IDENTITY CASCADE"),
    );
  });

  it("IGNITION IS DURABLE: the seeded occurrence is a row, readable by another process", async () => {
    const boot = restart();
    const { created, at } = await seedWorkerProbeSweep(boot.jobs, { intervalMs: INTERVAL });
    expect(created).toBe(true);

    // Read it back through a DIFFERENT connection: the chain lives in PostgreSQL.
    const other = restart();
    expect((await enqueueWorkerProbeSweep(other.jobs, at)).created).toBe(false);
  });

  it("THE CHAIN RUNS FOR REAL: a scheduler sweep probes a worker and schedules its successor", async () => {
    const ctx = restart();
    await registerWorker(ctx);
    expect((await ctx.store.get(W1))!.health).toBe("unknown");

    // Due now, so this sweep must pick it up.
    await enqueueWorkerProbeSweep(ctx.jobs, new Date(Date.now() - 1_000));

    const at = new Date("2026-09-27T12:00:07.500Z");
    const result = await schedulerFor(ctx, () => at).sweep();

    expect(result.discovered).toBe(1);
    expect(result.succeeded).toBe(1);

    /*
     * The verdict came from ACTUALLY RUNNING A PROCESS (M6.1's CommandWorkerProbe),
     * and it is durable: a brand-new connection sees it.
     */
    expect((await restart().store.get(W1))!.health).toBe("healthy");

    // The successor exists, on the grid — 12:00:30, not 12:00:37.5.
    const onGrid = nextOccurrenceAt(at, INTERVAL);
    expect(onGrid.toISOString()).toBe("2026-09-27T12:00:30.000Z");
    expect((await enqueueWorkerProbeSweep(restart().jobs, onGrid)).created).toBe(false);
  });

  it("RESTART DOES NOT FORK THE CHAIN: re-igniting after a restart adds no second recurrence", async () => {
    const first = restart();
    const a = await seedWorkerProbeSweep(first.jobs, {
      intervalMs: INTERVAL,
      now: () => new Date("2026-09-27T12:00:01.000Z"),
    });

    /*
     * A process dies and a replacement boots 7 seconds later — the case that would
     * silently double the fleet's probe rate if occurrences were offset from each
     * booter's own clock instead of snapped to a shared grid.
     */
    const second = restart();
    const b = await seedWorkerProbeSweep(second.jobs, {
      intervalMs: INTERVAL,
      now: () => new Date("2026-09-27T12:00:08.000Z"),
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.at.toISOString()).toBe(a.at.toISOString());

    /*
     * And the fleet holds exactly ONE link, not two: the seeded occurrence claims
     * once and then there is nothing left to claim. (Both boots used a fixed clock
     * whose instant is already past, so the occurrence is due here.)
     */
    const claimer = restart();
    const claimed = await claimer.jobs.claimDue("o1", 30_000);
    expect(claimed?.idempotencyKey).toBe(`probe_workers:${Math.floor(a.at.getTime() / 1_000)}`);
    expect(await claimer.jobs.claimDue("o2", 30_000)).toBeNull();
  });

  it("ONCE PER FLEET: two processes sweeping concurrently probe the fleet ONE time", async () => {
    const ctx = restart();
    await registerWorker(ctx);
    await enqueueWorkerProbeSweep(ctx.jobs, new Date(Date.now() - 1_000));

    /*
     * The real reason this is a job and not a setInterval. Two independent
     * processes, each with its own connection, race for the same occurrence; the
     * atomic claim in PostgreSQL — not a lock held in one process's memory — decides.
     * The successor is parked an hour out so neither sweep can also consume it.
     */
    const far = () => new Date(Date.now() + 3_600_000);
    const [ra, rb] = await Promise.all([
      schedulerFor(restart(), far).sweep(),
      schedulerFor(restart(), far).sweep(),
    ]);

    expect(ra.discovered + rb.discovered).toBe(1);
    expect(ra.succeeded + rb.succeeded).toBe(1);
    expect((await restart().store.get(W1))!.health).toBe("healthy");
  });

  it("THE DATABASE IS THE LAST GATE: an unknown job kind is refused by the CHECK constraint", async () => {
    /*
     * `probe_workers` was added to an ALLOW-list (migration 0045). Widening it must
     * not have turned it into a free-text column, or a typo'd kind would become a
     * job that no handler can ever run.
     */
    const insert = () =>
      seed.handle.db.execute(
        sql.raw(
          "INSERT INTO scheduled_jobs (id,kind,payload,payload_hash,idempotency_key,state,next_run_at) " +
            "VALUES (gen_random_uuid(),'probe_wrkers','{}'::jsonb,'h','k','scheduled',now())",
        ),
      );

    // The driver wraps the failure, so the constraint name travels in the cause.
    const error = await insert().then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).not.toBeNull();
    expect(`${error?.message} ${String(error?.cause ?? "")}`).toMatch(/scheduled_jobs_kind_check/);
  });
});
