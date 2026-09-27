import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { workers } from "@/server/database/schema";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { WorkerRegistrationService } from "./worker-registration-service";
import { WorkerHealthProber, type WorkerHealthProbePort } from "./worker-health-prober";
import { CapabilityRouter } from "@/server/routing/capability-router";

/*
 * M5.2 HEALTH PROBING — durable evidence against a real PostgreSQL.
 *
 * The properties under test are DURABILITY properties, so an in-memory store
 * cannot prove any of them: every "restart" below is a genuinely new connection
 * handle reading the same rows, with nothing carried over in memory.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];

function clockAt(iso: string) {
  let current = iso;
  return { now: () => new Date(current), set: (next: string) => void (current = next) };
}

const healthyAdapter: WorkerHealthProbePort = {
  probe: async () => ({ health: "healthy", availability: "available" }),
};

/** A fresh process: new handle, new store, new service instances. */
function restart(clock: { now: () => Date }, adapters: Record<string, WorkerHealthProbePort> = {}) {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const registration = new WorkerRegistrationService(store, clock.now);
  return {
    store,
    registration,
    prober: new WorkerHealthProber(store, registration, {
      adapters,
      maxEvidenceAgeMs: 60_000,
      now: clock.now,
    }),
    router: new CapabilityRouter(store, {
      now: clock.now,
      healthEvidenceMaxAgeMs: 60_000,
    }),
  };
}

async function register(registration: WorkerRegistrationService, id: string, kind = "agent") {
  await registration.register({
    id,
    workerKind: kind,
    displayName: id,
    capabilities: [CAPABILITY],
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
  });
}

describe("M5.2 worker health probing on PostgreSQL", () => {
  const seed = createDatabase(DATABASE_URL);
  handles.push(seed);

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  });

  beforeEach(async () => {
    await seed.db.execute(sql.raw("TRUNCATE TABLE workers RESTART IDENTITY CASCADE"));
  });

  it("MIGRATION_0043_APPLIED: probe evidence columns exist with fail-closed defaults", async () => {
    const rows = await seed.db.execute(sql`
      select column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_name = 'workers' and column_name in ('last_probe_at','last_probe_outcome')
      order by column_name
    `);

    expect(rows).toHaveLength(2);
    const byName = Object.fromEntries((rows as unknown as Record<string, string>[]).map((r) => [r.column_name, r]));
    expect(byName.last_probe_at.is_nullable).toBe("YES");
    expect(byName.last_probe_outcome.column_default).toContain("never");
  });

  it("LEGACY_SAFE: a pre-0043 row (mandatory columns only) reads back as never-probed", async () => {
    await seed.db.execute(sql`
      insert into workers (id, worker_kind, display_name, updated_at)
      values (${W1}, 'agent', 'legacy worker', now())
    `);

    const entry = (await restart(clockAt("2026-09-27T12:00:00.000Z")).store.get(W1))!;

    expect(entry.lastProbeAt).toBeNull();
    expect(entry.lastProbeOutcome).toBe("never");
    expect(entry.health).toBe("unknown");
    expect(entry.status).toBe("inactive");
  });

  it("HEALTH_PROBING_PROVEN: probing makes a registered worker routable, durably", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, { agent: healthyAdapter });
    await register(a.registration, W1);

    // Registered but unprobed: fail closed, with the reason recorded.
    const before = await a.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(before.decision).toBe("NO_ELIGIBLE_WORKER");
    expect(before.candidates[0].reasons).toContain("HEALTH_EVIDENCE_MISSING");

    await a.prober.probeAll();

    // A DIFFERENT process routes to it, reading only the durable rows.
    const b = restart(clock);
    const after = await b.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(after.decision).toBe("ROUTED");
    expect(after.worker?.id).toBe(W1);
  });

  it("PROBE_EVIDENCE_IS_DURABLE: the timestamp and outcome survive the process", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, { agent: healthyAdapter });
    await register(a.registration, W1);
    await a.prober.probeAll();

    const reread = (await restart(clock).store.get(W1))!;
    expect(reread.lastProbeOutcome).toBe("ok");
    expect(reread.lastProbeAt).toBe("2026-09-27T12:00:00.000Z");
  });

  it("STALE_HEALTH_FAIL_CLOSED: a healthy worker stops being routed once evidence ages out", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, { agent: healthyAdapter });
    await register(a.registration, W1);
    await a.prober.probeAll();
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe("ROUTED");

    // The worker's session dies. Nothing probes it; only time passes.
    clock.set("2026-09-27T12:02:00.000Z");

    const refused = await a.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(refused.decision).toBe("NO_ELIGIBLE_WORKER");
    expect(refused.candidates[0].reasons).toContain("HEALTH_EVIDENCE_STALE");
  });

  it("CRASHED_WORKER_IS_DURABLY_INVALIDATED: expiry rewrites the stored row, not just a verdict", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, { agent: healthyAdapter });
    await register(a.registration, W1);
    await a.prober.probeAll();

    clock.set("2026-09-27T12:05:00.000Z");
    expect(await a.prober.expireStaleEvidence()).toEqual([W1]);

    const [row] = (await seed.db
      .select({ health: workers.health, outcome: workers.lastProbeOutcome })
      .from(workers)) as { health: string; outcome: string }[];
    expect(row.health).toBe("unknown");
    expect(row.outcome).toBe("stale");
  });

  it("PROCESS_RESTART_CANNOT_RESTORE_HEALTHY: a cold process refuses aged evidence", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, { agent: healthyAdapter });
    await register(a.registration, W1);
    await a.prober.probeAll();

    // Hours later, a brand new process with no memory of anything.
    const later = clockAt("2026-09-27T18:00:00.000Z");
    const cold = restart(later);
    expect((await cold.store.get(W1))!.health).toBe("healthy"); // stored claim survives
    const routed = await cold.router.route({ requiredCapabilities: [CAPABILITY] });

    expect(routed.decision).toBe("NO_ELIGIBLE_WORKER"); // but buys nothing
    expect(routed.candidates[0].reasons).toContain("HEALTH_EVIDENCE_STALE");
  });

  it("PROBE_FAILURE_DOES_NOT_SILENTLY_PASS: a failing runtime is stored unhealthy + failed", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, {
      agent: {
        probe: async () => {
          throw new Error("RUNTIME_UNREACHABLE");
        },
      },
    });
    await register(a.registration, W1);
    await a.prober.probeAll();

    const reread = (await restart(clock).store.get(W1))!;
    expect(reread.health).toBe("unhealthy");
    expect(reread.availability).toBe("unavailable");
    expect(reread.lastProbeOutcome).toBe("failed");
  });

  it("UNPROBEABLE_KIND_FAILS_CLOSED: no adapter means unsupported, never routable", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, {}); // the container's real default: no adapters yet
    await register(a.registration, W1, "hermes");
    await a.prober.probeAll();

    const reread = (await restart(clock).store.get(W1))!;
    expect(reread.lastProbeOutcome).toBe("unsupported");
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("UNDATABLE_EVIDENCE_IS_REJECTED_AT_THE_DB: 'ok' without a timestamp cannot be stored", async () => {
    const rejection = await seed.db
      .execute(
        sql`
        insert into workers (id, worker_kind, display_name, health, last_probe_outcome, updated_at)
        values (${W1}, 'agent', 'undatable', 'healthy', 'ok', now())
      `,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).not.toBeNull();
    // The driver nests the Postgres error; the CONSTRAINT is what we are proving.
    const constraint = (rejection as { cause?: { constraint_name?: string } })?.cause
      ?.constraint_name;
    expect(constraint).toBe("workers_probe_evidence_dated_check");
    expect(await seed.db.select().from(workers)).toHaveLength(0);
  });

  it("selective expiry: a refreshed worker keeps its evidence while a dead one loses its", async () => {
    const clock = clockAt("2026-09-27T12:00:00.000Z");
    const a = restart(clock, { agent: healthyAdapter });
    await register(a.registration, W1);
    await register(a.registration, W2);
    await a.prober.probeAll();

    // W2's runtime disappears; only W1 can still be probed.
    clock.set("2026-09-27T12:05:00.000Z");
    const partial = restart(clock, {
      agent: {
        probe: async (worker) => {
          if (worker.id === W2) throw new Error("GONE");
          return { health: "healthy", availability: "available" };
        },
      },
    });
    await partial.prober.sweep();

    const routed = await partial.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(routed.decision).toBe("ROUTED");
    expect(routed.worker?.id).toBe(W1);
    expect((await partial.store.get(W2))!.health).toBe("unhealthy");
  });
});
