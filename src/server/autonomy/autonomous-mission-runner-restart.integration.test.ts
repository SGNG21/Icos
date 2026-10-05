import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sql } from "drizzle-orm";

import type { Mission, MissionTask } from "@/core/mission/contracts";

import { createDatabase } from "@/server/database/client";

import { autonomousMissionRuntime, missions } from "@/server/database/schema";

import {
  AutonomousMissionRunner,
  type AutonomousMissionPlanner,
  type AutonomousSupervisor,
} from "@/server/autonomy/autonomous-mission-runner";

import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";

import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";

import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";

import type { AutonomousMissionRunnerResult } from "@/server/autonomy/autonomous-mission-runner";

const DATABASE_URL = TEST_DATABASE_URL;

class ManualLeaseRenewalTimer {
  private nowMs = 0;

  private nextId = 1;

  private readonly scheduled = new Map<number, { callback: () => void; runAtMs: number }>();

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;

    this.nextId += 1;

    this.scheduled.set(id, {
      callback,
      runAtMs: this.nowMs + delayMs,
    });

    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === "number") {
      this.scheduled.delete(handle);
    }
  };

  async advanceBy(delayMs: number): Promise<void> {
    const targetMs = this.nowMs + delayMs;

    for (;;) {
      const next = [...this.scheduled.entries()]
        .filter(([, scheduled]) => scheduled.runAtMs <= targetMs)
        .sort((a, b) => a[1].runAtMs - b[1].runAtMs || a[0] - b[0])[0];

      if (!next) {
        break;
      }

      const [id, scheduled] = next;

      this.nowMs = scheduled.runAtMs;
      this.scheduled.delete(id);
      scheduled.callback();

      await Promise.resolve();
    }

    this.nowMs = targetMs;

    await Promise.resolve();
  }
}

describe("N2.7 durable AutonomousMissionRunner restart", () => {
  const handleA = createDatabase(DATABASE_URL);

  const handleB = createDatabase(DATABASE_URL);

  afterAll(async () => {
    await handleA.close();
    await handleB.close();
  });

  beforeEach(async () => {
    await handleA.db.execute(
      sql.raw("TRUNCATE TABLE missions, tasks " + "RESTART IDENTITY CASCADE"),
    );

    const now = new Date("2026-09-13T18:00:00.000Z");

    await handleA.db.insert(missions).values({
      id: "durable-runner-mission",
      title: "Durable runner",
      objective: "Resume after restart",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
  });

  it("fresh runner resumes persisted runtime after restart", async () => {
    let currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Durable runner",
      objective: "Resume after restart",
      status: "draft",
      createdAt: new Date("2026-09-13T18:00:00.000Z"),
      updatedAt: new Date("2026-09-13T18:00:00.000Z"),
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-a",
        missionId: currentMission.id,
        taskId: "canonical-a",
        title: "A",
        description: "A",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),

      listTasks: vi.fn().mockImplementation(async () => tasks),

      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    /*
     * PROCESS A:
     * performs one cycle and exits WAITING.
     */
    const supervisorA: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),

      run: vi.fn().mockImplementation(async () => {
        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const runtimeA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    const nowA = new Date("2026-09-13T18:00:00.000Z");

    const runnerA = new AutonomousMissionRunner(
      missionPort,
      supervisorA,
      planner,
      {
        maxCycles: 10,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
      },
      () => nowA,
      runtimeA,
    );

    const first = await runnerA.run(currentMission.id);

    expect(first.state).toBe("waiting");

    expect(first.cycleCount).toBe(1);

    const persistedA = await runtimeA.get(currentMission.id);

    expect(persistedA?.state).toBe("waiting");

    expect(persistedA?.cycleCount).toBe(1);

    expect(persistedA?.maxCycles).toBe(10);

    expect(persistedA?.maxReplans).toBe(5);

    /*
     * External callback occurs while process A is gone.
     */
    tasks = [
      {
        ...tasks[0],
        status: "succeeded",
      },
    ];

    currentMission = {
      ...currentMission,
      status: "succeeded",
    };

    /*
     * PROCESS B:
     * brand-new repository and brand-new runner.
     */
    const runtimeB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    const nowB = new Date("2026-09-13T18:05:00.000Z");

    const supervisorB: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),

      run: vi.fn().mockResolvedValue(undefined),
    };

    const runnerB = new AutonomousMissionRunner(
      missionPort,
      supervisorB,
      planner,
      {
        /*
         * Deliberately different values.
         * Persisted runtime must win.
         */
        maxCycles: 999,
        maxRuntimeMs: 999_999_999,
        maxStagnationCycles: 999,
        maxReplans: 999,
      },
      () => nowB,
      runtimeB,
    );

    const resumed = await runnerB.run(currentMission.id);

    expect(resumed.state).toBe("succeeded");

    /*
     * Persisted runtime survives restart.
     */
    expect(resumed.cycleCount).toBe(1);

    expect(resumed.startedAt.toISOString()).toBe("2026-09-13T18:00:00.000Z");

    /*
     * Mission already terminal after external callback:
     * process B must not launch another worker cycle.
     */
    expect(supervisorB.run).not.toHaveBeenCalled();

    const finalRuntime = await runtimeB.get(currentMission.id);

    expect(finalRuntime?.state).toBe("succeeded");

    expect(finalRuntime?.cycleCount).toBe(1);

    /*
     * Persisted budgets win over runner B constructor defaults.
     */
    expect(finalRuntime?.maxCycles).toBe(10);

    expect(finalRuntime?.maxReplans).toBe(5);

    expect(finalRuntime?.startedAt.toISOString()).toBe("2026-09-13T18:00:00.000Z");
  });

  it("allows only one concurrent runner to enter the Supervisor", async () => {
    const now = new Date("2026-09-13T18:20:00.000Z");

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Concurrent runner",
      objective: "Only one runner may execute",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-concurrent",
        missionId: currentMission.id,
        taskId: "canonical-concurrent",
        title: "Concurrent task",
        description: "Concurrent task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),

      listTasks: vi.fn().mockImplementation(async () => tasks),

      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const runtimeA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    const runtimeB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    /*
     * Pre-create the durable runtime.
     *
     * This test isolates runner lease ownership.
     * First-start create races are tested separately.
     */
    await runtimeA.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    let releaseSupervisor: (() => void) | undefined;

    const supervisorBlocked = new Promise<void>((resolve) => {
      releaseSupervisor = resolve;
    });

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),

      run: vi.fn().mockImplementation(async () => {
        markSupervisorEntered?.();

        await supervisorBlocked;

        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const options = {
      maxCycles: 10,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      maxReplans: 5,
      leaseMs: 30_000,
    };

    const runnerA = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      options,
      () => now,
      runtimeA,
    );

    const runnerB = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      options,
      () => now,
      runtimeB,
    );

    /*
     * A enters the Supervisor while still holding
     * the mission-level lease.
     */
    const winnerPromise = runnerA.run(currentMission.id);

    await supervisorEntered;

    /*
     * B now attempts the exact same mission.
     * It must lose the claim before any Supervisor side effect.
     */
    const loser = await runnerB.run(currentMission.id);

    expect(loser.state).toBe("waiting");

    expect(loser.reason).toBe("AUTONOMY_RUNTIME_ALREADY_OWNED");

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    /*
     * Let A complete its cycle.
     */
    releaseSupervisor?.();

    const winner = await winnerPromise;

    expect(winner.state).toBe("waiting");

    expect(winner.cycleCount).toBe(1);

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    /*
     * Winner releases its lease in finally.
     * A fresh claim must therefore work afterwards.
     */
    expect(await runtimeB.claim(currentMission.id, "post-run-proof", 5_000)).toBe(true);

    await runtimeB.release(currentMission.id, "post-run-proof");
  });

  it("handles two concurrent first starts without duplicate runtime creation", async () => {
    const now = new Date("2026-09-13T18:30:00.000Z");

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Concurrent first start",
      objective: "Bootstrap exactly one runtime",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-first-start",
        missionId: currentMission.id,
        taskId: "canonical-first-start",
        title: "First start task",
        description: "First start task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),

      listTasks: vi.fn().mockImplementation(async () => tasks),

      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const postgresA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    const postgresB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    /*
     * Force BOTH runners to complete their initial get()
     * while the runtime row still does not exist.
     *
     * This deterministically exercises:
     *
     * get -> null
     * get -> null
     * createIfAbsent || createIfAbsent
     */
    let initialGets = 0;

    let releaseInitialGets: (() => void) | undefined;

    const bothInitialGets = new Promise<void>((resolve) => {
      releaseInitialGets = resolve;
    });

    const wrapRepository = (inner: PostgresAutonomousMissionRuntimeRepository) => {
      let firstGet = true;

      return {
        create: inner.create.bind(inner),

        createIfAbsent: inner.createIfAbsent.bind(inner),

        get: async (missionId: string) => {
          if (!firstGet) {
            return inner.get(missionId);
          }

          firstGet = false;

          const existing = await inner.get(missionId);

          expect(existing).toBeNull();

          initialGets += 1;

          if (initialGets === 2) {
            releaseInitialGets?.();
          }

          await bothInitialGets;

          return existing;
        },

        listRecoverable: inner.listRecoverable.bind(inner),

        save: inner.save.bind(inner),

        claim: inner.claim.bind(inner),

        release: inner.release.bind(inner),

        saveOwned: inner.saveOwned.bind(inner),

        renewClaim: inner.renewClaim.bind(inner),
      };
    };

    const runtimeA = wrapRepository(postgresA);

    const runtimeB = wrapRepository(postgresB);

    let releaseSupervisor: (() => void) | undefined;

    const supervisorBlocked = new Promise<void>((resolve) => {
      releaseSupervisor = resolve;
    });

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),

      run: vi.fn().mockImplementation(async () => {
        markSupervisorEntered?.();

        await supervisorBlocked;

        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const options = {
      maxCycles: 10,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      maxReplans: 5,
      leaseMs: 30_000,
    };

    const runnerA = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      options,
      () => now,
      runtimeA,
    );

    const runnerB = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      options,
      () => now,
      runtimeB,
    );

    /*
     * Start both runners before releasing either
     * initial runtime lookup.
     */
    const promiseA = runnerA.run(currentMission.id);

    const promiseB = runnerB.run(currentMission.id);

    /*
     * Exactly one runner must acquire the lease
     * and reach the Supervisor.
     */
    await supervisorEntered;

    /*
     * The other runner must finish while the winner
     * remains deliberately blocked in Supervisor.run().
     */
    const firstFinished = await Promise.race([promiseA, promiseB]);

    expect(firstFinished.state).toBe("waiting");

    expect(firstFinished.reason).toBe("AUTONOMY_RUNTIME_ALREADY_OWNED");

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    /*
     * Atomic bootstrap must leave exactly one runtime row.
     */
    const rows = await handleA.db.select().from(autonomousMissionRuntime);

    expect(rows).toHaveLength(1);

    expect(rows[0]?.missionId).toBe(currentMission.id);

    /*
     * Let the winner finish.
     */
    releaseSupervisor?.();

    const results = await Promise.all([promiseA, promiseB]);

    expect(results.map((result) => result.reason)).toContain("AUTONOMY_RUNTIME_ALREADY_OWNED");

    expect(results.map((result) => result.reason)).toContain("AUTONOMY_EXTERNAL_WORK_PENDING");

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    /*
     * There must still be only one durable runtime
     * after both runners have completed.
     */
    const finalRows = await handleB.db.select().from(autonomousMissionRuntime);

    expect(finalRows).toHaveLength(1);

    expect(finalRows[0]?.cycleCount).toBe(1);

    expect(finalRows[0]?.state).toBe("waiting");
  });

  it("allows only one recovery runner when two sweepers detect the same expired runtime", async () => {
    const now = new Date();

    const expiredLease = new Date(now.getTime() - 60_000);

    const startedAt = new Date(now.getTime() - 120_000);

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Crash recovery",
      objective: "Recover exactly once after owner crash",
      status: "draft",
      createdAt: startedAt,
      updatedAt: startedAt,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-crash-recovery",
        missionId: currentMission.id,
        taskId: "canonical-crash-recovery",
        title: "Crash recovery task",
        description: "Crash recovery task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),

      listTasks: vi.fn().mockImplementation(async () => tasks),

      applyPlan: vi.fn(),
    };

    const runtimeA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    const runtimeB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    /*
     * Simulate a dead previous process:
     * runtime is still running,
     * owner token remains,
     * lease is expired.
     */
    await runtimeA.create({
      missionId: currentMission.id,
      state: "running",
      startedAt,
      updatedAt: expiredLease,
      lastHeartbeatAt: expiredLease,
      lastProgressAt: startedAt,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_OWNER_CRASHED",
      ownerToken: "dead-process-owner",
      leaseUntil: expiredLease,
    });

    /*
     * Barrier: both sweepers must discover
     * the stale runtime before either wakeup starts.
     */
    let discoveries = 0;

    let releaseDiscoveries: (() => void) | undefined;

    const bothDiscovered = new Promise<void>((resolve) => {
      releaseDiscoveries = resolve;
    });

    const discoveryRepository = (repository: PostgresAutonomousMissionRuntimeRepository) => ({
      listRecoverable: async (limit?: number) => {
        const found = await repository.listRecoverable(limit);

        expect(found.map((runtime) => runtime.missionId)).toContain(currentMission.id);

        discoveries += 1;

        if (discoveries === 2) {
          releaseDiscoveries?.();
        }

        await bothDiscovered;

        return found;
      },
    });

    /*
     * Hold the winning runner inside Supervisor.run()
     * so the competing runner sees an active lease.
     */
    let releaseSupervisor: (() => void) | undefined;

    const supervisorBlocked = new Promise<void>((resolve) => {
      releaseSupervisor = resolve;
    });

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),

      run: vi.fn().mockImplementation(async () => {
        markSupervisorEntered?.();

        await supervisorBlocked;

        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const wakeupA = new AutonomyWakeupService(missionPort, supervisor, runtimeA, () => now);

    const wakeupB = new AutonomyWakeupService(missionPort, supervisor, runtimeB, () => now);

    const wakeResults: Array<AutonomousMissionRunnerResult | null> = [];

    const sweeperA = new AutonomyRecoverySweeper(discoveryRepository(runtimeA), {
      wake: async (missionId: string) => {
        const result = await wakeupA.wake(missionId);

        wakeResults.push(result);

        return result;
      },
    });

    const sweeperB = new AutonomyRecoverySweeper(discoveryRepository(runtimeB), {
      wake: async (missionId: string) => {
        const result = await wakeupB.wake(missionId);

        wakeResults.push(result);

        return result;
      },
    });

    const sweepPromiseA = sweeperA.sweep();

    const sweepPromiseB = sweeperB.sweep();

    /*
     * One runner must acquire ownership
     * and enter Supervisor.
     */
    await supervisorEntered;

    expect(discoveries).toBe(2);

    /*
     * The losing runner must complete while
     * the winner still owns the lease.
     */
    await Promise.race([sweepPromiseA, sweepPromiseB]);

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    expect(wakeResults.some((result) => result?.reason === "AUTONOMY_RUNTIME_ALREADY_OWNED")).toBe(
      true,
    );

    releaseSupervisor?.();

    const [sweepResultA, sweepResultB] = await Promise.all([sweepPromiseA, sweepPromiseB]);

    /*
     * Both sweepers found and attempted the mission.
     * Losing the runtime claim is not a sweeper error.
     */
    expect(sweepResultA.discovered).toBe(1);

    expect(sweepResultB.discovered).toBe(1);

    expect(sweepResultA.attempted).toBe(1);

    expect(sweepResultB.attempted).toBe(1);

    expect(sweepResultA.failed).toBe(0);

    expect(sweepResultB.failed).toBe(0);

    /*
     * Exactly one recovery runner crossed
     * the mission execution fence.
     */
    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    expect(wakeResults).toHaveLength(2);

    expect(
      wakeResults.filter((result) => result?.reason === "AUTONOMY_RUNTIME_ALREADY_OWNED"),
    ).toHaveLength(1);

    expect(
      wakeResults.filter((result) => result?.reason === "AUTONOMY_EXTERNAL_WORK_PENDING"),
    ).toHaveLength(1);

    const finalRuntime = await runtimeA.get(currentMission.id);

    expect(finalRuntime).not.toBeNull();

    expect(finalRuntime?.state).toBe("waiting");

    expect(finalRuntime?.cycleCount).toBe(1);

    expect(finalRuntime?.ownerToken ?? null).toBeNull();

    expect(finalRuntime?.leaseUntil ?? null).toBeNull();

    const rows = await handleA.db.select().from(autonomousMissionRuntime);

    expect(rows).toHaveLength(1);
  });

  it("renews the active owner lease while Supervisor work is still running", async () => {
    const now = new Date();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Long-running owner",
      objective: "Keep ownership during long-running work",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-long-running",
        missionId: currentMission.id,
        taskId: "canonical-long-running",
        title: "Long-running task",
        description: "Long-running task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const postgres = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    await postgres.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    const renewClaim = vi.fn(postgres.renewClaim.bind(postgres));

    const runtimeRepository = {
      create: postgres.create.bind(postgres),
      createIfAbsent: postgres.createIfAbsent.bind(postgres),
      get: postgres.get.bind(postgres),
      listRecoverable: postgres.listRecoverable.bind(postgres),
      save: postgres.save.bind(postgres),
      claim: postgres.claim.bind(postgres),
      release: postgres.release.bind(postgres),
      saveOwned: postgres.saveOwned.bind(postgres),
      renewClaim,
    };

    let releaseSupervisor: (() => void) | undefined;

    const supervisorBlocked = new Promise<void>((resolve) => {
      releaseSupervisor = resolve;
    });

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async () => {
        markSupervisorEntered?.();
        await supervisorBlocked;

        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const runner = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      {
        maxCycles: 10,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
        leaseMs: 300,
      },
      () => new Date(),
      runtimeRepository,
    );

    const resultPromise = runner.run(currentMission.id);

    await supervisorEntered;

    try {
      await vi.waitFor(
        () => {
          expect(renewClaim).toHaveBeenCalled();
        },
        {
          timeout: 1_000,
          interval: 20,
        },
      );
    } finally {
      releaseSupervisor?.();
      await resultPromise;
    }
  });

  it("prevents a second runner from claiming while the active owner keeps renewing", async () => {
    const now = new Date();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Renewed concurrent owner",
      objective: "Keep a competitor outside the Supervisor",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-renewed-owner",
        missionId: currentMission.id,
        taskId: "canonical-renewed-owner",
        title: "Renewed owner task",
        description: "Renewed owner task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const runtimeA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    const runtimeB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    const renewClaim = vi.fn(runtimeA.renewClaim.bind(runtimeA));

    const renewingRuntimeA = {
      create: runtimeA.create.bind(runtimeA),
      createIfAbsent: runtimeA.createIfAbsent.bind(runtimeA),
      get: runtimeA.get.bind(runtimeA),
      listRecoverable: runtimeA.listRecoverable.bind(runtimeA),
      save: runtimeA.save.bind(runtimeA),
      claim: runtimeA.claim.bind(runtimeA),
      release: runtimeA.release.bind(runtimeA),
      saveOwned: runtimeA.saveOwned.bind(runtimeA),
      renewClaim,
    };

    await runtimeA.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    let releaseSupervisor: (() => void) | undefined;

    const supervisorBlocked = new Promise<void>((resolve) => {
      releaseSupervisor = resolve;
    });

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async () => {
        markSupervisorEntered?.();
        await supervisorBlocked;

        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const options = {
      maxCycles: 10,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      maxReplans: 5,
      leaseMs: 300,
    };

    const runnerA = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      options,
      () => new Date(),
      renewingRuntimeA,
    );

    const runnerB = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      options,
      () => new Date(),
      runtimeB,
    );

    const winnerPromise = runnerA.run(currentMission.id);

    await supervisorEntered;

    try {
      const initiallyClaimed = await runtimeB.get(currentMission.id);

      expect(initiallyClaimed?.leaseUntil).not.toBeNull();

      const originalLeaseUntil = initiallyClaimed!.leaseUntil!;

      await vi.waitFor(
        async () => {
          expect(renewClaim).toHaveBeenCalled();

          const renewed = await runtimeB.get(currentMission.id);

          expect(renewed?.leaseUntil?.getTime() ?? 0).toBeGreaterThan(originalLeaseUntil.getTime());
        },
        {
          timeout: 1_000,
          interval: 10,
        },
      );

      await vi.waitFor(
        () => {
          expect(Date.now()).toBeGreaterThanOrEqual(originalLeaseUntil.getTime());
        },
        {
          timeout: 1_000,
          interval: 10,
        },
      );

      const loser = await runnerB.run(currentMission.id);

      expect(loser.state).toBe("waiting");

      expect(loser.reason).toBe("AUTONOMY_RUNTIME_ALREADY_OWNED");

      expect(supervisor.run).toHaveBeenCalledTimes(1);
    } finally {
      releaseSupervisor?.();
      await winnerPromise;
    }
  });

  it("fails closed without a stale runtime write when lease renewal is lost", async () => {
    const now = new Date();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Lost lease owner",
      objective: "Stop stale execution",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    const tasks: MissionTask[] = [
      {
        id: "mt-lost-lease",
        missionId: currentMission.id,
        taskId: "canonical-lost-lease",
        title: "Lost lease task",
        description: "Lost lease task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockResolvedValue(tasks),
      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const postgres = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    await postgres.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    const saveOwned = vi.fn(postgres.saveOwned.bind(postgres));

    const runtimeRepository = {
      create: postgres.create.bind(postgres),
      createIfAbsent: postgres.createIfAbsent.bind(postgres),
      get: postgres.get.bind(postgres),
      listRecoverable: postgres.listRecoverable.bind(postgres),
      save: postgres.save.bind(postgres),
      claim: postgres.claim.bind(postgres),
      release: postgres.release.bind(postgres),
      saveOwned,
      renewClaim: vi.fn().mockResolvedValue(false),
    };

    let releaseSupervisor: (() => void) | undefined;

    const supervisorBlocked = new Promise<void>((resolve) => {
      releaseSupervisor = resolve;
    });

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    let markSupervisorFinished: (() => void) | undefined;

    const supervisorFinished = new Promise<void>((resolve) => {
      markSupervisorFinished = resolve;
    });

    let observedSupervisorSignal: AbortSignal | undefined;
    let staleSupervisorMutations = 0;

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async (_missionId: string, signal?: AbortSignal) => {
        observedSupervisorSignal = signal;

        try {
          markSupervisorEntered?.();
          await supervisorBlocked;
          signal?.throwIfAborted();
          staleSupervisorMutations += 1;
        } finally {
          markSupervisorFinished?.();
        }
      }),
    };

    const runner = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      {
        maxCycles: 10,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
        leaseMs: 300,
      },
      () => new Date(),
      runtimeRepository,
    );

    const resultPromise = runner.run(currentMission.id);

    const resultOutcome = resultPromise.then(
      () => null,
      (error: unknown) => error,
    );

    await supervisorEntered;

    await vi.waitFor(
      () => {
        expect(runtimeRepository.renewClaim).toHaveBeenCalled();
      },
      {
        timeout: 1_000,
        interval: 20,
      },
    );

    const writesBeforeLoss = saveOwned.mock.calls.length;

    const missionReadsBeforeLoss = missionPort.findById.mock.calls.length;

    const taskReadsBeforeLoss = missionPort.listTasks.mock.calls.length;

    const outcome = await Promise.race([
      resultOutcome,
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), 500);
      }),
    ]);

    expect(outcome).toBeInstanceOf(Error);

    expect((outcome as Error).message).toBe("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");

    releaseSupervisor?.();
    await supervisorFinished;

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(observedSupervisorSignal?.aborted).toBe(true);

    expect(staleSupervisorMutations).toBe(0);

    expect(saveOwned).toHaveBeenCalledTimes(writesBeforeLoss);

    expect(missionPort.findById).toHaveBeenCalledTimes(missionReadsBeforeLoss);

    expect(missionPort.listTasks).toHaveBeenCalledTimes(taskReadsBeforeLoss);

    expect(missionPort.applyPlan).not.toHaveBeenCalled();

    const persisted = await postgres.get(currentMission.id);

    expect(persisted?.cycleCount).toBe(0);

    expect(persisted?.lastReason).toBe("AUTONOMY_TEST_READY");
  });

  it("times out a hung lease renewal and finishes without stale writes", async () => {
    const now = new Date();

    const renewalTimer = new ManualLeaseRenewalTimer();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Hung lease renewal",
      objective: "Fail closed when renewal never settles",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-hung-renewal",
        missionId: currentMission.id,
        taskId: "canonical-hung-renewal",
        title: "Hung renewal task",
        description: "Hung renewal task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const postgres = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    await postgres.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    const saveOwned = vi.fn(postgres.saveOwned.bind(postgres));
    const release = vi.fn(postgres.release.bind(postgres));

    let markRenewalStarted: (() => void) | undefined;

    const renewalStarted = new Promise<void>((resolve) => {
      markRenewalStarted = resolve;
    });

    const renewClaim = vi.fn(() => {
      markRenewalStarted?.();

      return new Promise<boolean>(() => undefined);
    });

    const runtimeRepository = {
      create: postgres.create.bind(postgres),
      createIfAbsent: postgres.createIfAbsent.bind(postgres),
      get: postgres.get.bind(postgres),
      listRecoverable: postgres.listRecoverable.bind(postgres),
      save: postgres.save.bind(postgres),
      claim: postgres.claim.bind(postgres),
      release,
      saveOwned,
      renewClaim,
    };

    let markSupervisorEntered: (() => void) | undefined;

    const supervisorEntered = new Promise<void>((resolve) => {
      markSupervisorEntered = resolve;
    });

    let staleSupervisorMutations = 0;

    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async (_missionId: string, signal?: AbortSignal) => {
        markSupervisorEntered?.();

        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });

        signal?.throwIfAborted();
        staleSupervisorMutations += 1;

        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const runner = new AutonomousMissionRunner(
      missionPort,
      supervisor,
      planner,
      {
        maxCycles: 10,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
        leaseMs: 300,
        leaseRenewalTimeoutMs: 50,
        leaseRenewalTimer: renewalTimer,
      },
      () => new Date(),
      runtimeRepository,
    );

    const outcomePromise = runner.run(currentMission.id).then(
      () => null,
      (error: unknown) => error,
    );

    await supervisorEntered;
    await renewalTimer.advanceBy(100);
    await renewalStarted;

    const writesBeforeTimeout = saveOwned.mock.calls.length;

    await renewalTimer.advanceBy(49);
    expect(release).not.toHaveBeenCalled();

    await renewalTimer.advanceBy(1);

    const outcome = await outcomePromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
    expect((outcome as Error).cause).toBeInstanceOf(Error);
    expect(((outcome as Error).cause as Error).message).toBe("AUTONOMOUS_RUNTIME_RENEWAL_TIMEOUT");
    expect(staleSupervisorMutations).toBe(0);
    expect(saveOwned).toHaveBeenCalledTimes(writesBeforeTimeout);
    expect(missionPort.applyPlan).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);

    const persisted = await postgres.get(currentMission.id);

    expect(persisted?.cycleCount).toBe(0);
    expect(persisted?.lastReason).toBe("AUTONOMY_TEST_READY");
  });

  it("lets another runner recover after a hung renewal lease expires", async () => {
    const now = new Date();

    const renewalTimer = new ManualLeaseRenewalTimer();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Hung renewal recovery",
      objective: "Allow takeover after lease expiry",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-hung-renewal-recovery",
        missionId: currentMission.id,
        taskId: "canonical-hung-renewal-recovery",
        title: "Hung renewal recovery task",
        description: "Hung renewal recovery task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
    };

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn(),
    };

    const postgresA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);
    const postgresB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    await postgresA.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    let markRenewalStarted: (() => void) | undefined;

    const renewalStarted = new Promise<void>((resolve) => {
      markRenewalStarted = resolve;
    });

    const runtimeA = {
      create: postgresA.create.bind(postgresA),
      createIfAbsent: postgresA.createIfAbsent.bind(postgresA),
      get: postgresA.get.bind(postgresA),
      listRecoverable: postgresA.listRecoverable.bind(postgresA),
      save: postgresA.save.bind(postgresA),
      claim: postgresA.claim.bind(postgresA),
      release: vi.fn().mockResolvedValue(undefined),
      saveOwned: postgresA.saveOwned.bind(postgresA),
      renewClaim: vi.fn(() => {
        markRenewalStarted?.();

        return new Promise<boolean>(() => undefined);
      }),
    };

    let markSupervisorAEntered: (() => void) | undefined;

    const supervisorAEntered = new Promise<void>((resolve) => {
      markSupervisorAEntered = resolve;
    });

    const supervisorA: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async (_missionId: string, signal?: AbortSignal) => {
        markSupervisorAEntered?.();

        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });

        signal?.throwIfAborted();
      }),
    };

    const options = {
      maxCycles: 10,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      maxReplans: 5,
      leaseMs: 300,
      leaseRenewalTimeoutMs: 50,
      leaseRenewalTimer: renewalTimer,
    };

    const runnerA = new AutonomousMissionRunner(
      missionPort,
      supervisorA,
      planner,
      options,
      () => new Date(),
      runtimeA,
    );

    const runnerAOutcome = runnerA.run(currentMission.id).then(
      () => null,
      (error: unknown) => error,
    );

    await supervisorAEntered;
    await renewalTimer.advanceBy(100);
    await renewalStarted;
    await renewalTimer.advanceBy(50);

    const ownershipLoss = await runnerAOutcome;

    expect(ownershipLoss).toBeInstanceOf(Error);
    expect((ownershipLoss as Error).message).toBe("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");

    await vi.waitFor(
      async () => {
        const runtime = await postgresB.get(currentMission.id);

        expect(runtime?.leaseUntil).not.toBeNull();
        expect(runtime?.leaseUntil?.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
          Date.now(),
        );
      },
      {
        timeout: 1_000,
        interval: 10,
      },
    );

    const supervisorB: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async () => {
        tasks = [
          {
            ...tasks[0],
            status: "queued",
          },
        ];
      }),
    };

    const runnerB = new AutonomousMissionRunner(
      missionPort,
      supervisorB,
      planner,
      {
        ...options,
        leaseMs: 5_000,
        leaseRenewalTimer: undefined,
      },
      () => new Date(),
      postgresB,
    );

    const recovered = await runnerB.run(currentMission.id);

    expect(recovered.state).toBe("waiting");
    expect(recovered.reason).toBe("AUTONOMY_EXTERNAL_WORK_PENDING");
    expect(supervisorB.run).toHaveBeenCalledTimes(1);
  });

  it("aborts hung planner work before applyPlan after renewal timeout", async () => {
    const now = new Date();

    const renewalTimer = new ManualLeaseRenewalTimer();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Hung planner cancellation",
      objective: "Stop planning when lease renewal hangs",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    const missionPort = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockResolvedValue([]),
      applyPlan: vi.fn(),
    };

    const postgres = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    await postgres.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    let markRenewalStarted: (() => void) | undefined;

    const renewalStarted = new Promise<void>((resolve) => {
      markRenewalStarted = resolve;
    });

    const runtimeRepository = {
      create: postgres.create.bind(postgres),
      createIfAbsent: postgres.createIfAbsent.bind(postgres),
      get: postgres.get.bind(postgres),
      listRecoverable: postgres.listRecoverable.bind(postgres),
      save: postgres.save.bind(postgres),
      claim: postgres.claim.bind(postgres),
      release: postgres.release.bind(postgres),
      saveOwned: postgres.saveOwned.bind(postgres),
      renewClaim: vi.fn(() => {
        markRenewalStarted?.();

        return new Promise<boolean>(() => undefined);
      }),
    };

    let markPlannerEntered: (() => void) | undefined;

    const plannerEntered = new Promise<void>((resolve) => {
      markPlannerEntered = resolve;
    });

    let observedPlannerSignal: AbortSignal | undefined;
    let stalePlannerMutations = 0;

    const planner: AutonomousMissionPlanner = {
      plan: vi.fn().mockImplementation(async ({ signal }) => {
        observedPlannerSignal = signal;
        markPlannerEntered?.();

        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });

        signal?.throwIfAborted();
        stalePlannerMutations += 1;

        return {
          version: 1 as const,
          tasks: [],
        };
      }),
    };

    const runner = new AutonomousMissionRunner(
      missionPort,
      {
        reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
        settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
        run: vi.fn().mockResolvedValue(undefined),
      },
      planner,
      {
        maxCycles: 10,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
        leaseMs: 300,
        leaseRenewalTimeoutMs: 50,
        leaseRenewalTimer: renewalTimer,
      },
      () => new Date(),
      runtimeRepository,
    );

    const outcomePromise = runner.run(currentMission.id).then(
      () => null,
      (error: unknown) => error,
    );

    await plannerEntered;
    await renewalTimer.advanceBy(100);
    await renewalStarted;
    await renewalTimer.advanceBy(50);

    const outcome = await outcomePromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
    expect(observedPlannerSignal?.aborted).toBe(true);
    expect(stalePlannerMutations).toBe(0);
    expect(missionPort.applyPlan).not.toHaveBeenCalled();
  });

  it("does not mutate runtime after an in-flight applyPlan loses ownership", async () => {
    const now = new Date();

    const renewalTimer = new ManualLeaseRenewalTimer();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "In-flight plan application",
      objective: "Fence runtime after applyPlan ownership loss",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    let markApplyPlanEntered: (() => void) | undefined;

    const applyPlanEntered = new Promise<void>((resolve) => {
      markApplyPlanEntered = resolve;
    });

    let resolveApplyPlan: (() => void) | undefined;

    const applyPlanBlocked = new Promise<void>((resolve) => {
      resolveApplyPlan = resolve;
    });

    let applyPlanMutations = 0;

    const missionPort = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockResolvedValue([]),
      applyPlan: vi.fn().mockImplementation(async () => {
        markApplyPlanEntered?.();
        await applyPlanBlocked;
        applyPlanMutations += 1;

        return [];
      }),
    };

    const postgres = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    await postgres.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 0,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 10,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    const saveOwned = vi.fn(postgres.saveOwned.bind(postgres));

    let markRenewalStarted: (() => void) | undefined;

    const renewalStarted = new Promise<void>((resolve) => {
      markRenewalStarted = resolve;
    });

    const runtimeRepository = {
      create: postgres.create.bind(postgres),
      createIfAbsent: postgres.createIfAbsent.bind(postgres),
      get: postgres.get.bind(postgres),
      listRecoverable: postgres.listRecoverable.bind(postgres),
      save: postgres.save.bind(postgres),
      claim: postgres.claim.bind(postgres),
      release: postgres.release.bind(postgres),
      saveOwned,
      renewClaim: vi.fn(() => {
        markRenewalStarted?.();

        return new Promise<boolean>(() => undefined);
      }),
    };

    const runner = new AutonomousMissionRunner(
      missionPort,
      {
        reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
        settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
        run: vi.fn().mockResolvedValue(undefined),
      },
      {
        plan: vi.fn().mockResolvedValue({
          version: 1,
          tasks: [],
        }),
      },
      {
        maxCycles: 10,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
        leaseMs: 300,
        leaseRenewalTimeoutMs: 50,
        leaseRenewalTimer: renewalTimer,
      },
      () => new Date(),
      runtimeRepository,
    );

    const outcomePromise = runner.run(currentMission.id).then(
      () => null,
      (error: unknown) => error,
    );

    await applyPlanEntered;
    await renewalTimer.advanceBy(100);
    await renewalStarted;

    const writesBeforeTimeout = saveOwned.mock.calls.length;

    await renewalTimer.advanceBy(50);

    const outcome = await outcomePromise;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");

    resolveApplyPlan?.();
    await applyPlanBlocked;

    expect(applyPlanMutations).toBe(1);
    expect(saveOwned).toHaveBeenCalledTimes(writesBeforeTimeout);
    expect(missionPort.listTasks).toHaveBeenCalledTimes(1);

    const persisted = await postgres.get(currentMission.id);

    expect(persisted?.cycleCount).toBe(0);
    expect(persisted?.lastReason).toBe("AUTONOMY_TEST_READY");
  });

  it("does not report success when an in-flight renewal loses ownership during completion", async () => {
    const now = new Date();

    const currentMission: Mission = {
      id: "durable-runner-mission",
      title: "Completion renewal race",
      objective: "Fail closed at completion",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };

    const tasks: MissionTask[] = [
      {
        id: "mt-completion-race",
        missionId: currentMission.id,
        taskId: "canonical-completion-race",
        title: "Completion race task",
        description: "Completion race task",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
    };

    const postgres = new PostgresAutonomousMissionRuntimeRepository(handleA.db);

    await postgres.create({
      missionId: currentMission.id,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      lastHeartbeatAt: now,
      lastProgressAt: now,
      cycleCount: 1,
      replanCount: 0,
      stagnationCount: 0,
      maxCycles: 1,
      maxReplans: 5,
      maxRuntimeMs: 3_600_000,
      maxStagnationCycles: 3,
      lastReason: "AUTONOMY_TEST_READY",
    });

    let markRenewalStarted: (() => void) | undefined;

    const renewalStarted = new Promise<void>((resolve) => {
      markRenewalStarted = resolve;
    });

    let resolveRenewal: ((renewed: boolean) => void) | undefined;

    const renewClaim = vi.fn(
      () =>
        new Promise<boolean>((resolveRenewed) => {
          resolveRenewal = resolveRenewed;
          markRenewalStarted?.();
        }),
    );

    let releaseSave: (() => void) | undefined;

    const saveBlocked = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });

    let saveCalls = 0;
    const saveOwned = vi.fn(async (...args: Parameters<typeof postgres.saveOwned>) => {
      saveCalls += 1;

      if (saveCalls === 1) {
        await saveBlocked;
      }

      await PostgresAutonomousMissionRuntimeRepository.prototype.saveOwned.apply(postgres, args);
    });

    const runtimeRepository = {
      create: postgres.create.bind(postgres),
      createIfAbsent: postgres.createIfAbsent.bind(postgres),
      get: postgres.get.bind(postgres),
      listRecoverable: postgres.listRecoverable.bind(postgres),
      save: postgres.save.bind(postgres),
      claim: postgres.claim.bind(postgres),
      release: postgres.release.bind(postgres),
      saveOwned,
      renewClaim,
    };

    const runner = new AutonomousMissionRunner(
      missionPort,
      {
        reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
        settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
        run: vi.fn().mockResolvedValue(undefined),
      },
      { plan: vi.fn() },
      {
        maxCycles: 1,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 5,
        leaseMs: 300,
      },
      () => new Date(),
      runtimeRepository,
    );

    const resultPromise = runner.run(currentMission.id);
    const resultOutcome = resultPromise.then(
      (result) => result,
      (error: unknown) => error,
    );

    await renewalStarted;
    releaseSave?.();
    resolveRenewal?.(false);

    const outcome = await resultOutcome;

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
  });
});
