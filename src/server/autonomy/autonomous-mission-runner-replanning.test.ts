import { describe, expect, it, vi } from "vitest";

import type { Mission, MissionTask } from "@/core/mission/contracts";
import {
  AutonomousMissionRunner,
  type AutonomousMissionPlanner,
  type AutonomousSupervisor,
} from "@/server/autonomy/autonomous-mission-runner";
import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

const now = new Date("2026-09-14T18:00:00.000Z");

function mission(): Mission {
  return {
    id: "mission-replan",
    title: "Recover replan",
    objective: "Recover a durable replanning operation safely",
    status: "planning",
    createdAt: now,
    updatedAt: now,
  };
}

function runtime(overrides: Partial<AutonomousMissionRuntime> = {}): AutonomousMissionRuntime {
  return {
    missionId: "mission-replan",
    state: "replanning",
    startedAt: now,
    updatedAt: now,
    lastHeartbeatAt: now,
    lastProgressAt: now,
    cycleCount: 2,
    replanCount: 0,
    stagnationCount: 3,
    maxCycles: 20,
    maxReplans: 2,
    maxRuntimeMs: 3_600_000,
    maxStagnationCycles: 3,
    lastReason: "AUTONOMY_STAGNATION_REPLAN",
    ownerToken: null,
    leaseUntil: null,
    ...overrides,
  };
}

function runtimeRepository(
  initial: AutonomousMissionRuntime,
): AutonomousMissionRuntimeRepository & { current: AutonomousMissionRuntime } {
  const repository = {
    current: initial,
    create: vi.fn(),
    createIfAbsent: vi.fn().mockResolvedValue(false),
    get: vi.fn().mockImplementation(async () => repository.current),
    listRecoverable: vi.fn().mockResolvedValue([]),
    save: vi.fn(),
    claim: vi.fn().mockResolvedValue(true),
    release: vi.fn().mockResolvedValue(undefined),
    saveOwned: vi.fn().mockImplementation(async (next: AutonomousMissionRuntime) => {
      repository.current = next;
    }),
    renewClaim: vi.fn().mockResolvedValue(true),
  };

  return repository;
}

describe("AutonomousMissionRunner replanning recovery", () => {
  it("replans an empty durable graph with the production planner before supervision", async () => {
    const currentMission = mission();
    let tasks: MissionTask[] = [];
    const repository = runtimeRepository(runtime());
    const missions = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn().mockImplementation(async () => {
        tasks = [
          {
            id: "mission-task-new",
            missionId: currentMission.id,
            taskId: "canonical-task-new",
            title: "Execute corrected plan",
            description: null,
            dependsOn: [],
            status: "draft",
            workerKind: "hermes",
            capability: null,
          },
        ];
        return tasks;
      }),
    };
    const planner: AutonomousMissionPlanner = {
      plan: vi.fn().mockResolvedValue({
        version: 1,
        tasks: [
          {
            key: "execute-corrected-plan",
            title: "Execute corrected plan",
            dependsOn: [],
            workerKind: "hermes",
          },
        ],
      }),
    };
    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockImplementation(async () => {
        tasks = [{ ...tasks[0], status: "queued" }];
      }),
    };
    const runner = new AutonomousMissionRunner(
      missions,
      supervisor,
      planner,
      {
        maxCycles: 20,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 2,
      },
      () => now,
      repository,
    );

    const result = await runner.run(currentMission.id);

    expect(planner.plan).toHaveBeenCalledWith({
      mission: currentMission,
      tasks: [],
      reason: "stagnation",
      signal: expect.any(AbortSignal),
    });
    expect(missions.applyPlan).toHaveBeenCalledTimes(1);
    expect(supervisor.run).toHaveBeenCalledTimes(1);
    expect(repository.current.replanCount).toBe(1);
    expect(repository.current.stagnationCount).toBe(0);
    expect(result.state).toBe("waiting");
  });

  it("replaces a persisted unfinished graph through the repository atomic operation", async () => {
    const currentMission = mission();
    const tasks: MissionTask[] = [
      {
        id: "existing-task",
        missionId: currentMission.id,
        taskId: "canonical-existing-task",
        title: "Existing task",
        description: null,
        dependsOn: [],
        status: "failed",
        workerKind: "hermes",
        capability: null,
      },
    ];
    const repository = runtimeRepository(runtime());
    const missions = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn(),
      replacePlan: vi.fn().mockImplementation(async () => {
        tasks.splice(0, tasks.length, {
          id: "replacement-task",
          missionId: currentMission.id,
          taskId: "canonical-replacement-task",
          title: "Replacement task",
          description: null,
          dependsOn: [],
          status: "queued",
          workerKind: "hermes",
          capability: null,
        });
        return tasks;
      }),
    };
    const planner: AutonomousMissionPlanner = {
      plan: vi.fn().mockResolvedValue({
        version: 1,
        tasks: [{ key: "replacement", title: "Replacement task", dependsOn: [] }],
      }),
    };
    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn(),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn().mockResolvedValue(undefined),
    };
    const runner = new AutonomousMissionRunner(
      missions,
      supervisor,
      planner,
      {
        maxCycles: 20,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 2,
      },
      () => now,
      repository,
    );

    const result = await runner.run(currentMission.id);

    expect(result.state).toBe("waiting");
    expect(repository.current.replanCount).toBe(1);
    expect(planner.plan).toHaveBeenCalledTimes(1);
    expect(missions.applyPlan).not.toHaveBeenCalled();
    expect(missions.replacePlan).toHaveBeenCalledTimes(1);
    expect(supervisor.run).toHaveBeenCalledTimes(1);
  });

  it("fails closed before provider access when the durable replan budget is exhausted", async () => {
    const currentMission = mission();
    const repository = runtimeRepository(
      runtime({
        replanCount: 2,
        maxReplans: 2,
      }),
    );
    const missions = {
      findById: vi.fn().mockResolvedValue(currentMission),
      listTasks: vi.fn().mockResolvedValue([]),
      applyPlan: vi.fn(),
    };
    const planner: AutonomousMissionPlanner = { plan: vi.fn() };
    const supervisor: AutonomousSupervisor = {
      reconcilePreparedDispatches: vi.fn(),
      settleIfComplete: vi.fn(async () => ({ settled: false as const, reason: "TEST_NOT_SETTLED" })),
      run: vi.fn(),
    };
    const runner = new AutonomousMissionRunner(
      missions,
      supervisor,
      planner,
      {
        maxCycles: 20,
        maxRuntimeMs: 3_600_000,
        maxStagnationCycles: 3,
        maxReplans: 2,
      },
      () => now,
      repository,
    );

    const result = await runner.run(currentMission.id);

    expect(result.state).toBe("escalated");
    expect(result.reason).toBe("AUTONOMY_REPLAN_BUDGET_EXCEEDED");
    expect(repository.current.state).toBe("escalated");
    expect(planner.plan).not.toHaveBeenCalled();
    expect(missions.applyPlan).not.toHaveBeenCalled();
  });
});
