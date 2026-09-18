import { describe, expect, it, vi } from "vitest";

import type { Mission, MissionTask } from "@/core/mission/contracts";

import type { AutonomousMissionPlanner } from "@/server/autonomy/autonomous-mission-runner";

import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

import { AutonomyWakeupService } from "@/server/autonomy/autonomy-wakeup-service";

function runtime(overrides: Partial<AutonomousMissionRuntime> = {}): AutonomousMissionRuntime {
  const now = new Date("2026-09-13T18:00:00.000Z");

  return {
    missionId: "mission-1",
    state: "waiting",

    startedAt: now,
    updatedAt: now,

    lastHeartbeatAt: now,
    lastProgressAt: now,

    cycleCount: 3,
    replanCount: 0,
    stagnationCount: 0,

    maxCycles: 100,
    maxReplans: 5,
    maxRuntimeMs: 3_600_000,
    maxStagnationCycles: 3,

    lastReason: "AUTONOMY_EXTERNAL_WORK_PENDING",

    ownerToken: null,
    leaseUntil: null,

    ...overrides,
  };
}

describe("N2.7 event-driven autonomy wakeup", () => {
  it("keeps legacy Supervisor continuation when no autonomous runtime exists", async () => {
    const supervisor = {
      run: vi.fn().mockResolvedValue(undefined),

      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
    };

    const runtimeRepo: AutonomousMissionRuntimeRepository = {
      create: vi.fn(),

      createIfAbsent: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue(null),
      listRecoverable: vi.fn().mockResolvedValue([]),

      save: vi.fn(),

      claim: vi.fn().mockResolvedValue(true),

      release: vi.fn().mockResolvedValue(undefined),

      saveOwned: vi.fn().mockResolvedValue(undefined),
      renewClaim: vi.fn().mockResolvedValue(false),
    };

    const missions = {
      findById: vi.fn(),
      listTasks: vi.fn(),
      applyPlan: vi.fn(),
    };

    const wakeup = new AutonomyWakeupService(missions, supervisor, runtimeRepo);

    const result = await wakeup.wake("legacy-mission");

    expect(result).toBeNull();

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(supervisor.run).toHaveBeenCalledWith("legacy-mission");
  });

  it("resumes an autonomous waiting mission through the durable runner", async () => {
    let currentMission: Mission = {
      id: "mission-1",
      title: "Mission",
      objective: "Autonomy",
      status: "draft",
      createdAt: new Date("2026-09-13T18:00:00.000Z"),
      updatedAt: new Date("2026-09-13T18:00:00.000Z"),
    };

    let tasks: MissionTask[] = [
      {
        id: "mt-a",
        missionId: "mission-1",
        taskId: "canonical-a",
        title: "A",
        description: "A",
        dependsOn: [],
        status: "succeeded",
        workerKind: "agent",
        capability: null,
      },
      {
        id: "mt-b",
        missionId: "mission-1",
        taskId: "canonical-b",
        title: "B",
        description: "B",
        dependsOn: ["mt-a"],
        status: "draft",
        workerKind: "agent",
        capability: null,
      },
    ];

    let stored = runtime();

    const runtimeRepo: AutonomousMissionRuntimeRepository = {
      create: vi.fn(),

      createIfAbsent: vi.fn().mockResolvedValue(true),

      get: vi.fn().mockImplementation(async () => stored),

      listRecoverable: vi.fn().mockResolvedValue([]),

      save: vi.fn().mockImplementation(async (next) => {
        stored = {
          ...next,
        };
      }),

      claim: vi.fn().mockResolvedValue(true),

      release: vi.fn().mockResolvedValue(undefined),

      saveOwned: vi.fn().mockImplementation(async (next: AutonomousMissionRuntime) => {
        stored = next;
      }),
      renewClaim: vi.fn().mockResolvedValue(false),
    };

    const missions = {
      findById: vi.fn().mockImplementation(async () => currentMission),

      listTasks: vi.fn().mockImplementation(async () => tasks),

      applyPlan: vi.fn(),
    };

    const supervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),

      run: vi.fn().mockImplementation(async () => {
        tasks = [
          tasks[0],
          {
            ...tasks[1],
            status: "queued",
          },
        ];

        currentMission = {
          ...currentMission,
          updatedAt: new Date("2026-09-13T18:01:00.000Z"),
        };
      }),
    };

    const wakeup = new AutonomyWakeupService(
      missions,
      supervisor,
      runtimeRepo,
      () => new Date("2026-09-13T18:01:00.000Z"),
    );

    const result = await wakeup.wake("mission-1");

    expect(result?.state).toBe("waiting");

    expect(result?.cycleCount).toBe(4);

    expect(supervisor.run).toHaveBeenCalledTimes(1);

    expect(stored.state).toBe("waiting");

    expect(stored.cycleCount).toBe(4);

    expect(missions.applyPlan).not.toHaveBeenCalled();
  });

  it("uses the production planner to recover an abandoned empty runtime", async () => {
    let stored = runtime({
      state: "running",
      lastReason: "AUTONOMY_STARTED",
    });

    const runtimeRepo: AutonomousMissionRuntimeRepository = {
      create: vi.fn(),
      createIfAbsent: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockImplementation(async () => stored),
      listRecoverable: vi.fn().mockResolvedValue([]),
      save: vi.fn(),
      claim: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      saveOwned: vi.fn().mockImplementation(async (next: AutonomousMissionRuntime) => {
        stored = next;
      }),
      renewClaim: vi.fn().mockResolvedValue(false),
    };
    const mission: Mission = {
      id: "mission-1",
      title: "Recover planning",
      objective: "Build a safe plan",
      status: "planning",
      createdAt: stored.startedAt,
      updatedAt: stored.updatedAt,
    };
    let tasks: MissionTask[] = [];
    const missions = {
      findById: vi.fn().mockResolvedValue(mission),
      listTasks: vi.fn().mockImplementation(async () => tasks),
      applyPlan: vi.fn().mockImplementation(async () => {
        tasks = [
          {
            id: "mission-task-1",
            missionId: mission.id,
            taskId: "canonical-task-1",
            title: "Execute",
            description: "Execute the objective",
            dependsOn: [],
            status: "draft",
            workerKind: "hermes",
            capability: null,
          },
        ];
        return tasks;
      }),
    };
    const supervisor = {
      reconcilePreparedDispatches: vi.fn().mockResolvedValue(undefined),
      run: vi.fn().mockImplementation(async () => {
        tasks = [{ ...tasks[0], status: "queued" }];
      }),
    };
    const productionPlanner: AutonomousMissionPlanner = {
      plan: vi.fn().mockResolvedValue({
        version: 1,
        tasks: [{ key: "execute", title: "Execute", dependsOn: [] }],
      }),
    };
    const wakeup = new AutonomyWakeupService(
      missions,
      supervisor,
      runtimeRepo,
      () => new Date("2026-09-13T18:01:00.000Z"),
      productionPlanner,
    );

    const result = await wakeup.wake(mission.id);

    expect(productionPlanner.plan).toHaveBeenCalledWith({
      mission,
      tasks: [],
      reason: "initial",
      signal: expect.any(AbortSignal),
    });
    expect(missions.applyPlan).toHaveBeenCalledTimes(1);
    expect(supervisor.run).toHaveBeenCalledTimes(1);
    expect(result?.state).toBe("waiting");
  });

  it("fails closed if autonomous runtime exists but its DAG is unexpectedly empty", async () => {
    const stored = runtime();

    const runtimeRepo: AutonomousMissionRuntimeRepository = {
      create: vi.fn(),

      createIfAbsent: vi.fn().mockResolvedValue(true),

      get: vi.fn().mockResolvedValue(stored),

      listRecoverable: vi.fn().mockResolvedValue([]),

      save: vi.fn().mockResolvedValue(undefined),

      claim: vi.fn().mockResolvedValue(true),

      release: vi.fn().mockResolvedValue(undefined),

      saveOwned: vi.fn().mockResolvedValue(undefined),
      renewClaim: vi.fn().mockResolvedValue(false),
    };

    const mission: Mission = {
      id: "mission-1",
      title: "Broken",
      objective: "Must fail closed",
      status: "draft",
      createdAt: stored.startedAt,
      updatedAt: stored.updatedAt,
    };

    const missions = {
      findById: vi.fn().mockResolvedValue(mission),

      listTasks: vi.fn().mockResolvedValue([]),

      applyPlan: vi.fn(),
    };

    const supervisor = {
      run: vi.fn(),

      reconcilePreparedDispatches: vi.fn(),
    };

    const wakeup = new AutonomyWakeupService(
      missions,
      supervisor,
      runtimeRepo,
      () => new Date("2026-09-13T18:00:30.000Z"),
    );

    await expect(wakeup.wake("mission-1")).rejects.toThrow("AUTONOMY_WAKEUP_PLANNER_UNAVAILABLE");

    expect(missions.applyPlan).not.toHaveBeenCalled();
  });
});
