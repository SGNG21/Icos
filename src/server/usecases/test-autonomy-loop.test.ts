import { buildMemoryContainer } from "@/server/container";
import { describe, it } from "vitest";

describe("autonomy loop", () => {
  it("should run the supervisor loop and succeed", async () => {
    const container = buildMemoryContainer();

    // Create a mission with one simple task that we will simulate as success
    const mission = await container.mission.create({
      title: "Autonomy Test Mission",
      objective: "Test the supervisor loop with in-memory repositories",
      tasks: [
        {
          title: "Task 1",
          description: "Do something simple",
          dependsOn: [],
          workerKind: "agent",
          capability: "test.capability",
        },
      ],
    });

    console.log(`Created mission ${mission.id}`);

    // Get the mission tasks (includes canonical task id)
    const missionTasks = await container.mission.listTasks(mission.id);
    const missionTask = missionTasks[0];
    if (!missionTask) throw new Error("No mission task found");
    console.log(
      `Mission task ${missionTask.id} (canonical task id: ${missionTask.taskId}) status: ${missionTask.status}`,
    );

    // Run the supervisor - should dispatch the task
    const { SupervisorService } = await import("@/server/supervisor/supervisor-service");
    const supervisorService = new SupervisorService(
      container.mission,
      container.tasks,
      container.taskExecution,
      container.durableMemory,
    );

    await supervisorService.run(mission.id);
    console.log("Supervisor run completed");

    // After supervisor run, mission task should be queued
    const updatedMissionTasks = await container.mission.listTasks(mission.id);
    const updatedMissionTask = updatedMissionTasks.find((t) => t.id === missionTask.id);
    console.log(`Mission task status after supervisor: ${updatedMissionTask?.status}`);

    // Simulate successful callback: record task execution success using the canonical task id
    const { recordTaskExecution } = await import("@/server/usecases/record-task-execution");
    const recordResult = await recordTaskExecution(
      {
        tasks: container.tasks,
        executionResults: container.executionResults,
        supervisor: supervisorService,
        missions: container.mission,
        durableMemory: container.durableMemory,
      },
      {
        taskId: updatedMissionTask!.taskId, // canonical task id
        workflowId: `icos-task-${updatedMissionTask!.taskId}`,
        outcome: "success",
        completedAt: new Date().toISOString(),
      },
    );

    if (!recordResult.ok) {
      throw new Error(`Failed to record task execution: ${recordResult.message}`);
    }
    console.log("Task execution recorded as success");

    // Now record mission task execution (this updates mission task status and triggers supervisor)
    const { recordMissionTaskExecution } =
      await import("@/server/usecases/record-mission-task-execution");
    try {
      await recordMissionTaskExecution(
        {
          executionResults: container.executionResults,
          supervisor: supervisorService,
          missions: container.mission,
          tasks: container.tasks,
          reviewer: container.reviewer,
          reviewDecisions: container.reviewDecisions,
        },
        {
          missionId: mission.id,
          taskId: updatedMissionTask!.taskId, // canonical task id
          workflowId: `icos-task-${updatedMissionTask!.taskId}`,
          outcome: "success",
          completedAt: new Date().toISOString(),
        },
      );
      console.log("Mission task execution recorded");
    } catch (error) {
      throw new Error(`Failed to record mission task execution: ${error}`);
    }

    // After recording mission task execution, we expect the mission task to be succeeded
    const missionTasksAfterCallback = await container.mission.listTasks(mission.id);
    const missionTaskAfterCallback = missionTasksAfterCallback.find((t) => t.id === missionTask.id);
    console.log(`Mission task status after callback: ${missionTaskAfterCallback?.status}`);

    // Run supervisor again to see if it marks mission as succeeded
    await supervisorService.run(mission.id);
    console.log("Second supervisor run completed");

    const finalMissionTasks = await container.mission.listTasks(mission.id);
    const finalMissionTask = finalMissionTasks.find((t) => t.id === missionTask.id);
    console.log(`Final mission task status: ${finalMissionTask?.status}`);

    const finalMission = await container.mission.findById(mission.id);
    console.log(`Final mission status: ${finalMission?.status}`);

    // Expect mission succeeded
    if (finalMission?.status !== "succeeded") {
      throw new Error(`Expected mission succeeded, got ${finalMission?.status}`);
    }

    console.log("Autonomy loop test passed!");

    await container.close();
  });
});
