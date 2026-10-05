import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { WorkerCapacityExceededError } from "@/core/contracts/dispatch-attempt";
import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks } from "@/server/database/schema";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { identities, type TestIdentity } from "@/test/test-identity";
import type { TaskExecutionDispatchInput, TaskExecutionDispatcher } from "@/server/execution/ports";

/*
 * M5.3 / M5.5 — DURABLE DISTRIBUTION AND CAPACITY against a real PostgreSQL.
 *
 * Distribution, capacity and concurrency are all DURABILITY properties: an
 * in-memory store can prove none of them. Every "restart" below is a genuinely
 * new connection handle and a new set of service instances reading the same rows.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const W3 = "33333333-3333-4333-8333-333333333333";
const CAPABILITY = "code-generation";

const handles: DatabaseHandle[] = [];

function clockAt(iso: string) {
  let current = iso;
  return { now: () => new Date(current), set: (next: string) => void (current = next) };
}

const NOW = "2026-09-27T12:00:00.000Z";

/** A fresh process: new handle, new repositories, new router. */
function restart(clock = clockAt(NOW)) {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const router = new CapabilityRouter(store, {
    now: clock.now,
    healthEvidenceMaxAgeMs: 60_000,
    activeAssignments: () => ledger.listActiveWorkerAssignments(),
  });
  const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));

  return {
    handle,
    clock,
    store,
    ledger,
    taskRepo,
    router,
    dispatch,
    supervisor: new SupervisorService(
      new PostgresMissionRepository(handle.db, taskRepo),
      taskRepo,
      { dispatch } as TaskExecutionDispatcher,
      new PostgresDurableMemory(handle.db),
      ledger,
      undefined,
      router,
    ),
  };
}

/** A fully eligible worker: active, supported, healthy, available, freshly probed. */
function worker(
  over: Partial<WorkerRegistryEntry> & Pick<WorkerRegistryEntry, "id">,
): WorkerRegistryEntry {
  return {
    workerKind: "agent",
    displayName: over.id,
    capabilities: [CAPABILITY],
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
    lastProbeAt: NOW,
    lastProbeOutcome: "ok",
    maxConcurrency: 1,
    capacityPool: null,
    capacityPoolLimit: null,
    updatedAt: NOW,
    ...over,
  };
}

/**
 * IDENTITY PER CASE, not per file.
 *
 * These were fixed constants, which was harmless while mission work ran on the in-process
 * executor — each case built its own executor, so two cases sharing a task id could not
 * see each other. `DURABLE_MISSION_TASK` is orchestrated by Temporal now, and a Temporal
 * workflow id is GLOBAL to the namespace and OUTLIVES the execution that used it, so
 * `icos-task-<taskId>` is a name shared by every case in this file, every rerun of it, and
 * every process running it at once.
 *
 * Nothing here cleans Temporal, deliberately: correctness must not depend on a cleanup
 * step a crashed run never reaches. A fresh namespace per run makes leftover state
 * irrelevant rather than merely unlikely.
 *
 * Registered FIRST, so the hooks below that seed from these ids see this case's values.
 * Within a case every id is deterministic, so the business assertions stay exactly as
 * exact as they were; a RETRIED case gets a new namespace instead of colliding with its
 * own first run.
 */
const FILE_IDENTITIES = identities("m5");
let caseNumber = 0;
let ids: TestIdentity;

let MISSION_ID: string;

beforeEach(() => {
  caseNumber += 1;
  ids = FILE_IDENTITIES.forCase(`c${caseNumber}`);
  MISSION_ID = ids.mission();
});

/**
 * Seeds one mission with `count` INDEPENDENT ready tasks.
 * Returns the missionTask ids, in creation order.
 */
async function seedIndependentTasks(handle: DatabaseHandle, count: number): Promise<string[]> {
  const now = new Date();
  await handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "M5 mission",
    objective: "Prove multi-worker orchestration",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });

  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const taskId = `m5-task-${i}`;
    const missionTaskId = `m5-mission-task-${i}`;
    await handle.db.insert(tasks).values({
      id: taskId,
      title: `Task ${i}`,
      description: `Task ${i}`,
      status: "draft",
      assignedAgentId: null,
      requiredCapabilities: [CAPABILITY],
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(missionTasks).values({
      id: missionTaskId,
      missionId: MISSION_ID,
      title: `Task ${i}`,
      description: `Task ${i}`,
      dependsOn: [],
      status: "draft",
      workerKind: null,
      capability: null,
      taskId,
      createdAt: now,
      updatedAt: now,
    });
    ids.push(missionTaskId);
  }

  return ids;
}

/** Durable assignment record: which worker each attempt went to. */
async function assignments(handle: DatabaseHandle) {
  return handle.db
    .select({
      missionTaskId: dispatchAttempts.missionTaskId,
      workerId: dispatchAttempts.workerId,
      state: dispatchAttempts.state,
    })
    .from(dispatchAttempts)
    .orderBy(asc(dispatchAttempts.missionTaskId));
}

describe("M5.3/M5.5 durable distribution and capacity on PostgreSQL", () => {
  const seed = createDatabase(DATABASE_URL);
  handles.push(seed);

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  });

  beforeEach(async () => {
    await seed.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts RESTART IDENTITY CASCADE",
      ),
    );
  });

  describe("M5.3 durable distribution", () => {
    it("MULTIWORKER_DISTRIBUTION_PROVEN: 10 ready tasks and 3 workers do not all go to one worker", async () => {
      const a = restart();
      for (const id of [W1, W2, W3]) {
        await a.store.upsert(worker({ id }));
      }
      await seedIndependentTasks(a.handle, 10);

      await a.supervisor.run(MISSION_ID);

      const rows = await assignments(a.handle);
      const used = new Set(rows.map((r) => r.workerId));

      // Before M5.3 this was exactly one worker holding all the work.
      expect(used.size).toBe(3);
      expect(rows).toHaveLength(3); // one concurrent slot each; the rest wait
      // and every dispatched attempt names the worker it was assigned to.
      expect(rows.every((r) => r.workerId !== null)).toBe(true);
    });

    it("DURABLE_WORKER_LOAD_PROVEN: load is counted from the ledger, by a different process", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1, maxConcurrency: 2 }));
      await a.store.upsert(worker({ id: W2, maxConcurrency: 2 }));
      await seedIndependentTasks(a.handle, 3);
      await a.supervisor.run(MISSION_ID);

      // A fresh process derives the same load from the same rows.
      const b = restart();
      const load = await b.ledger.listActiveWorkerAssignments();

      expect(load).toHaveLength(3);
      expect(load.filter((id) => id === W1)).toHaveLength(2);
      expect(load.filter((id) => id === W2)).toHaveLength(1);
    });

    it("no task is assigned to an UNHEALTHY worker even when it is the least loaded", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1, health: "unhealthy" })); // idle
      await a.store.upsert(worker({ id: W2 }));
      await seedIndependentTasks(a.handle, 2);

      await a.supervisor.run(MISSION_ID);

      const rows = await assignments(a.handle);
      expect(rows.map((r) => r.workerId)).toEqual([W2]);
    });

    it("no task is assigned to an UNAVAILABLE worker even when it is the least loaded", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1, availability: "unavailable" }));
      await a.store.upsert(worker({ id: W2 }));
      await seedIndependentTasks(a.handle, 2);

      await a.supervisor.run(MISSION_ID);

      expect((await assignments(a.handle)).map((r) => r.workerId)).toEqual([W2]);
    });

    it("CAPABILITY_ROUTING_PRESERVED: distribution never relaxes the capability constraint", async () => {
      const a = restart();
      // W1 is idle but cannot do the work; W2 can.
      await a.store.upsert(worker({ id: W1, capabilities: ["deep-research"] }));
      await a.store.upsert(worker({ id: W2, capabilities: [CAPABILITY] }));
      await seedIndependentTasks(a.handle, 2);

      await a.supervisor.run(MISSION_ID);

      expect((await assignments(a.handle)).map((r) => r.workerId)).toEqual([W2]);
    });

    it("STALE_WORKERS_CANNOT_KEEP_RECEIVING_WORK: aged evidence stops distribution", async () => {
      const clock = clockAt(NOW);
      const a = restart(clock);
      await a.store.upsert(worker({ id: W1 }));
      await a.store.upsert(worker({ id: W2 }));
      await seedIndependentTasks(a.handle, 4);

      // Evidence for both workers expires before any dispatch happens.
      clock.set("2026-09-27T12:05:00.000Z");
      await a.supervisor.run(MISSION_ID);

      expect(await assignments(a.handle)).toHaveLength(0);
      const states = await a.handle.db.select({ status: missionTasks.status }).from(missionTasks);
      expect(states.every((row) => row.status === "blocked")).toBe(true);
    });

    it("PROCESS_RESTART_PROVEN: a fresh process continues the SAME distribution", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1, maxConcurrency: 1 }));
      await a.store.upsert(worker({ id: W2, maxConcurrency: 1 }));
      await seedIndependentTasks(a.handle, 4);

      await a.supervisor.run(MISSION_ID);
      const afterFirst = await assignments(a.handle);
      expect(afterFirst).toHaveLength(2);
      await a.handle.close();

      // Both slots are still held, so a brand-new process must dispatch nothing
      // more rather than restarting its rotation and oversubscribing.
      const b = restart();
      await b.supervisor.run(MISSION_ID).catch(() => undefined);

      const afterRestart = await assignments(b.handle);
      expect(afterRestart).toHaveLength(2);
      expect(afterRestart.map((r) => r.workerId).sort()).toEqual(
        afterFirst.map((r) => r.workerId).sort(),
      );
    });

    it("a freed slot is reused: completing work makes the worker eligible again", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1 }));
      await seedIndependentTasks(a.handle, 2);

      await a.supervisor.run(MISSION_ID);
      const first = await assignments(a.handle);
      expect(first).toHaveLength(1);

      // The execution finishes: its attempt leaves the non-terminal states.
      await a.ledger.markCompletedByWorkflowId(
        workflowIdForAttempt(first[0].missionTaskId.replace("mission-task", "task"), 1),
      );

      expect(await a.ledger.listActiveWorkerAssignments()).toEqual([]);
    });
  });

  describe("M5.5 capacity model", () => {
    it("CAPACITY_POOL: two workers sharing one account quota cannot multiply it", async () => {
      const a = restart();
      await a.store.upsert(
        worker({ id: W1, capacityPool: "account-x", capacityPoolLimit: 1, maxConcurrency: 5 }),
      );
      await a.store.upsert(
        worker({ id: W2, capacityPool: "account-x", capacityPoolLimit: 1, maxConcurrency: 5 }),
      );
      await seedIndependentTasks(a.handle, 4);

      await a.supervisor.run(MISSION_ID);

      // Both workers have four free slots each; the POOL has one.
      expect(await assignments(a.handle)).toHaveLength(1);
    });

    it("a pool ceiling above 1 admits exactly that many concurrent executions", async () => {
      const a = restart();
      await a.store.upsert(
        worker({ id: W1, capacityPool: "account-x", capacityPoolLimit: 2, maxConcurrency: 5 }),
      );
      await a.store.upsert(
        worker({ id: W2, capacityPool: "account-x", capacityPoolLimit: 2, maxConcurrency: 5 }),
      );
      await seedIndependentTasks(a.handle, 5);

      await a.supervisor.run(MISSION_ID);

      const rows = await assignments(a.handle);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.workerId)).size).toBe(2); // one each
    });

    it("the database refuses a pool limit with no pool", async () => {
      const rejection = await seed.db
        .execute(
          sql`insert into workers (id, worker_kind, display_name, capacity_pool_limit, updated_at)
              values (${W1}, 'agent', 'bad', 3, now())`,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect((rejection as { cause?: { constraint_name?: string } })?.cause?.constraint_name).toBe(
        "workers_capacity_pool_limit_check",
      );
    });

    it("the database refuses a non-positive concurrency", async () => {
      const rejection = await seed.db
        .execute(
          sql`insert into workers (id, worker_kind, display_name, max_concurrency, updated_at)
              values (${W1}, 'agent', 'bad', 0, now())`,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect((rejection as { cause?: { constraint_name?: string } })?.cause?.constraint_name).toBe(
        "workers_max_concurrency_check",
      );
    });
  });

  describe("M5.3 atomic capacity enforcement", () => {
    it("ATOMIC_MULTIWORKER_DISPATCH_PROVEN: concurrent prepares cannot oversubscribe one worker", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1, maxConcurrency: 1 }));
      const [taskA, taskB] = await seedIndependentTasks(a.handle, 2);

      // Both deciders read the same load snapshot (worker idle) and both pick W1.
      // Only the durable transaction can arbitrate.
      const outcomes = await Promise.allSettled([
        a.ledger.prepare({
          missionId: MISSION_ID,
          missionTaskId: taskA,
          taskId: "m5-task-0",
          attempt: 1,
          workflowId: workflowIdForAttempt("m5-task-0", 1),
          prompt: "a",
          workerKind: "agent",
          workerId: W1,
        }),
        a.ledger.prepare({
          missionId: MISSION_ID,
          missionTaskId: taskB,
          taskId: "m5-task-1",
          attempt: 1,
          workflowId: workflowIdForAttempt("m5-task-1", 1),
          prompt: "b",
          workerKind: "agent",
          workerId: W1,
        }),
      ]);

      const acquired = outcomes.filter((o) => o.status === "fulfilled" && o.value.acquired).length;
      const refused = outcomes.filter(
        (o) => o.status === "rejected" && o.reason instanceof WorkerCapacityExceededError,
      ).length;

      expect(acquired).toBe(1);
      expect(refused).toBe(1);
      // And the refusal left NO durable trace: exactly one attempt exists.
      expect(await assignments(a.handle)).toHaveLength(1);
    });

    it("the capacity refusal is atomic: a rejected prepare leaves the MissionTask ready", async () => {
      const a = restart();
      await a.store.upsert(worker({ id: W1, maxConcurrency: 1 }));
      const [taskA, taskB] = await seedIndependentTasks(a.handle, 2);

      await a.ledger.prepare({
        missionId: MISSION_ID,
        missionTaskId: taskA,
        taskId: "m5-task-0",
        attempt: 1,
        workflowId: workflowIdForAttempt("m5-task-0", 1),
        prompt: "a",
        workerId: W1,
      });

      await expect(
        a.ledger.prepare({
          missionId: MISSION_ID,
          missionTaskId: taskB,
          taskId: "m5-task-1",
          attempt: 1,
          workflowId: workflowIdForAttempt("m5-task-1", 1),
          prompt: "b",
          workerId: W1,
        }),
      ).rejects.toBeInstanceOf(WorkerCapacityExceededError);

      const [blocked] = await a.handle.db
        .select({ status: missionTasks.status })
        .from(missionTasks)
        .where(eq(missionTasks.id, taskB));
      expect(blocked.status).toBe("draft"); // untouched, still ready for a later tick
    });

    it("an UNREGISTERED worker assignment is refused rather than silently unbounded", async () => {
      const a = restart();
      const [taskA] = await seedIndependentTasks(a.handle, 1);

      await expect(
        a.ledger.prepare({
          missionId: MISSION_ID,
          missionTaskId: taskA,
          taskId: "m5-task-0",
          attempt: 1,
          workflowId: workflowIdForAttempt("m5-task-0", 1),
          prompt: "a",
          workerId: W3,
        }),
      ).rejects.toBeInstanceOf(WorkerCapacityExceededError);
    });

    it("SAFE_PARALLELISM_PROVEN: two concurrent supervisors dispatch each task exactly once", async () => {
      const a = restart();
      const b = restart();
      for (const id of [W1, W2, W3]) {
        await a.store.upsert(worker({ id }));
      }
      await seedIndependentTasks(a.handle, 3);

      await Promise.all([
        a.supervisor.run(MISSION_ID).catch(() => undefined),
        b.supervisor.run(MISSION_ID).catch(() => undefined),
      ]);

      const rows = await assignments(a.handle);
      // One attempt per task, and no worker holding two.
      expect(rows).toHaveLength(3);
      expect(new Set(rows.map((r) => r.missionTaskId)).size).toBe(3);
      expect(new Set(rows.map((r) => r.workerId)).size).toBe(3);
    });
  });
});
