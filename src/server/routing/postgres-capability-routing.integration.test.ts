import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { missionTasks, missions, tasks, workers } from "@/server/database/schema";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { InMemoryWorkerRegistry } from "@/server/services/worker-registry/in-memory-worker-registry";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import { IndependentReviewerSelector } from "@/server/autonomy/reviewer-independence";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import type {
  TaskExecutionDispatchInput,
  TaskExecutionDispatcher,
} from "@/server/execution/ports";

const DATABASE_URL = TEST_DATABASE_URL;

/*
 * M4 CAPABILITY ROUTING — durable evidence against a real PostgreSQL.
 *
 * Proves that `tasks.required_capabilities` (durable since 0041 but wired to
 * nothing) now actually controls worker eligibility and routing, and that the
 * decision is reproduced by a DIFFERENT process reading the same rows.
 *
 * Every "restart" here is a genuinely separate connection handle + a registry
 * re-hydrated from PostgreSQL: nothing is carried over in memory.
 */

/** Deterministic worker ids: the contract requires UUIDs, and order must be fixed. */
const RESEARCHER = "11111111-1111-4111-8111-111111111111";
const BUILDER = "22222222-2222-4222-8222-222222222222";
const TWIN_A = "33333333-3333-4333-8333-333333333333";
const TWIN_B = "44444444-4444-4444-8444-444444444444";

const handles: DatabaseHandle[] = [];

/** A fresh process: new connection handle, registry hydrated from PostgreSQL. */
async function restart(): Promise<{
  handle: DatabaseHandle;
  registry: InMemoryWorkerRegistry;
  router: CapabilityRouter;
  store: PostgresWorkerRegistryStore;
  registration: WorkerRegistrationService;
}> {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const registry = new InMemoryWorkerRegistry(await store.list());
  return {
    handle,
    registry,
    router: new CapabilityRouter(store),
    store,
    registration: new WorkerRegistrationService(store),
  };
}

function worker(over: Partial<WorkerRegistryEntry> & Pick<WorkerRegistryEntry, "id">): WorkerRegistryEntry {
  return {
    workerKind: "agent",
    displayName: "Worker",
    capabilities: [],
    features: [],
    supportsTools: true,
    supportsStructuredOutput: true,
    status: "active",
    runtime: "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    tags: [],
    metadata: {},
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    lastProbeAt: new Date().toISOString(),
    lastProbeOutcome: "ok",
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe("M4 capability routing on PostgreSQL", () => {
  const seed = createDatabase(DATABASE_URL);
  handles.push(seed);

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  });

  beforeEach(async () => {
    await seed.db.execute(sql.raw("TRUNCATE TABLE missions, tasks, workers RESTART IDENTITY CASCADE"));
  });

  describe("WORKERS_DURABLE_QUERYABLE (M4.2)", () => {
    it("a registered worker is readable back by a different process", async () => {
      const a = await restart();
      await a.store.upsert(
        worker({ id: RESEARCHER, workerKind: "hermes", capabilities: ["deep-research"] }),
      );

      const b = await restart();
      const read = await b.store.get(RESEARCHER);

      expect(read?.capabilities).toEqual(["deep-research"]);
      expect(read?.workerKind).toBe("hermes");
      expect(read?.health).toBe("healthy");
    });

    it("upsert updates in place rather than duplicating identity", async () => {
      const a = await restart();
      await a.store.upsert(worker({ id: RESEARCHER, capabilities: ["deep-research"] }));
      await a.store.upsert(worker({ id: RESEARCHER, capabilities: ["deep-research"], health: "unhealthy" }));

      const rows = await (await restart()).store.list();
      expect(rows).toHaveLength(1);
      expect(rows[0].health).toBe("unhealthy");
    });
  });

  describe("ELIGIBILITY_GATES_ON_REAL_ROWS (M4.3, M4.4)", () => {
    beforeEach(async () => {
      const { store } = await restart();
      await store.upsert(
        worker({ id: RESEARCHER, workerKind: "hermes", capabilities: ["deep-research"] }),
      );
    });

    it("routes to the worker holding the required capability", async () => {
      const { router } = await restart();
      const result = await router.route({ requiredCapabilities: ["deep-research"] });

      expect(result.decision).toBe("ROUTED");
      expect(result.worker?.id).toBe(RESEARCHER);
    });

    it("MISSING_CAPABILITY: refuses a capability nobody holds", async () => {
      const { router } = await restart();
      const result = await router.route({ requiredCapabilities: ["deep-research", "code-generation"] });

      expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
      expect(result.candidates[0].missingCapabilities).toEqual(["code-generation"]);
    });

    for (const [label, mutation] of [
      ["inactive", { status: "inactive" as const }],
      ["maintenance", { status: "maintenance" as const }],
      ["unhealthy", { health: "unhealthy" as const }],
      ["degraded", { health: "degraded" as const }],
      ["unavailable", { availability: "unavailable" as const }],
      ["declared-only runtime", { runtimeSupport: "DECLARED_ONLY" as const }],
    ] as const) {
      it(`refuses a durably ${label} worker`, async () => {
        const a = await restart();
        await a.store.upsert(
          worker({ id: RESEARCHER, workerKind: "hermes", capabilities: ["deep-research"], ...mutation }),
        );

        const { router } = await restart();
        expect((await router.route({ requiredCapabilities: ["deep-research"] })).decision).toBe(
          "NO_ELIGIBLE_WORKER",
        );
      });
    }
  });

  describe("UNKNOWN_FAILS_CLOSED (M4.5)", () => {
    it("a row inserted with only mandatory columns routes nothing", async () => {
      // Written straight to the table, bypassing the store — the database's own
      // defaults must already be the fail-closed state.
      await seed.db.insert(workers).values({
        id: BUILDER,
        workerKind: "agent",
        displayName: "Unprobed",
        capabilities: ["code-generation"],
        updatedAt: new Date(),
      });

      const { router, store } = await restart();
      const stored = await store.get(BUILDER);

      expect(stored?.status).toBe("inactive");
      expect(stored?.health).toBe("unknown");
      expect(stored?.availability).toBe("unknown");
      expect(stored?.runtimeSupport).toBe("UNKNOWN");

      const result = await router.route({ requiredCapabilities: ["code-generation"] });
      expect(result.decision).toBe("NO_ELIGIBLE_WORKER");
      expect(result.candidates[0].reasons).toEqual([
        "STATUS_NOT_ACTIVE",
        "RUNTIME_NOT_SUPPORTED",
        "HEALTH_NOT_HEALTHY",
        "NOT_AVAILABLE",
        // M5.2: such a row also carries no probe evidence.
        "HEALTH_EVIDENCE_MISSING",
      ]);
    });
  });

  describe("DETERMINISTIC_SELECTION (M4.6)", () => {
    it("indistinguishable workers resolve to the same one on every restart", async () => {
      const a = await restart();
      // Inserted in reverse id order on purpose: storage order must not decide.
      await a.store.upsert(worker({ id: TWIN_B, capabilities: ["code-generation"] }));
      await a.store.upsert(worker({ id: TWIN_A, capabilities: ["code-generation"] }));

      for (let i = 0; i < 3; i += 1) {
        const { router } = await restart();
        expect((await router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(TWIN_A);
      }
    });
  });

  describe("ROUTING_SURVIVES_RESTART (M4.8)", () => {
    it("a new process reaches the same decision from the same rows", async () => {
      const a = await restart();
      await a.store.upsert(worker({ id: TWIN_A, capabilities: ["code-generation"] }));
      await a.store.upsert(worker({ id: TWIN_B, capabilities: ["code-generation"] }));

      // a.router was hydrated BEFORE these upserts: the registry is a
      // boot-time snapshot by design, so the first authoritative read is the
      // next restart.
      const first = await restart();
      const before = await first.router.route({ requiredCapabilities: ["code-generation"] });
      await first.handle.close();
      await a.handle.close();

      const b = await restart();
      const after = await b.router.route({ requiredCapabilities: ["code-generation"] });

      expect(after.decision).toBe(before.decision);
      expect(after.worker?.id).toBe(before.worker?.id);
      expect(after.candidates).toEqual(before.candidates);
    });

    it("a durable health change REROUTES after restart — the DB really drives it", async () => {
      const a = await restart();
      await a.store.upsert(worker({ id: TWIN_A, capabilities: ["code-generation"] }));
      await a.store.upsert(worker({ id: TWIN_B, capabilities: ["code-generation"] }));
      expect((await a.router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(
        TWIN_A,
      );

      await a.store.upsert(
        worker({ id: TWIN_A, capabilities: ["code-generation"], health: "unhealthy" }),
      );

      const b = await restart();
      expect((await b.router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(TWIN_B);
    });
  });

  describe("LIVE_REGISTRY_READS (M5)", () => {
    it("a worker registered mid-process is routable immediately, with no restart", async () => {
      const a = await restart();

      expect((await a.router.route({ requiredCapabilities: ["deep-research"] })).decision).toBe(
        "ROUTING_UNCONFIGURED",
      );

      await a.store.upsert(
        worker({ id: RESEARCHER, workerKind: "hermes", capabilities: ["deep-research"] }),
      );

      // In M4 the router held a boot-time snapshot and this still said
      // ROUTING_UNCONFIGURED until the next container build.
      const after = await a.router.route({ requiredCapabilities: ["deep-research"] });
      expect(after.decision).toBe("ROUTED");
      expect(after.worker?.id).toBe(RESEARCHER);
    });

    it("a worker that goes unhealthy mid-process stops receiving work immediately", async () => {
      const a = await restart();
      await a.store.upsert(worker({ id: TWIN_A, capabilities: ["code-generation"] }));
      await a.store.upsert(worker({ id: TWIN_B, capabilities: ["code-generation"] }));
      expect((await a.router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(
        TWIN_A,
      );

      await a.store.upsert(
        worker({ id: TWIN_A, capabilities: ["code-generation"], health: "unhealthy" }),
      );

      // Same process, same router instance: the reroute is immediate.
      expect((await a.router.route({ requiredCapabilities: ["code-generation"] })).worker?.id).toBe(
        TWIN_B,
      );
    });

    it("the last healthy worker going down fails the route closed, in-process", async () => {
      const a = await restart();
      await a.store.upsert(worker({ id: TWIN_A, capabilities: ["code-generation"] }));
      expect((await a.router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
        "ROUTED",
      );

      await a.store.upsert(
        worker({ id: TWIN_A, capabilities: ["code-generation"], availability: "unavailable" }),
      );

      expect((await a.router.route({ requiredCapabilities: ["code-generation"] })).decision).toBe(
        "NO_ELIGIBLE_WORKER",
      );
    });
  });

  describe("REVIEWER_INDEPENDENCE_PRESERVED (M4.10)", () => {
    it("selects an independent, capable reviewer and never the producer", async () => {
      const a = await restart();
      await a.store.upsert(worker({ id: TWIN_A, capabilities: ["review"] }));
      await a.store.upsert(worker({ id: TWIN_B, workerKind: "other", capabilities: ["review"] }));

      const { registry } = await restart();

      const selected = new IndependentReviewerSelector(registry, TWIN_A, ["review"]).select();
      expect(selected.decision).toBe("SELECTED");
      expect(selected.reviewerWorkerId).toBe(TWIN_B);

      // The producer is the only remaining candidate -> refuse, never self-review.
      await a.store.upsert(
        worker({ id: TWIN_B, workerKind: "other", capabilities: ["review"], health: "unhealthy" }),
      );
      const solo = await restart();
      const refused = new IndependentReviewerSelector(solo.registry, TWIN_A, ["review"]).select();
      expect(refused.decision).toBe("NO_ELIGIBLE_REVIEWERS");
      expect(refused.reviewerWorkerId).toBeUndefined();
    });
  });

  describe("REGISTRATION_MAKES_ROUTING_LIVE (M5)", () => {
    it("register -> probe -> route, durably, and a restart keeps the result", async () => {
      const a = await restart();

      // Before anything registers, routing is genuinely not configured.
      expect((await a.router.route({ requiredCapabilities: ["deep-research"] })).decision).toBe(
        "ROUTING_UNCONFIGURED",
      );

      await a.registration.register({
        id: RESEARCHER,
        workerKind: "hermes",
        displayName: "Hermes CLI Worker",
        capabilities: ["deep-research"],
        runtime: "binary",
        runtimeSupport: "SUPPORTED_RUNTIME",
      });

      // Registered but unprobed: the registry is now authoritative and refuses.
      const unprobed = await a.router.route({ requiredCapabilities: ["deep-research"] });
      expect(unprobed.decision).toBe("NO_ELIGIBLE_WORKER");
      expect(unprobed.candidates[0].reasons).toEqual([
        "HEALTH_NOT_HEALTHY",
        "NOT_AVAILABLE",
        "HEALTH_EVIDENCE_MISSING",
      ]);

      await a.registration.probe(RESEARCHER, { health: "healthy", availability: "available" });
      expect((await a.router.route({ requiredCapabilities: ["deep-research"] })).worker?.id).toBe(
        RESEARCHER,
      );

      // A different process reads the same rows and agrees.
      await a.handle.close();
      const b = await restart();
      expect((await b.router.route({ requiredCapabilities: ["deep-research"] })).worker?.id).toBe(
        RESEARCHER,
      );
    });

    it("deactivate and deregister durably remove a worker from rotation", async () => {
      const a = await restart();
      await a.registration.register({
        id: RESEARCHER,
        workerKind: "hermes",
        displayName: "Hermes",
        capabilities: ["deep-research"],
        runtimeSupport: "SUPPORTED_RUNTIME",
      });
      await a.registration.probe(RESEARCHER, { health: "healthy", availability: "available" });

      await a.registration.deactivate(RESEARCHER);
      const afterDeactivate = await restart();
      expect(
        (await afterDeactivate.router.route({ requiredCapabilities: ["deep-research"] })).decision,
      ).toBe("NO_ELIGIBLE_WORKER");
      // The declaration and last probe survive for audit.
      expect((await afterDeactivate.store.get(RESEARCHER))?.health).toBe("healthy");

      expect(await a.registration.deregister(RESEARCHER)).toBe(true);
      const afterDeregister = await restart();
      expect(
        (await afterDeregister.router.route({ requiredCapabilities: ["deep-research"] })).decision,
      ).toBe("ROUTING_UNCONFIGURED");
    });
  });

  describe("SUPERVISOR_ROUTES_ON_DURABLE_CAPABILITIES (M4.1)", () => {
    const missionId = "m4-mission";
    const missionTaskId = "m4-mission-task";
    const taskId = "m4-task";

    async function seedMission(requiredCapabilities: string[], workerKind: string | null) {
      const now = new Date();
      await seed.db.insert(tasks).values({
        id: taskId,
        title: "Research the thing",
        description: "Research the thing",
        status: "draft",
        assignedAgentId: null,
        requiredCapabilities,
        createdAt: now,
        updatedAt: now,
      });
      await seed.db.insert(missions).values({
        id: missionId,
        title: "M4 mission",
        objective: "Prove capability routing",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      await seed.db.insert(missionTasks).values({
        id: missionTaskId,
        missionId,
        title: "Research the thing",
        description: "Research the thing",
        dependsOn: [],
        status: "draft",
        workerKind,
        capability: null,
        taskId,
        createdAt: now,
        updatedAt: now,
      });
    }

    async function supervisorOn(router: CapabilityRouter, handle: DatabaseHandle) {
      const taskRepo = new PostgresTaskRepository(handle.db);
      const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
        workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
      }));
      const supervisor = new SupervisorService(
        new PostgresMissionRepository(handle.db, taskRepo),
        taskRepo,
        { dispatch } as TaskExecutionDispatcher,
        new PostgresDurableMemory(handle.db),
        new PostgresDispatchAttemptRepository(handle.db),
        undefined,
        router,
      );
      return { supervisor, dispatch };
    }

    it("reads requiredCapabilities from the durable canonical task and dispatches the matching worker kind", async () => {
      await seedMission(["deep-research"], null);
      const a = await restart();
      await a.store.upsert(
        worker({ id: RESEARCHER, workerKind: "hermes", capabilities: ["deep-research"] }),
      );
      await a.store.upsert(
        worker({ id: BUILDER, workerKind: "openhands", capabilities: ["code-generation"] }),
      );

      const b = await restart();
      const { supervisor, dispatch } = await supervisorOn(b.router, b.handle);
      await supervisor.run(missionId);

      expect(dispatch).toHaveBeenCalledTimes(1);
      // The MissionTask declared NO workerKind. Routing derived it purely from
      // tasks.required_capabilities matched against the durable registry.
      expect(dispatch.mock.calls[0]?.[0].workerKind).toBe("hermes");
    });

    it("FAILS CLOSED: blocks, and does not dispatch, when no registered worker qualifies", async () => {
      await seedMission(["quantum-annealing"], null);
      const a = await restart();
      await a.store.upsert(
        worker({ id: BUILDER, workerKind: "openhands", capabilities: ["code-generation"] }),
      );

      const b = await restart();
      const { supervisor, dispatch } = await supervisorOn(b.router, b.handle);
      await supervisor.run(missionId);

      expect(dispatch).not.toHaveBeenCalled();
      const [row] = await seed.db.select().from(missionTasks);
      expect(row.status).toBe("blocked");
    });

    it("FAILS CLOSED when the only capable worker is durably unhealthy", async () => {
      await seedMission(["deep-research"], null);
      const a = await restart();
      await a.store.upsert(
        worker({
          id: RESEARCHER,
          workerKind: "hermes",
          capabilities: ["deep-research"],
          health: "unhealthy",
        }),
      );

      const b = await restart();
      const { supervisor, dispatch } = await supervisorOn(b.router, b.handle);
      await supervisor.run(missionId);

      expect(dispatch).not.toHaveBeenCalled();
    });

    it("M5 end to end: a registered+probed worker is what the supervisor dispatches to", async () => {
      await seedMission(["deep-research"], null);
      const a = await restart();
      await a.registration.register({
        id: RESEARCHER,
        workerKind: "hermes",
        displayName: "Hermes",
        capabilities: ["deep-research"],
        runtimeSupport: "SUPPORTED_RUNTIME",
      });

      const blocked = await supervisorOn(a.router, a.handle);
      await blocked.supervisor.run(missionId);
      // Registered but unprobed -> fail closed, no dispatch.
      expect(blocked.dispatch).not.toHaveBeenCalled();
      expect((await seed.db.select().from(missionTasks))[0].status).toBe("blocked");

      // Probe it, reset the task, and the same supervisor now dispatches.
      await a.registration.probe(RESEARCHER, { health: "healthy", availability: "available" });
      await seed.db.execute(sql.raw("UPDATE mission_tasks SET status = 'draft'"));

      const routed = await supervisorOn(a.router, a.handle);
      await routed.supervisor.run(missionId);
      expect(routed.dispatch).toHaveBeenCalledTimes(1);
      expect(routed.dispatch.mock.calls[0]?.[0].workerKind).toBe("hermes");
    });

    it("ROUTING_UNCONFIGURED: an empty registry dispatches exactly as before M4", async () => {
      await seedMission(["deep-research"], "agent");

      const b = await restart();
      const { supervisor, dispatch } = await supervisorOn(b.router, b.handle);
      await supervisor.run(missionId);

      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]?.[0].workerKind).toBe("agent");
    });

    it("honours the MissionTask workerKind as a hard filter alongside capabilities", async () => {
      await seedMission(["deep-research"], "openhands");
      const a = await restart();
      await a.store.upsert(
        worker({ id: RESEARCHER, workerKind: "hermes", capabilities: ["deep-research"] }),
      );

      const b = await restart();
      const { supervisor, dispatch } = await supervisorOn(b.router, b.handle);
      await supervisor.run(missionId);

      // hermes holds the capability but the task demands openhands: refuse.
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
