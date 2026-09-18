import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { InMemoryMissionRepository } from "../mission-repository";
import { InMemoryTaskRepository } from "../task-repository";
import { InMemoryAuditLog } from "../../../../../src/server/audit/in-memory-audit-log";

describe("InMemoryMissionRepository", () => {
  let missionRepository: InMemoryMissionRepository;
  let taskRepository: InMemoryTaskRepository;

  beforeEach(() => {
    const auditLog = new InMemoryAuditLog();
    taskRepository = new InMemoryTaskRepository(auditLog);
    missionRepository = new InMemoryMissionRepository(taskRepository);
  });

  it("should update dependsOn correctly", async () => {
    const mission = await missionRepository.create({
      title: "E2E Test Mission",
      objective: "Test the supervisor loop",
      tasks: [
        { title: "Task A", description: "STEP_A_OK", dependsOn: [], workerKind: "agent" },
        { title: "Task B", description: "STEP_B_OK", dependsOn: [], workerKind: "agent" },
        {
          title: "Task C",
          description: "SUPERVISOR_MISSION_OK",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });

    let tasks = await missionRepository.listTasks(mission.id);
    expect(tasks).toHaveLength(3);

    const taskA = tasks.find((t) => t.title === "Task A");
    const taskB = tasks.find((t) => t.title === "Task B");
    const taskC = tasks.find((t) => t.title === "Task C");

    expect(taskA).not.toBeNull();
    expect(taskB).not.toBeNull();
    expect(taskC).not.toBeNull();

    if (!taskA || !taskB || !taskC) {
      throw new Error("Tasks not found");
    }

    const taskAId = taskA.id;
    const taskBId = taskB.id;
    const taskCId = taskC.id;

    // Update the dependsOn for taskB and taskC in the mission tasks
    await missionRepository.updateMissionTaskDependsOn(taskBId, [taskAId]);
    await missionRepository.updateMissionTaskDependsOn(taskCId, [taskBId]);

    tasks = await missionRepository.listTasks(mission.id);
    const updatedTaskA = tasks.find((t) => t.id === taskAId);
    const updatedTaskB = tasks.find((t) => t.id === taskBId);
    const updatedTaskC = tasks.find((t) => t.id === taskCId);

    expect(updatedTaskA).not.toBeNull();
    expect(updatedTaskB).not.toBeNull();
    expect(updatedTaskC).not.toBeNull();

    expect(updatedTaskA?.dependsOn).toEqual([]);
    expect(updatedTaskB?.dependsOn).toEqual([taskAId]);
    expect(updatedTaskC?.dependsOn).toEqual([taskBId]);
  });
  it("should resolve mission id from canonical Task.id", async () => {
    const mission = await missionRepository.create({
      title: "Canonical task lookup",
      objective: "Match PostgreSQL getMissionIdByTaskId semantics",
      tasks: [
        {
          title: "Task A",
          description: "Lookup test",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });

    const missionTasks =
      await missionRepository.listTasks(mission.id);

    expect(missionTasks).toHaveLength(1);

    const missionTask = missionTasks[0];

    expect(missionTask.taskId).not.toBe(missionTask.id);

    await expect(
      missionRepository.getMissionIdByTaskId(
        missionTask.taskId,
      ),
    ).resolves.toBe(mission.id);

    await expect(
      missionRepository.getMissionIdByTaskId(
        missionTask.id,
      ),
    ).resolves.toBeNull();
  });

});
