import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import {
  assertSafeTestDatabaseUrl,
  TEST_DATABASE_URL,
} from "@/server/database/test-database-guard";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import {
  applyComputeBootstrap,
  DEFAULT_COMPUTE_CAPABILITIES,
  planComputeBootstrap,
} from "@/server/workers/compute-bootstrap";
import { candidateWorkerId } from "@/server/workers/compute-fleet";

/*
 * LIVE WORKER FLEET BOOTSTRAP, against a real PostgreSQL.
 *
 * The unit suite proves the planner's arithmetic. Only a real database can prove the
 * claim this lane actually makes: that a RESTART — a new connection handle, nothing
 * carried in memory — neither duplicates a worker nor destroys the probe evidence that
 * makes the fleet routable. Every "restart" below is a fresh handle on purpose.
 *
 * No live write: the test guard refuses any database whose name is not a test database.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const SERVED = [
  "claude/claude-sonnet-5",
  "codex/gpt-5.6-sol",
  "nvidia/nvidia/nemotron-3-ultra-550b-a55b",
];
const OPTIONS = { runtime: "binary" as const, capabilities: [...DEFAULT_COMPUTE_CAPABILITIES] };
const SONNET = candidateWorkerId("claude/claude-sonnet-5");

const handles: DatabaseHandle[] = [];

/** A RESTART: a brand-new handle, store and service. Durable state is the only carrier. */
async function restart() {
  const db = await createDatabase(DATABASE_URL);
  handles.push(db);
  const store = new PostgresWorkerRegistryStore(db.db);
  return {
    store,
    registration: new WorkerRegistrationService(store),
    router: new CapabilityRouter(store),
    boot: async (listed: readonly string[] = SERVED) => {
      const plan = planComputeBootstrap({
        source: "https://gateway.invalid",
        listed,
        existing: await store.list(),
        options: OPTIONS,
      });
      return {
        plan,
        result: await applyComputeBootstrap(new WorkerRegistrationService(store), plan),
      };
    },
  };
}

beforeEach(async () => {
  const db = await createDatabase(DATABASE_URL);
  await db.db.execute(sql.raw("TRUNCATE TABLE workers RESTART IDENTITY CASCADE"));
  await db.close();
});

afterAll(async () => {
  await Promise.all(handles.map((h) => h.close()));
});

describe("durable compute fleet bootstrap", () => {
  it("NO_TEST_DB_TO_LIVE_COPY: the guard refuses the live database by name", () => {
    expect(() => assertSafeTestDatabaseUrl(DATABASE_URL)).not.toThrow();
    expect(() => assertSafeTestDatabaseUrl("postgres://localhost:5432/icos_n23_probe")).toThrow(
      /TEST_DATABASE_UNSAFE/,
    );
  });

  it("WORKER_BOOTSTRAP_IDEMPOTENT + NO_DUPLICATE_WORKERS across three restarts", async () => {
    const first = await restart();
    const initial = await first.boot();
    expect(initial.result.registered.length).toBe(SERVED.length);

    const second = await restart();
    const again = await second.boot();
    const third = await restart();
    const third_ = await third.boot();

    expect(again.result.registered).toEqual([]);
    expect(third_.result.registered).toEqual([]);
    const rows = await (await restart()).store.list();
    expect(rows.length).toBe(SERVED.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(SERVED.length);
  });

  it("WORKER_BOOTSTRAP_RESTART_SAFE: probe evidence survives a boot, and routing with it", async () => {
    const boot1 = await restart();
    await boot1.boot();
    await boot1.registration.probe(SONNET, { health: "healthy", availability: "available" });
    const before = await boot1.store.get(SONNET);
    expect((await boot1.router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "ROUTED",
    );

    /* The process restarts and bootstraps again, as it does on every boot. */
    const boot2 = await restart();
    const result = await boot2.boot();

    expect(result.result.registered).toEqual([]);
    expect(result.result.updated).toEqual([]);
    expect(result.plan.unchanged.map((p) => p.id)).toContain(SONNET);
    const after = await boot2.store.get(SONNET);
    expect(after?.health).toBe("healthy");
    expect(after?.lastProbeOutcome).toBe("ok");
    expect(after?.lastProbeAt).toEqual(before?.lastProbeAt);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    /* COMPUTE_ROUTING_AFTER_REGISTRATION, read back through a new connection. */
    const routed = await boot2.router.route({ requiredCapabilities: ["code_editing"] });
    expect(routed.decision).toBe("ROUTED");
    expect(routed.worker?.id).toBe(SONNET);
  });

  it("HEALTH_UNKNOWN_NOT_HEALTHY: a durably bootstrapped fleet routes nothing until probed", async () => {
    const boot = await restart();
    await boot.boot();

    const rows = await (await restart()).store.list();
    for (const row of rows) {
      expect(row.health).toBe("unknown");
      expect(row.availability).toBe("unknown");
      expect(row.lastProbeAt).toBeNull();
      expect(row.lastProbeOutcome).toBe("never");
    }
    expect((await boot.router.route({ requiredCapabilities: ["code_editing"] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("CAPACITY_RECONCILIATION: capacity changes in place and survives the restart", async () => {
    await (await restart()).boot();

    const rescale = await restart();
    const plan = planComputeBootstrap({
      source: "https://gateway.invalid",
      listed: SERVED,
      existing: await rescale.store.list(),
      options: { ...OPTIONS, maxConcurrency: 3 },
    });
    await applyComputeBootstrap(rescale.registration, plan);

    const rows = await (await restart()).store.list();
    expect(rows.length).toBe(SERVED.length);
    for (const row of rows) {
      expect(row.maxConcurrency).toBe(3);
      expect(row.capacityPool).toMatch(/^provider:/);
      /* A changed declaration resets evidence: new declaration, new proof required. */
      expect(row.lastProbeOutcome).toBe("never");
    }
  });

  it("a durably DISABLED worker is never re-enabled by a boot", async () => {
    const boot = await restart();
    await boot.boot();
    await boot.registration.deactivate(SONNET);
    const disabled = await boot.store.get(SONNET);

    const second = await restart();
    const applied = await second.boot();

    expect(applied.plan.disabled.map((d) => d.id)).toContain(SONNET);
    expect(applied.result.registered).toEqual([]);
    expect(applied.result.updated).toEqual([]);
    expect(applied.result.skippedDisabled).toContain(SONNET);
    expect(await (await restart()).store.get(SONNET)).toEqual(disabled);
  });

  it("a withdrawn model is reported, not written: status stays the prober's and DISABLE_WORKER's", async () => {
    const gone = candidateWorkerId("codex/gpt-5.6-sol");
    const boot = await restart();
    await boot.boot();
    await boot.registration.probe(gone, { health: "healthy", availability: "available" });
    const before = await (await restart()).store.list();

    const next = await restart();
    const applied = await next.boot(SERVED.filter((m) => m !== "codex/gpt-5.6-sol"));

    expect(applied.plan.orphan.map((o) => o.id)).toEqual([gone]);
    expect(await (await restart()).store.list()).toEqual(before);
    expect((await (await restart()).store.get(gone))?.status).toBe("active");
  });

  it("DRY_RUN_NO_WRITE: planning against the real registry writes nothing", async () => {
    await (await restart()).boot();
    const before = await (await restart()).store.list();

    const observer = await restart();
    const plan = planComputeBootstrap({
      source: "https://gateway.invalid",
      listed: [...SERVED, "claude/claude-opus-5"],
      existing: await observer.store.list(),
      options: OPTIONS,
    });

    expect(plan.register.map((p) => p.model)).toEqual(["claude/claude-opus-5"]);
    expect(plan.unchanged.length).toBe(SERVED.length);
    expect(await (await restart()).store.list()).toEqual(before);
  });
});
