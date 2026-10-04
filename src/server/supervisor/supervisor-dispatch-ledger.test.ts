import { describe, expect, it, vi } from "vitest";

import { buildMemoryContainer } from "@/server/container";
import { SupervisorService } from "@/server/supervisor/supervisor-service";
import { InMemoryDispatchAttemptRepository } from "@/server/services/in-memory/dispatch-attempt-repository";
import type { TaskExecutionDispatcher, TaskExecutionDispatchInput } from "@/server/execution/ports";
import { executionPrompt } from "@/core/review/output-contract";

describe("Supervisor N2.3 durable dispatch ledger", () => {
  it("prepare l'intention avant le dispatch et la marque dispatched après succès", async () => {
    const container = buildMemoryContainer({
      agents: [],
      tasks: [],
      actions: [],
    });

    const mission = await container.mission.create({
      title: "N2.3",
      objective: "durable dispatch",
      tasks: [
        {
          title: "A",
          description: "A",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });

    const attempts = new InMemoryDispatchAttemptRepository(container.mission, container.tasks);

    const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
      workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
    }));

    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      { dispatch } as TaskExecutionDispatcher,
      container.durableMemory,
      attempts,
    );

    await supervisor.run(mission.id);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: mission.id,
        taskTitle: "A",
        prompt: executionPrompt("A"),
        workerKind: "agent",
      }),
    );

    const task = (await container.mission.listTasks(mission.id))[0];

    expect(task.status).toBe("queued");

    const workflowId = `icos-task-${task.taskId}`;
    const attempt = await attempts.getByWorkflowId(workflowId);

    expect(attempt).not.toBeNull();
    expect(attempt?.state).toBe("dispatched");
    expect(attempt?.attempt).toBe(1);

    await container.close();
  });

  it("reprend un prepared après crash avec exactement le même workflowId", async () => {
    const container = buildMemoryContainer({
      agents: [],
      tasks: [],
      actions: [],
    });

    const mission = await container.mission.create({
      title: "N2.3 crash",
      objective: "recover prepared dispatch",
      tasks: [
        {
          title: "A",
          description: "A",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });

    const task = (await container.mission.listTasks(mission.id))[0];

    const attempts = new InMemoryDispatchAttemptRepository(container.mission, container.tasks);

    const workflowId = `icos-task-${task.taskId}`;

    await attempts.prepare({
      missionId: mission.id,
      missionTaskId: task.id,
      taskId: task.taskId,
      attempt: 1,
      workflowId,
      prompt: executionPrompt("A"),
      workerKind: "agent",
    });

    // Simulates a fresh process after the crash.
    const dispatch = vi.fn(async (input: TaskExecutionDispatchInput) => ({
      workflowId: input.workflowId ?? `icos-task-${input.taskId}`,
    }));

    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      { dispatch } as TaskExecutionDispatcher,
      container.durableMemory,
      attempts,
    );

    await supervisor.reconcilePreparedDispatches(mission.id);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0][0].workflowId).toBe(workflowId);
    expect(dispatch.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        missionId: mission.id,
        taskTitle: "A",
        taskId: task.taskId,
      }),
    );

    const recovered = await attempts.getByWorkflowId(workflowId);
    expect(recovered?.state).toBe("dispatched");

    await container.close();
  });

  it("reste prepared si le transport échoue afin de pouvoir réessayer", async () => {
    const container = buildMemoryContainer({
      agents: [],
      tasks: [],
      actions: [],
    });

    const mission = await container.mission.create({
      title: "N2.3 failure",
      objective: "preserve prepared",
      tasks: [
        {
          title: "A",
          description: "A",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });

    const attempts = new InMemoryDispatchAttemptRepository(container.mission, container.tasks);

    const dispatch = vi.fn(async () => {
      throw new Error("TEMPORAL_UNAVAILABLE");
    });

    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      { dispatch } as unknown as TaskExecutionDispatcher,
      container.durableMemory,
      attempts,
    );

    await expect(supervisor.run(mission.id)).rejects.toThrow("TEMPORAL_UNAVAILABLE");

    const task = (await container.mission.listTasks(mission.id))[0];

    const attempt = await attempts.getByWorkflowId(`icos-task-${task.taskId}`);

    expect(task.status).toBe("queued");
    expect(attempt?.state).toBe("prepared");

    await container.close();
  });

  it("reste prepared si l'accusé externe ne correspond pas à l'identité durable", async () => {
    const container = buildMemoryContainer({ agents: [], tasks: [], actions: [] });
    const mission = await container.mission.create({
      title: "N2.3 mismatch",
      objective: "reject mismatched acknowledgement",
      tasks: [
        {
          title: "A",
          description: "A",
          dependsOn: [],
          workerKind: "agent",
        },
      ],
    });
    const attempts = new InMemoryDispatchAttemptRepository(container.mission, container.tasks);
    const dispatch = vi.fn(async () => ({ workflowId: "wrong-workflow" }));
    const supervisor = new SupervisorService(
      container.mission,
      container.tasks,
      { dispatch } as TaskExecutionDispatcher,
      container.durableMemory,
      attempts,
    );

    await expect(supervisor.run(mission.id)).rejects.toThrow(
      "DISPATCH_ACKNOWLEDGEMENT_ID_MISMATCH",
    );

    const task = (await container.mission.listTasks(mission.id))[0];
    expect((await attempts.getByWorkflowId(`icos-task-${task.taskId}`))?.state).toBe("prepared");
    await container.close();
  });
});
