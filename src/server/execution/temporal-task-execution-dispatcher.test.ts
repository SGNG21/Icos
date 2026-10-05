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
      /* Models the production contract: a reachable server that reports its pollers. */
      workflowService: { describeTaskQueue: vi.fn(async () => ({ pollers: [{ identity: "w1" }] })) },
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

/**
 * A DISPATCH NOBODY CAN CONSUME IS NOT A DISPATCH.
 *
 * Connecting to Temporal proves the server is up and says nothing about a worker. A
 * workflow started on a queue with no poller succeeds, returns a workflowId and leaves
 * the attempt recorded `dispatched` — and then nothing happens, for ever, with no error
 * anywhere. An entire integration family sat exactly like that: `dispatched`, no result,
 * no QC job, the reviewer never asked, and the only visible symptom was a missing review.
 *
 * So the queue's pollers are checked BEFORE anything durable is written.
 */
describe("durable dispatch fails closed when no worker is polling", () => {
  const input = {
    missionId: "m1",
    taskId: "t1",
    taskTitle: "T",
    prompt: "do it",
    executionClass: "DURABLE_MISSION_TASK",
  } as never;

  function dispatcherWith(pollers: unknown[] | Error, start = vi.fn()) {
    const describeTaskQueue = vi.fn(async () => {
      if (pollers instanceof Error) throw pollers;
      return { pollers };
    });
    const client = {
      workflow: { start },
      workflowService: { describeTaskQueue },
      withDeadline: vi.fn(async (_d: number, run: () => Promise<unknown>) => run()),
      withAbortSignal: vi.fn(async (_s: AbortSignal, run: () => Promise<unknown>) => run()),
    } as unknown as Client;
    return {
      describeTaskQueue,
      start,
      dispatcher: new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "icos-tasks",
        "runIcosTask",
        true,
        client,
        10_000,
      ),
    };
  }

  it("refuses, naming the queue, and starts no workflow", async () => {
    const { dispatcher, start } = dispatcherWith([]);

    await expect(dispatcher.dispatch(input)).rejects.toThrow("TEMPORAL_NO_CONSUMER");
    await expect(dispatcher.dispatch(input)).rejects.toThrow("icos-tasks");
    /* NO SILENT STRANDED TASK: nothing was enqueued, so nothing can sit dispatched. */
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses when it cannot prove a consumer either way", async () => {
    /* Being unable to answer is not a yes. */
    const { dispatcher, start } = dispatcherWith(new Error("UNAVAILABLE"));

    await expect(dispatcher.dispatch(input)).rejects.toThrow("TEMPORAL_CONSUMER_UNKNOWN");
    expect(start).not.toHaveBeenCalled();
  });

  it("dispatches normally once a worker is polling", async () => {
    const start = vi.fn(async () => ({ workflowId: "icos-task-t1" }));
    const { dispatcher } = dispatcherWith([{ identity: "worker-1" }], start);

    await expect(dispatcher.dispatch(input)).resolves.toEqual({ workflowId: "icos-task-t1" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("does not ask again for every dispatch in a burst", async () => {
    const start = vi.fn(async () => ({ workflowId: "icos-task-t1" }));
    const { dispatcher, describeTaskQueue } = dispatcherWith([{ identity: "worker-1" }], start);

    await dispatcher.dispatch(input);
    await dispatcher.dispatch(input);
    await dispatcher.dispatch(input);

    expect(describeTaskQueue).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("never caches a refusal, so a worker coming back takes effect at once", async () => {
    let pollers: unknown[] = [];
    const start = vi.fn(async () => ({ workflowId: "icos-task-t1" }));
    const client = {
      workflow: { start },
      workflowService: { describeTaskQueue: vi.fn(async () => ({ pollers })) },
      withDeadline: vi.fn(async (_d: number, run: () => Promise<unknown>) => run()),
      withAbortSignal: vi.fn(async (_s: AbortSignal, run: () => Promise<unknown>) => run()),
    } as unknown as Client;
    const dispatcher = new TemporalTaskExecutionDispatcher(
      "localhost:7233",
      "icos-tasks",
      "runIcosTask",
      true,
      client,
      10_000,
    );

    await expect(dispatcher.dispatch(input)).rejects.toThrow("TEMPORAL_NO_CONSUMER");
    pollers = [{ identity: "worker-1" }];
    await expect(dispatcher.dispatch(input)).resolves.toEqual({ workflowId: "icos-task-t1" });
  });

  it("does not disguise the refusal as an uncertain dispatch", async () => {
    /*
     * `dispatch` turns every start failure into TEMPORAL_DISPATCH_UNCERTAIN, which
     * recovery treats as "it may have landed, go and check". A refusal is certain: it
     * must not enter that path or recovery would hunt for a workflow that never existed.
     */
    const { dispatcher } = dispatcherWith([]);

    await expect(dispatcher.dispatch(input)).rejects.not.toThrow("TEMPORAL_DISPATCH_UNCERTAIN");
  });
});
