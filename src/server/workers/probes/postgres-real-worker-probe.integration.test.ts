import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, sql } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@/server/database/client";
import { dispatchAttempts, missionTasks, missions, tasks, workers } from "@/server/database/schema";
import { PostgresWorkerRegistryStore } from "@/server/repositories/postgres/worker-registry-store";
import { PostgresDispatchAttemptRepository } from "@/server/repositories/postgres/dispatch-attempt-repository";
import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
import { PostgresTaskRepository } from "@/server/repositories/postgres/task-repository";
import { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";
import { WorkerRegistrationService } from "@/server/services/worker-registry/worker-registration-service";
import {
  WorkerHealthProber,
  type WorkerHealthProbePort,
} from "@/server/services/worker-registry/worker-health-prober";
import { CapabilityRouter } from "@/server/routing/capability-router";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { LocalTaskExecutionDispatcher } from "@/server/execution/local-task-execution-dispatcher";
import { PostgresTaskExecutionResultRepository } from "@/server/repositories/postgres/task-execution-result-repository";
import { PostgresReviewDecisionRepository } from "@/server/repositories/postgres/review-decision-repository";
import { InMemoryReviewerService } from "@/server/review/in-memory-reviewer-service";
import { recordMissionTaskExecution } from "@/server/usecases/record-mission-task-execution";
import { workflowIdForAttempt } from "@/server/execution/workflow-id";
import { readFile, rm } from "node:fs/promises";
import { CommandWorkerProbe } from "./command-worker-probe";
import { createWorkerProbeResolver } from "./probe-command-config";
import type {
  TaskExecutionDispatchInput,
  TaskExecutionDispatcher,
} from "@/server/execution/ports";

/*
 * M6 — REAL worker probing and REAL multi-worker distribution, on real
 * PostgreSQL (defect 16).
 *
 * The difference from M5: the health verdicts here are produced by ACTUALLY
 * RUNNING A PROCESS, not by a stub. Every restart is a new connection handle with
 * new service instances, so nothing is carried in memory.
 */

const DATABASE_URL = TEST_DATABASE_URL;
const W1 = "11111111-1111-4111-8111-111111111111";
const W2 = "22222222-2222-4222-8222-222222222222";
const CAPABILITY = "code-generation";
const MISSION_ID = "m6-mission";

const handles: DatabaseHandle[] = [];

function clockAt(iso: string) {
  let current = iso;
  return { now: () => new Date(current), set: (next: string) => void (current = next) };
}

const NOW = "2026-09-27T12:00:00.000Z";

/** The REAL probe: runs this process's own Node runtime, non-interactively. */
function realNodeProbe(): WorkerHealthProbePort {
  return new CommandWorkerProbe(createWorkerProbeResolver({}));
}

/** A REAL probe that runs a process which genuinely fails. */
function realFailingProbe(): WorkerHealthProbePort {
  return new CommandWorkerProbe(() => ({
    command: process.execPath,
    args: ["-e", "process.stderr.write('worker refused'); process.exit(4)"],
  }));
}

function restart(
  clock = clockAt(NOW),
  adapters: Partial<Record<"node" | "docker" | "binary" | "wasm" | "unknown", WorkerHealthProbePort>> = {
    node: realNodeProbe(),
  },
) {
  const handle = createDatabase(DATABASE_URL);
  handles.push(handle);
  const store = new PostgresWorkerRegistryStore(handle.db);
  const ledger = new PostgresDispatchAttemptRepository(handle.db);
  const taskRepo = new PostgresTaskRepository(handle.db);
  const registration = new WorkerRegistrationService(store, clock.now);
  const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
    workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
  }));

  const missionRepo = new PostgresMissionRepository(handle.db, taskRepo);
  const durableMemory = new PostgresDurableMemory(handle.db);

  return {
    handle,
    clock,
    store,
    ledger,
    taskRepo,
    missionRepo,
    durableMemory,
    executionResults: new PostgresTaskExecutionResultRepository(handle.db),
    reviewDecisions: new PostgresReviewDecisionRepository(handle.db),
    registration,
    dispatch,
    prober: new WorkerHealthProber(store, registration, {
      adapters,
      maxEvidenceAgeMs: 60_000,
      now: clock.now,
    }),
    router: new CapabilityRouter(store, {
      now: clock.now,
      healthEvidenceMaxAgeMs: 60_000,
      activeAssignments: () => ledger.listActiveWorkerAssignments(),
    }),
    supervisor: new SupervisorService(
      missionRepo,
      taskRepo,
      { dispatch } as TaskExecutionDispatcher,
      durableMemory,
      ledger,
      undefined,
      new CapabilityRouter(store, {
        now: clock.now,
        healthEvidenceMaxAgeMs: 60_000,
        activeAssignments: () => ledger.listActiveWorkerAssignments(),
      }),
    ),
  };
}

async function registerReal(
  registration: WorkerRegistrationService,
  id: string,
  over: { runtime?: "node" | "docker"; maxConcurrency?: number } = {},
) {
  await registration.register({
    id,
    workerKind: "agent",
    displayName: id,
    capabilities: [CAPABILITY],
    runtime: over.runtime ?? "node",
    runtimeSupport: "SUPPORTED_RUNTIME",
    maxConcurrency: over.maxConcurrency ?? 1,
  });
}

async function seedTasks(handle: DatabaseHandle, count: number): Promise<string[]> {
  const now = new Date();
  await handle.db.insert(missions).values({
    id: MISSION_ID,
    title: "M6 mission",
    objective: "Prove real worker orchestration",
    status: "running",
    createdAt: now,
    updatedAt: now,
  });

  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    await handle.db.insert(tasks).values({
      id: `m6-task-${i}`,
      title: `Task ${i}`,
      description: `ECHO:task-${i}`,
      status: "draft",
      assignedAgentId: null,
      requiredCapabilities: [CAPABILITY],
      createdAt: now,
      updatedAt: now,
    });
    await handle.db.insert(missionTasks).values({
      id: `m6-mt-${i}`,
      missionId: MISSION_ID,
      title: `Task ${i}`,
      description: `ECHO:task-${i}`,
      dependsOn: [],
      status: "draft",
      workerKind: null,
      capability: null,
      taskId: `m6-task-${i}`,
      createdAt: now,
      updatedAt: now,
    });
    ids.push(`m6-mt-${i}`);
  }
  return ids;
}

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

/** Completes one task through the REAL canonical completion path. */
async function completeCanonically(p: ReturnType<typeof restart>, taskId: string): Promise<void> {
  const workflowId = workflowIdForAttempt(taskId, 1);
  const completedAt = new Date().toISOString();

  await p.executionResults.record({
    taskId,
    workflowId,
    outcome: "success",
    result: "done",
    completedAt,
  });

  await recordMissionTaskExecution(
    {
      executionResults: p.executionResults,
      supervisor: p.supervisor,
      missions: p.missionRepo,
      tasks: p.taskRepo,
      reviewer: new InMemoryReviewerService(),
      reviewDecisions: p.reviewDecisions,
      durableMemory: p.durableMemory,
      dispatchAttempts: p.ledger,
    },
    { missionId: MISSION_ID, taskId, workflowId, outcome: "success", result: "done", completedAt },
  );
}

describe("M6 real worker probing on PostgreSQL", () => {
  const seed = createDatabase(DATABASE_URL);
  handles.push(seed);

  afterAll(async () => {
    await Promise.all(handles.map((h) => h.close().catch(() => {})));
  });

  beforeEach(async () => {
    await seed.db.execute(
      sql.raw(
        "TRUNCATE TABLE missions, tasks, workers, dispatch_attempts, task_execution_results, decisions, checkpoints, context_items RESTART IDENTITY CASCADE",
      ),
    );
  });

  it("REAL_PROBE_UNKNOWN_TO_HEALTHY: only an actually-executed probe makes a worker routable", async () => {
    const a = restart();
    await registerReal(a.registration, W1);

    // Registered. Nothing has been run, so nothing is known.
    const before = (await a.store.get(W1))!;
    expect(before.health).toBe("unknown");
    expect(before.lastProbeOutcome).toBe("never");
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );

    // A REAL child process runs here.
    const [record] = await a.prober.probeAll();
    expect(record.outcome).toBe("ok");

    const after = (await a.store.get(W1))!;
    expect(after.health).toBe("healthy");
    expect(after.availability).toBe("available");
    expect(after.lastProbeOutcome).toBe("ok");
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).worker?.id).toBe(W1);
  });

  it("REAL_PROBE_FAILURE: a process that exits non-zero yields unhealthy + unavailable", async () => {
    const a = restart(clockAt(NOW), { node: realFailingProbe() });
    await registerReal(a.registration, W1);

    const [record] = await a.prober.probeAll();

    expect(record.outcome).toBe("failed");
    expect(record.error).toMatch(/WORKER_PROBE_EXIT_4/);
    expect(record.error).toMatch(/worker refused/);

    const stored = (await a.store.get(W1))!;
    expect(stored.health).toBe("unhealthy");
    expect(stored.availability).toBe("unavailable");
    expect(stored.lastProbeOutcome).toBe("failed");
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("ADAPTER_FAILURE_IS_FAIL_CLOSED: an unconfigured runtime is refused, never assumed fine", async () => {
    // Only the node runtime is probeable out of the box; this worker declares docker.
    const a = restart();
    await registerReal(a.registration, W1, { runtime: "docker" });

    const [record] = await a.prober.probeAll();

    // No adapter registered for docker at all -> unsupported, not a silent pass.
    expect(record.outcome).toBe("unsupported");
    expect((await a.store.get(W1))!.health).toBe("unknown");
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("an adapter that IS registered but cannot resolve the runtime fails LOUDLY", async () => {
    // docker has an adapter, but the resolver has no docker command: that is a
    // configuration defect and must be visible as a failure, not as "never".
    const a = restart(clockAt(NOW), { docker: realNodeProbe() });
    await registerReal(a.registration, W1, { runtime: "docker" });

    const [record] = await a.prober.probeAll();

    expect(record.outcome).toBe("failed");
    expect(record.error).toMatch(/WORKER_PROBE_UNRESOLVED/);
    expect((await a.store.get(W1))!.health).toBe("unhealthy");
  });

  it("DURABLE_EVIDENCE_SURVIVES_RESTART: another process routes on the real verdict", async () => {
    const a = restart();
    await registerReal(a.registration, W1);
    await a.prober.probeAll();
    await a.handle.close();

    const cold = restart();
    const reread = (await cold.store.get(W1))!;

    expect(reread.health).toBe("healthy");
    expect(reread.lastProbeAt).toBe(NOW);
    expect((await cold.router.route({ requiredCapabilities: [CAPABILITY] })).worker?.id).toBe(W1);
  });

  it("RESTART_DOES_NOT_RESTORE_HEALTH: aged real evidence is refused by a cold process", async () => {
    const clock = clockAt(NOW);
    const a = restart(clock);
    await registerReal(a.registration, W1);
    await a.prober.probeAll();
    await a.handle.close();

    // Hours later, a brand new process.
    const later = clockAt("2026-09-27T18:00:00.000Z");
    const cold = restart(later);
    const routed = await cold.router.route({ requiredCapabilities: [CAPABILITY] });

    expect(routed.decision).toBe("NO_ELIGIBLE_WORKER");
    expect(routed.candidates[0].reasons).toContain("HEALTH_EVIDENCE_STALE");

    // And a sweep in that process makes the DURABLE row agree.
    await cold.prober.expireStaleEvidence();
    const [row] = await seed.db
      .select({ health: workers.health, outcome: workers.lastProbeOutcome })
      .from(workers);
    expect(row.health).toBe("unknown");
    expect(row.outcome).toBe("stale");
  });

  it("STALE_EVIDENCE_EXPIRES even though the real probe once succeeded", async () => {
    const clock = clockAt(NOW);
    const a = restart(clock);
    await registerReal(a.registration, W1);
    await a.prober.probeAll();
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe("ROUTED");

    clock.set("2026-09-27T12:05:00.000Z");
    expect(await a.prober.expireStaleEvidence()).toEqual([W1]);
    expect((await a.router.route({ requiredCapabilities: [CAPABILITY] })).decision).toBe(
      "NO_ELIGIBLE_WORKER",
    );
  });

  it("ROUTING_REFUSES_UNKNOWN_UNHEALTHY_UNAVAILABLE, each with its own recorded reason", async () => {
    const a = restart();
    await registerReal(a.registration, W1);

    // 1. unknown (registered, never probed)
    let routed = await a.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(routed.candidates[0].reasons).toContain("HEALTH_EVIDENCE_MISSING");

    // 2. unhealthy (real failing probe)
    const failing = restart(a.clock, { node: realFailingProbe() });
    await failing.prober.probeAll();
    routed = await a.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(routed.candidates[0].reasons).toContain("HEALTH_NOT_HEALTHY");
    expect(routed.candidates[0].reasons).toContain("NOT_AVAILABLE");

    // 3. healthy but withdrawn
    await a.prober.probeAll();
    await a.registration.deactivate(W1);
    routed = await a.router.route({ requiredCapabilities: [CAPABILITY] });
    expect(routed.candidates[0].reasons).toContain("STATUS_NOT_ACTIVE");
    expect(routed.decision).toBe("NO_ELIGIBLE_WORKER");
  });

  describe("REAL multi-worker distribution over really-probed workers", () => {
    it("two REALLY PROBED workers take two independent tasks, one each", async () => {
      const a = restart();
      await registerReal(a.registration, W1);
      await registerReal(a.registration, W2);
      await seedTasks(a.handle, 2);

      // Both verdicts come from actual child processes.
      const records = await a.prober.probeAll();
      expect(records.map((r) => r.outcome)).toEqual(["ok", "ok"]);

      await a.supervisor.run(MISSION_ID);

      const rows = await assignments(a.handle);
      expect(rows).toHaveLength(2);
      expect([rows[0].workerId, rows[1].workerId].sort()).toEqual([W1, W2]);
    });

    it("DURABLE_LOAD_UPDATES: the count follows the ledger as work is assigned", async () => {
      const a = restart();
      await registerReal(a.registration, W1, { maxConcurrency: 2 });
      await registerReal(a.registration, W2, { maxConcurrency: 2 });
      await a.prober.probeAll();
      await seedTasks(a.handle, 3);

      expect(await a.ledger.listActiveWorkerAssignments()).toEqual([]);
      await a.supervisor.run(MISSION_ID);

      const load = await a.ledger.listActiveWorkerAssignments();
      expect(load).toHaveLength(3);
      expect(load.filter((id) => id === W1)).toHaveLength(2);
      expect(load.filter((id) => id === W2)).toHaveLength(1);

      // And a DIFFERENT process derives the same numbers.
      expect(await restart().ledger.listActiveWorkerAssignments()).toEqual(load);
    });

    it("an UNPROBED worker takes nothing while its probed peer takes the work", async () => {
      const a = restart();
      await registerReal(a.registration, W1); // will be probed
      await registerReal(a.registration, W2); // will NOT be probed
      await seedTasks(a.handle, 2);

      // Probe W1 only.
      await a.registration.probe(W1, { health: "healthy", availability: "available" });
      await a.supervisor.run(MISSION_ID);

      const rows = await assignments(a.handle);
      expect(rows).toHaveLength(1);
      expect(rows[0].workerId).toBe(W1);
    });

    it("DEPENDENCY_UNLOCKS_EXACTLY_ONCE over really-probed workers", async () => {
      const a = restart();
      await registerReal(a.registration, W1);
      await registerReal(a.registration, W2);
      await a.prober.probeAll();

      // A and B independent; C depends on both.
      await seedTasks(a.handle, 2);
      const now = new Date();
      await a.handle.db.insert(tasks).values({
        id: "m6-task-c",
        title: "Task C",
        description: "ECHO:task-c",
        status: "draft",
        assignedAgentId: null,
        requiredCapabilities: [CAPABILITY],
        createdAt: now,
        updatedAt: now,
      });
      await a.handle.db.insert(missionTasks).values({
        id: "m6-mt-c",
        missionId: MISSION_ID,
        title: "Task C",
        description: "ECHO:task-c",
        dependsOn: ["m6-mt-0", "m6-mt-1"],
        status: "draft",
        workerKind: null,
        capability: null,
        taskId: "m6-task-c",
        createdAt: now,
        updatedAt: now,
      });

      await a.supervisor.run(MISSION_ID);
      const parents = await assignments(a.handle);
      expect(parents).toHaveLength(2);
      expect(new Set(parents.map((r) => r.workerId)).size).toBe(2);
      // C is gated while both parents are in flight.
      expect(parents.some((r) => r.missionTaskId === "m6-mt-c")).toBe(false);

      for (const taskId of ["m6-task-0", "m6-task-1"]) {
        await completeCanonically(a, taskId);
      }

      // Run repeatedly AND concurrently: unlock is a derivation, not an event.
      await Promise.all([
        a.supervisor.run(MISSION_ID).catch(() => undefined),
        restart().supervisor.run(MISSION_ID).catch(() => undefined),
        a.supervisor.run(MISSION_ID).catch(() => undefined),
      ]);

      const cRows = (await assignments(a.handle)).filter((r) => r.missionTaskId === "m6-mt-c");
      expect(cRows).toHaveLength(1);
      expect(cRows[0].workerId).not.toBeNull();
    });

    it("REAL_EXECUTION_ON_TWO_WORKERS: both tasks really run and write real output", async () => {
      const outputs = ["m6-real-0.txt", "m6-real-1.txt"];
      await Promise.all(outputs.map((f) => rm(`/tmp/icos/${f}`, { force: true })));

      const a = restart();
      await registerReal(a.registration, W1);
      await registerReal(a.registration, W2);
      await a.prober.probeAll();

      // Two independent tasks whose prompts cause REAL side effects.
      const now = new Date();
      await a.handle.db.insert(missions).values({
        id: MISSION_ID,
        title: "M6 real execution",
        objective: "Prove real work on two workers",
        status: "running",
        createdAt: now,
        updatedAt: now,
      });
      for (const [i, file] of outputs.entries()) {
        const prompt = `WRITE_FILE:${file}:done-${i}`;
        await a.handle.db.insert(tasks).values({
          id: `m6-real-task-${i}`,
          title: `Real ${i}`,
          description: prompt,
          status: "draft",
          assignedAgentId: null,
          requiredCapabilities: [CAPABILITY],
          createdAt: now,
          updatedAt: now,
        });
        await a.handle.db.insert(missionTasks).values({
          id: `m6-real-mt-${i}`,
          missionId: MISSION_ID,
          title: `Real ${i}`,
          description: prompt,
          dependsOn: [],
          status: "draft",
          workerKind: null,
          capability: null,
          taskId: `m6-real-task-${i}`,
          createdAt: now,
          updatedAt: now,
        });
      }

      /*
       * The real dispatcher executes the prompt AND reports completion through the
       * canonical path, which calls back into the supervisor — so the two are
       * mutually dependent. The holder breaks the construction cycle without
       * weakening either side.
       */
      const holder: { current?: TaskExecutionDispatcher } = {};
      const supervisor = new SupervisorService(
        a.missionRepo,
        a.taskRepo,
        { dispatch: (input) => holder.current!.dispatch(input) } as TaskExecutionDispatcher,
        a.durableMemory,
        a.ledger,
        undefined,
        a.router,
      );
      holder.current = new LocalTaskExecutionDispatcher(
        a.executionResults,
        a.missionRepo,
        a.taskRepo,
        supervisor,
        a.durableMemory,
      );

      await supervisor.run(MISSION_ID);

      // Real side effects on disk, one per task.
      for (const [i, file] of outputs.entries()) {
        await expect(readFile(`/tmp/icos/${file}`, "utf8")).resolves.toBe(`done-${i}`);
      }

      // And the two tasks landed on two DIFFERENT really-probed workers.
      const rows = (await assignments(a.handle)).filter((r) =>
        r.missionTaskId.startsWith("m6-real-mt-"),
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.workerId)).size).toBe(2);

      await Promise.all(outputs.map((f) => rm(`/tmp/icos/${f}`, { force: true })));
    });

    it("NO_OVERSUBSCRIPTION_RACE: concurrent supervisors over 2 real workers assign 2 tasks, 1 each", async () => {
      const a = restart();
      await registerReal(a.registration, W1);
      await registerReal(a.registration, W2);
      await a.prober.probeAll();
      await seedTasks(a.handle, 2);

      const b = restart();
      await Promise.all([
        a.supervisor.run(MISSION_ID).catch(() => undefined),
        b.supervisor.run(MISSION_ID).catch(() => undefined),
      ]);

      const rows = await assignments(a.handle);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.missionTaskId)).size).toBe(2);
      expect(new Set(rows.map((r) => r.workerId)).size).toBe(2);
    });
  });
});
