import { TEST_DATABASE_URL } from "@/server/database/test-database-guard";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { sql } from "drizzle-orm";

import type { Mission, MissionTask } from "@/core/mission/contracts";
import {
  AutonomyRecoveryScheduler,
  type AutonomyRecoverySchedulerTimer,
} from "@/server/autonomy/autonomy-recovery-scheduler";
import { AutonomyRecoverySweeper } from "@/server/autonomy/autonomy-recovery-sweeper";
import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";
import type {
  AutonomousMissionRunnerResult,
  AutonomousSupervisor,
} from "@/server/autonomy/autonomous-mission-runner";
import { createDatabase } from "@/server/database/client";
import { missions } from "@/server/database/schema";
import { PostgresAutonomousMissionRuntimeRepository } from "@/server/repositories/postgres/autonomous-mission-runtime-repository";

const DATABASE_URL = TEST_DATABASE_URL;

class ManualSchedulerTimer implements AutonomyRecoverySchedulerTimer {
  private nowMs = 0;
  private nextId = 1;
  private readonly scheduled = new Map<number, { callback: () => void; runAtMs: number }>();

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.scheduled.set(id, { callback, runAtMs: this.nowMs + delayMs });
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

async function waitFor(assertion: () => void, attempts = 100): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }

  throw lastError;
}

describe("Phase 2 PostgreSQL recovery scheduler", () => {
  const handleA = createDatabase(DATABASE_URL);
  const handleB = createDatabase(DATABASE_URL);

  afterAll(async () => {
    await handleA.close();
    await handleB.close();
  });

  beforeEach(async () => {
    await handleA.db.execute(sql.raw("TRUNCATE TABLE missions, tasks RESTART IDENTITY CASCADE"));
  });

  it("automatically recovers one stale runtime through one effective runner across two schedulers", async () => {
    const now = new Date("2026-09-14T10:00:00.000Z");
    let mission: Mission = {
      id: "scheduled-recovery-mission",
      title: "Scheduled recovery",
      objective: "Recover without callback",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    let tasks: MissionTask[] = [
      {
        id: "scheduled-mission-task",
        missionId: mission.id,
        taskId: "scheduled-canonical-task",
        title: "Resume",
        description: "Resume automatically",
        dependsOn: [],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    await handleA.db.insert(missions).values({
      id: mission.id,
      title: mission.title,
      objective: mission.objective,
      status: mission.status,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    });

    const runtimeA = new PostgresAutonomousMissionRuntimeRepository(handleA.db);
    const runtimeB = new PostgresAutonomousMissionRuntimeRepository(handleB.db);

    await runtimeA.create({
      missionId: mission.id,
      state: "running",
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
      lastReason: "AUTONOMY_PROCESS_CRASHED",
      ownerToken: null,
      leaseUntil: null,
    });

    const missionPort = {
      findById: vi.fn().mockImplementation(async () => mission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
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
        tasks = [{ ...tasks[0], status: "queued" }];
        mission = { ...mission, updatedAt: new Date(now.getTime() + 1_000) };
      }),
    };

    const wakeupA = new AutonomyWakeupService(missionPort, supervisor, runtimeA, () => now);
    const wakeupB = new AutonomyWakeupService(missionPort, supervisor, runtimeB, () => now);
    const wakeResults: Array<AutonomousMissionRunnerResult | null> = [];
    let discoveries = 0;
    let releaseDiscoveries: (() => void) | undefined;
    const bothDiscovered = new Promise<void>((resolve) => {
      releaseDiscoveries = resolve;
    });

    const discoveryRepository = (repository: PostgresAutonomousMissionRuntimeRepository) => ({
      listRecoverable: async (limit?: number) => {
        const found = await repository.listRecoverable(limit);
        expect(found.map((runtime) => runtime.missionId)).toContain(mission.id);
        discoveries += 1;
        if (discoveries === 2) {
          releaseDiscoveries?.();
        }
        await bothDiscovered;
        return found;
      },
    });

    const sweeperA = new AutonomyRecoverySweeper(discoveryRepository(runtimeA), {
      wake: async (missionId) => {
        const result = await wakeupA.wake(missionId);
        wakeResults.push(result);
        return result;
      },
    });
    const sweeperB = new AutonomyRecoverySweeper(discoveryRepository(runtimeB), {
      wake: async (missionId) => {
        const result = await wakeupB.wake(missionId);
        wakeResults.push(result);
        return result;
      },
    });
    const timerA = new ManualSchedulerTimer();
    const timerB = new ManualSchedulerTimer();
    const schedulerA = new AutonomyRecoveryScheduler(sweeperA, {
      intervalMs: 1_000,
      timer: timerA,
    });
    const schedulerB = new AutonomyRecoveryScheduler(sweeperB, {
      intervalMs: 1_000,
      timer: timerB,
    });

    schedulerA.start();
    schedulerB.start();

    await Promise.all([timerA.advanceBy(1_000), timerB.advanceBy(1_000)]);
    await supervisorEntered;

    expect(discoveries).toBe(2);
    expect(supervisor.run).toHaveBeenCalledTimes(1);
    expect(supervisor.reconcilePreparedDispatches).toHaveBeenCalledTimes(1);

    releaseSupervisor?.();

    await waitFor(() => {
      expect(wakeResults).toHaveLength(2);
    });

    await Promise.all([schedulerA.stop(), schedulerB.stop()]);

    expect(
      wakeResults.filter((result) => result?.reason === "AUTONOMY_RUNTIME_ALREADY_OWNED"),
    ).toHaveLength(1);
    expect(
      wakeResults.filter((result) => result?.reason === "AUTONOMY_EXTERNAL_WORK_PENDING"),
    ).toHaveLength(1);

    const stored = await runtimeA.get(mission.id);
    expect(stored?.state).toBe("waiting");
    expect(stored?.cycleCount).toBe(1);
    expect(stored?.ownerToken ?? null).toBeNull();
    expect(stored?.leaseUntil ?? null).toBeNull();
  });
});
