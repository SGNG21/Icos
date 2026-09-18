import { Client, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskExecutionDispatchInput } from "./ports";
import { TemporalTaskExecutionDispatcher } from "./temporal-task-execution-dispatcher";

describe("TemporalTaskExecutionDispatcher", () => {
  let dispatcher: TemporalTaskExecutionDispatcher;
  let mockStart: ReturnType<typeof vi.fn>;
  let mockClient: Client;

  beforeEach(() => {
    mockStart = vi.fn();
    mockClient = {
      workflow: { start: mockStart },
      workflowService: {},
      connection: {},
      loadedDataConverter: {},
      withDeadline: vi.fn(async (_deadline: number, start: () => Promise<unknown>) => start()),
      withAbortSignal: vi.fn(async (_signal: AbortSignal, start: () => Promise<unknown>) =>
        start(),
      ),
      activity: {},
      schedule: {},
      taskQueue: {},
    } as unknown as Client;
    dispatcher = new TemporalTaskExecutionDispatcher(
      "localhost:7233",
      "hello-world",
      "runIcosTask",
      true,
      mockClient,
      10_000,
    );
  });

  it("starts one correlated external worker workflow and returns its workflowId", async () => {
    const input: TaskExecutionDispatchInput = {
      missionId: "mission1",
      taskId: "task1",
      taskTitle: "Implement feature",
      prompt: "test prompt",
      workerKind: "hermes",
      capability: "repository.edit",
    };
    mockStart.mockResolvedValueOnce({ workflowId: "icos-task-task1" });

    const result = await dispatcher.dispatch(input);

    expect(result).toEqual({ workflowId: "icos-task-task1" });
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockClient.withDeadline).toHaveBeenCalledWith(expect.any(Number), expect.any(Function));
    expect(mockStart).toHaveBeenCalledWith(
      "runIcosTask",
      expect.objectContaining({
        taskQueue: "hello-world",
        workflowId: "icos-task-task1",
        args: [
          {
            missionId: "mission1",
            taskId: "task1",
            workflowId: "icos-task-task1",
            title: "Implement feature",
            prompt: "test prompt",
            workerKind: "hermes",
            capability: "repository.edit",
          },
        ],
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
      }),
    );
  });

  it("treats an existing active workflow as success-equivalent", async () => {
    const input = { taskId: "task1", prompt: "test prompt" };
    const handle = { workflowId: "icos-task-task1" };
    mockStart.mockResolvedValue(handle);

    await expect(dispatcher.dispatch(input)).resolves.toEqual(handle);
    await expect(dispatcher.dispatch(input)).resolves.toEqual(handle);
    expect(mockStart).toHaveBeenCalledTimes(2);
  });

  it("treats a duplicate closed workflow as success-equivalent", async () => {
    const input = { taskId: "task1", prompt: "test prompt" };
    mockStart
      .mockResolvedValueOnce({ workflowId: "icos-task-task1" })
      .mockRejectedValueOnce(
        new WorkflowExecutionAlreadyStartedError("duplicate", "icos-task-task1", "run-id"),
      );

    await expect(dispatcher.dispatch(input)).resolves.toEqual({ workflowId: "icos-task-task1" });
    await expect(dispatcher.dispatch(input)).resolves.toEqual({ workflowId: "icos-task-task1" });
  });

  it("normalizes non-duplicate Temporal errors without leaking provider details", async () => {
    mockStart.mockRejectedValueOnce(new Error("Temporal connection error Authorization: secret"));

    await expect(dispatcher.dispatch({ taskId: "task1", prompt: "test prompt" })).rejects.toThrow(
      "TEMPORAL_DISPATCH_UNCERTAIN",
    );
  });

  it("uses an explicit deterministic workflowId", async () => {
    mockStart.mockResolvedValueOnce({ workflowId: "custom-id" });

    const result = await dispatcher.dispatch({
      taskId: "task1",
      prompt: "test prompt",
      workflowId: "custom-id",
    });

    expect(result).toEqual({ workflowId: "custom-id" });
    expect(mockStart).toHaveBeenCalledWith(
      "runIcosTask",
      expect.objectContaining({
        workflowId: "custom-id",
        args: [expect.objectContaining({ workflowId: "custom-id" })],
      }),
    );
  });

  it("binds Temporal start to the caller AbortSignal", async () => {
    const controller = new AbortController();
    mockStart.mockResolvedValueOnce({ workflowId: "icos-task-task1" });

    await dispatcher.dispatch({
      taskId: "task1",
      prompt: "test prompt",
      signal: controller.signal,
    });

    expect(mockClient.withAbortSignal).toHaveBeenCalledWith(
      controller.signal,
      expect.any(Function),
    );
  });

  it("fails before contacting Temporal when already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("ownership lost"));

    await expect(
      dispatcher.dispatch({
        taskId: "task1",
        prompt: "test prompt",
        signal: controller.signal,
      }),
    ).rejects.toThrow("TEMPORAL_DISPATCH_ABORTED");
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockClient.withDeadline).not.toHaveBeenCalled();
  });
});
