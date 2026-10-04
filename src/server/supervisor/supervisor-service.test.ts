import { describe, expect, it, vi } from "vitest";
import { SupervisorService } from "./supervisor-service";
import type { MissionRepository } from "@/server/mission/ports";
import type { TaskRepository } from "@/server/repositories/ports";
import type { TaskExecutionDispatcher } from "@/server/execution/ports";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { PostgresDurableMemory } from "@/server/repositories/postgres/postgres-durable-memory";

// Mock the loadMissionCheckpoint usecase to avoid needing a durableMemory in tests
vi.mock("@/server/usecases/load-mission-checkpoint", () => ({
  loadMissionCheckpoint: vi.fn().mockResolvedValue({ ok: true }),
}));

describe("SupervisorService", () => {
  it("should dispatch tasks A, B, C correctly", async () => {
    // Setup mocks
    const mission: Mission = {
      id: "m1",
      title: "Test Mission",
      objective: "ABC",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const tasks: MissionTask[] = [
      {
        id: "t1",
        missionId: "m1",
        title: "A",
        description: "Step A",
        dependsOn: [],
        status: "draft",
        taskId: "task-t1",
      },
      {
        id: "t2",
        missionId: "m1",
        title: "B",
        description: "Step B",
        dependsOn: ["t1"],
        status: "draft",
        taskId: "task-t2",
      },
      {
        id: "t3",
        missionId: "m1",
        title: "C",
        description: "Step C",
        dependsOn: ["t2"],
        status: "draft",
        taskId: "task-t3",
      },
    ];

    const missionRepository: MissionRepository = {
      applyPlan: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(mission),
      findById: vi.fn(async () => mission),
      findByGoalId: vi.fn(async () => null),
      list: vi.fn().mockResolvedValue([mission]),
      listTasks: vi.fn().mockResolvedValue(tasks),
      updateMissionTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateMissionStatus: vi.fn().mockResolvedValue(undefined),
      getMissionIdByTaskId: vi.fn().mockResolvedValue("m1"),
      getMissionTaskById: vi.fn().mockResolvedValue(undefined),
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue(undefined),
      deleteMission: vi.fn().mockResolvedValue(undefined),
      updateMissionTaskDependsOn: vi.fn().mockResolvedValue(undefined),
      updateMission: vi.fn().mockResolvedValue(undefined),
    };
    const taskRepository = {} as TaskRepository;

    const dispatchedTasks: string[] = [];
    const dispatcher: TaskExecutionDispatcher = {
      dispatch: vi.fn().mockImplementation(({ taskId }) => {
        dispatchedTasks.push(taskId);
        return Promise.resolve({ workflowId: `w-${taskId}` });
      }),
    };

    // We need to mock the db import (still used by the actual PostgresDurableMemory, but we are mocking the whole class)
    vi.doMock("@/server/database", () => ({
      db: {
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      },
    }));

    // Mock the durableMemory (PostgresDurableMemory) that the SupervisorService now expects
    // We need to provide a mock db and the required methods.
    const durableMemory = {
      getCheckpoints: vi.fn().mockResolvedValue([]),
      saveCheckpoint: vi.fn().mockResolvedValue(undefined),
      getLatestCheckpoint: vi.fn().mockResolvedValue(null),
      getCheckpointById: vi.fn().mockResolvedValue(null),
      saveDecision: vi.fn().mockResolvedValue(undefined),
      getDecisions: vi.fn().mockResolvedValue([]),
      saveExecutionResult: vi.fn().mockResolvedValue(undefined),
      getExecutionResults: vi.fn().mockResolvedValue([]),
      savePattern: vi.fn().mockResolvedValue(undefined),
      getPatterns: vi.fn().mockResolvedValue([]),
      saveContextItem: vi.fn().mockResolvedValue(undefined),
      queryContextItems: vi.fn().mockResolvedValue([]),
      saveHandoffPackage: vi.fn().mockResolvedValue(undefined),
      getHandoffPackage: vi.fn().mockResolvedValue(null),
      cleanup: vi.fn().mockResolvedValue(0),
    } as unknown as PostgresDurableMemory;

    const supervisor = new SupervisorService(
      missionRepository,
      taskRepository,
      dispatcher,
      durableMemory,
    );

    // Act 1: Run with A succeeded
    tasks[0].status = "succeeded";
    await supervisor.run("m1");

    // Assert 1: A succeeded, so B should be dispatched
    expect(dispatchedTasks).toContain("task-t2");
    expect(dispatchedTasks).not.toContain("task-t1"); // A was already succeeded

    // Act 2: Run again with B failed
    tasks[1].status = "failed";
    await supervisor.run("m1");

    // Assert 2: B failed, so C should NOT be dispatched
    expect(dispatchedTasks).not.toContain("t3");
  });

  it("stops before another legacy dispatch when ownership is aborted", async () => {
    const mission: Mission = {
      id: "m-abort",
      title: "Abort mission",
      objective: "Stop stale dispatches",
      status: "running",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const tasks: MissionTask[] = [
      {
        id: "t-abort-a",
        missionId: mission.id,
        title: "A",
        description: "A",
        dependsOn: [],
        status: "draft",
        taskId: "task-abort-a",
      },
      {
        id: "t-abort-b",
        missionId: mission.id,
        title: "B",
        description: "B",
        dependsOn: [],
        status: "draft",
        taskId: "task-abort-b",
      },
    ];

    const missionRepository: MissionRepository = {
      applyPlan: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue(mission),
      findById: vi.fn().mockResolvedValue(mission),
      findByGoalId: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([mission]),
      listTasks: vi.fn().mockResolvedValue(tasks),
      updateMissionTaskStatus: vi.fn().mockResolvedValue(undefined),
      updateMissionStatus: vi.fn().mockResolvedValue(undefined),
      getMissionIdByTaskId: vi.fn().mockResolvedValue(mission.id),
      getMissionTaskById: vi.fn().mockResolvedValue(undefined),
      getMissionTaskByCanonicalTaskId: vi.fn().mockResolvedValue(undefined),
      deleteMission: vi.fn().mockResolvedValue(undefined),
      updateMissionTaskDependsOn: vi.fn().mockResolvedValue(undefined),
      updateMission: vi.fn().mockResolvedValue(undefined),
    };

    const controller = new AbortController();

    const dispatcher: TaskExecutionDispatcher = {
      dispatch: vi.fn().mockImplementation(async () => {
        controller.abort(new Error("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST"));
        return { workflowId: "workflow-abort" };
      }),
    };

    const supervisor = new SupervisorService(
      missionRepository,
      {} as TaskRepository,
      dispatcher,
      {} as PostgresDurableMemory,
    );

    await expect(supervisor.run(mission.id, controller.signal)).rejects.toThrow(
      "AUTONOMOUS_RUNTIME_OWNERSHIP_LOST",
    );

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(missionRepository.updateMissionTaskStatus).toHaveBeenCalledTimes(1);
    expect(missionRepository.updateMissionStatus).not.toHaveBeenCalled();
  });
});
