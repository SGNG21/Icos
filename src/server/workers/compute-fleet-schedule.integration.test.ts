import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "@/config/env";
import type { Container } from "@/server/container";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { PostgresAuditRepository } from "@/server/repositories/postgres/audit-repository";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { DurableScheduler } from "@/server/scheduler/durable-scheduler";
import { PostgresScheduledJobRepository } from "@/server/scheduler/postgres-scheduled-job-repository";
import { createSchedulerHandlers } from "@/server/scheduler/scheduler-handlers";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { candidateWorkerId } from "@/server/workers/compute-fleet";
import {
  COMPUTE_RECONCILE_JOB_KIND,
  enqueueComputeFleetReconciliation,
  seedComputeFleetReconciliation,
} from "@/server/workers/compute-fleet-schedule";
import { bootstrapComputeFleetAtStartup } from "@/server/workers/startup-compute-bootstrap";

/*
 * PERIODIC COMPUTE FLEET RECONCILIATION on real PostgreSQL, against a FAKE OmniRoute (a local
 * HTTP server answering /v1/models — never the live gateway).
 *
 *  - a model the provider starts listing AFTER boot becomes a registered worker within ONE
 *    period, by the durable `reconcile_compute_fleet` chain, with no restart;
 *  - a model that disappears is NOT retired while it has no failing evidence, and is retired
 *    (audited) once it does — the boot guards, unchanged;
 *  - two processes sweeping the same due occurrence reconcile ONCE (the job lease);
 *  - with ICOS_COMPUTE_BOOTSTRAP off, an occurrence does nothing and schedules no successor.
 */

const INTERVAL = 60_000;
const CODEX = "codex/gpt-5.6-sol";
const NEMOTRON = "nvidia/nvidia/nemotron-3-ultra-550b-a55b";
const CLAUDE = "claude/claude-sonnet-5";

let listed: string[] = [];
let modelRequests = 0;
let server: Server;
let baseUrl: string;
const handles: DatabaseHandle[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/v1/models" && req.headers.authorization === "Bearer fake-omniroute-key") {
      modelRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: listed.map((id) => ({ id })) }));
      return;
    }
    res.writeHead(401).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.all(handles.map((h) => h.close()));
});

/** One process: its own connection, registry, audit and scheduler. */
function processFor(enabled: () => boolean = () => true) {
  const handle = createDatabase(TEST_DATABASE_URL);
  handles.push(handle);
  const workerRegistryStore = new PostgresWorkerRegistryStore(handle.db);
  const workerRegistration = new WorkerRegistrationService(workerRegistryStore);
  const audit = new PostgresAuditRepository(handle.db);
  const jobs = new PostgresScheduledJobRepository(handle.db);
  /* Exactly the fields the production reconciliation reads from the container. */
  const container = { workerRegistryStore, workerRegistration, audit } as unknown as Container;
  const env = {
    ICOS_COMPUTE_BOOTSTRAP: true,
    OMNIROUTE_BASE_URL: baseUrl,
    OMNIROUTE_API_KEY: "fake-omniroute-key",
  } as unknown as Env;
  const reconcile = vi.fn(() => bootstrapComputeFleetAtStartup(container, env, () => undefined));
  const handlers = createSchedulerHandlers({
    ignite: {} as never,
    missions: { findById: async () => null } as never,
    wakeup: { wake: async () => undefined },
    computeFleetReconcile: { reconcile, enabled, jobs, intervalMs: INTERVAL },
  });
  const scheduler = new DurableScheduler(jobs, handlers, { leaseMs: 30_000 });
  return {
    handle,
    workerRegistryStore,
    workerRegistration,
    jobs,
    container,
    env,
    reconcile,
    scheduler,
  };
}

async function reconcileJobs(handle: DatabaseHandle) {
  return (await handle.db.execute(
    sql`select state, next_run_at from scheduled_jobs where kind = ${COMPUTE_RECONCILE_JOB_KIND} order by next_run_at`,
  )) as unknown as Array<{ state: string; next_run_at: string }>;
}

describe("periodic compute fleet reconciliation (PostgreSQL)", () => {
  beforeEach(async () => {
    const h = createDatabase(TEST_DATABASE_URL);
    await h.db.execute(sql.raw("TRUNCATE TABLE workers, scheduled_jobs RESTART IDENTITY CASCADE"));
    await h.close();
    modelRequests = 0;
  });

  it("a newly listed model is registered within one period, without restart; a vanished one is retired only on failing evidence", async () => {
    const p = processFor();

    /* BOOT: the provider serves codex + nemotron. Then the chain is ignited, as at startup. */
    listed = [CODEX, NEMOTRON];
    expect(await bootstrapComputeFleetAtStartup(p.container, p.env, () => undefined)).toMatchObject(
      {
        status: "APPLIED",
      },
    );
    expect((await p.workerRegistryStore.list()).map((w) => w.id).sort()).toEqual(
      [candidateWorkerId(CODEX), candidateWorkerId(NEMOTRON)].sort(),
    );
    /* Seeded on the grid; `now` set one period back so this occurrence is already due. */
    const seeded = await seedComputeFleetReconciliation(p.jobs, {
      intervalMs: INTERVAL,
      now: () => new Date(Date.now() - 2 * INTERVAL),
    });
    expect(seeded.created).toBe(true);
    /* Re-seeding (another replica's boot) is a no-op: one chain. */
    expect(
      (
        await seedComputeFleetReconciliation(p.jobs, {
          intervalMs: INTERVAL,
          now: () => new Date(Date.now() - 2 * INTERVAL),
        })
      ).created,
    ).toBe(false);

    /* AFTER BOOT the provider starts serving Claude. No restart: the next occurrence runs. */
    listed = [CODEX, NEMOTRON, CLAUDE];
    const sweep = await p.scheduler.sweep();
    expect(sweep).toMatchObject({ discovered: 1, succeeded: 1, failed: 0 });
    expect(p.reconcile).toHaveBeenCalledTimes(1);
    const claude = await p.workerRegistryStore.get(candidateWorkerId(CLAUDE));
    expect(claude).toMatchObject({
      displayName: `compute:${CLAUDE}`,
      status: "active",
      /* Registered, never asserted healthy: the probe sweep decides. */
      health: "unknown",
    });
    /* …and the chain continues: exactly one future occurrence is scheduled. */
    const chain = await reconcileJobs(p.handle);
    expect(chain.map((j) => j.state)).toEqual(["succeeded", "scheduled"]);
    expect(Date.parse(chain[1]!.next_run_at)).toBeGreaterThan(Date.now());

    /* NEMOTRON DISAPPEARS. It was never probed: no failing evidence ⇒ not retired. */
    listed = [CODEX, CLAUDE];
    await enqueueComputeFleetReconciliation(p.jobs, new Date(Date.now() - 1_000));
    expect(await p.scheduler.sweep()).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await p.workerRegistryStore.get(candidateWorkerId(NEMOTRON)))!.status).toBe("active");

    /* A healthy peer, and a FAILED probe on the vanished model: now it is retired, audited. */
    await p.workerRegistration.probe(candidateWorkerId(CODEX), {
      health: "healthy",
      availability: "available",
    });
    await p.workerRegistration.probe(candidateWorkerId(NEMOTRON), {
      health: "unhealthy",
      availability: "unavailable",
      outcome: "failed",
      errorClass: "UNAVAILABLE",
    });
    await enqueueComputeFleetReconciliation(p.jobs, new Date(Date.now() - 2_000));
    expect(await p.scheduler.sweep()).toMatchObject({ succeeded: 1, failed: 0 });
    expect((await p.workerRegistryStore.get(candidateWorkerId(NEMOTRON)))!.status).not.toBe(
      "active",
    );
    const retired = (await p.handle.db.execute(
      sql`select details from audit_entries where event_type = 'worker.fleet.retired' and details->>'workerId' = ${candidateWorkerId(NEMOTRON)}`,
    )) as unknown as unknown[];
    expect(retired).toHaveLength(1);
    /* The proven peer kept its evidence through every pass (unchanged ⇒ not rewritten). */
    expect((await p.workerRegistryStore.get(candidateWorkerId(CODEX)))!.health).toBe("healthy");
  });

  it("SINGLE-FLIGHT: two processes sweeping the same due occurrence reconcile once", async () => {
    const a = processFor();
    const b = processFor();
    listed = [CODEX, CLAUDE];
    await enqueueComputeFleetReconciliation(a.jobs, new Date(Date.now() - 1_000));

    await Promise.all([a.scheduler.sweep(), b.scheduler.sweep()]);

    expect(a.reconcile.mock.calls.length + b.reconcile.mock.calls.length).toBe(1);
    expect(modelRequests).toBe(1);
    expect((await a.workerRegistryStore.list()).map((w) => w.id).sort()).toEqual(
      [candidateWorkerId(CODEX), candidateWorkerId(CLAUDE)].sort(),
    );
    /* One successor, not two: the grid key deduplicates. */
    expect((await reconcileJobs(a.handle)).filter((j) => j.state === "scheduled")).toHaveLength(1);
  });

  it("ICOS_COMPUTE_BOOTSTRAP off: an occurrence does nothing and the chain stops", async () => {
    const p = processFor(() => false);
    listed = [CODEX, CLAUDE];
    await enqueueComputeFleetReconciliation(p.jobs, new Date(Date.now() - 1_000));

    expect(await p.scheduler.sweep()).toMatchObject({ succeeded: 1 });
    expect(p.reconcile).not.toHaveBeenCalled();
    expect(modelRequests).toBe(0);
    expect(await p.workerRegistryStore.list()).toEqual([]);
    expect((await reconcileJobs(p.handle)).map((j) => j.state)).toEqual(["succeeded"]);
  });
});
