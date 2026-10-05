import {
  Client,
  WorkflowExecutionAlreadyStartedError,
  WorkflowNotFoundError,
} from "@temporalio/client";
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DurableExecutionReconciler, TaskExecutionDispatchInput } from "./ports";
import { EXECUTION_IDENTITY_MEMO } from "./temporal-existing-execution";
import { TemporalTaskExecutionDispatcher } from "./temporal-task-execution-dispatcher";

/** A description shaped like the SDK's, carrying the identity a start would have stamped. */
function describedAs(overrides: {
  status?: string;
  taskQueue?: string;
  type?: string;
  memo?: Record<string, unknown>;
}) {
  return {
    status: { name: overrides.status ?? "RUNNING" },
    taskQueue: overrides.taskQueue ?? "hello-world",
    type: overrides.type ?? "runIcosTask",
    memo: overrides.memo,
  };
}

describe("TemporalTaskExecutionDispatcher", () => {
  let dispatcher: TemporalTaskExecutionDispatcher;
  let mockStart: ReturnType<typeof vi.fn>;
  let mockClient: Client;

  beforeEach(() => {
    mockStart = vi.fn();
    mockClient = {
      workflow: {
        start: mockStart,
        /* Only consulted when a start is refused: nothing here collides by default. */
        getHandle: vi.fn(() => ({
          describe: vi.fn(async () => {
            throw new WorkflowNotFoundError("absent", "icos-task-task1", "runIcosTask");
          }),
        })),
      },
      /* Models the production contract: a reachable server that reports its pollers. */
      workflowService: {
        describeTaskQueue: vi.fn(async () => ({ pollers: [{ identity: "w1" }] })),
      },
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
      attempt: 1,
      taskTitle: "Implement feature",
      prompt: "test prompt",
      workerKind: "hermes",
      capability: "repository.edit",
    };
    mockStart.mockResolvedValueOnce({ workflowId: "icos-task-task1" });

    const result = await dispatcher.dispatch(input);

    expect(result).toEqual({ workflowId: "icos-task-task1", disposition: "started" });
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
        /*
         * NEVER `USE_EXISTING`. That policy made Temporal answer a start request for a
         * taken id with a handle to whatever was open — any queue, any type, any task,
         * any attempt — and the adapter had no way to tell it from an execution it had
         * just created. `FAIL` means the only handle `start` can return is a genuinely
         * new execution, so every reuse has to be proven instead.
         */
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      }),
    );
  });

  it("stamps the ICOS identity in the memo, where a later describe can read it", async () => {
    /*
     * The workflow arguments are not part of a description, so without this a later
     * dispatch looking at the same id learns only queue, type and status — nothing about
     * WHOSE execution it is, which is the whole question.
     */
    mockStart.mockResolvedValueOnce({ workflowId: "icos-task-task1" });

    await dispatcher.dispatch({
      missionId: "mission1",
      taskId: "task1",
      attempt: 3,
      prompt: "test prompt",
    });

    expect(mockStart).toHaveBeenCalledWith(
      "runIcosTask",
      expect.objectContaining({
        memo: {
          [EXECUTION_IDENTITY_MEMO.taskId]: "task1",
          [EXECUTION_IDENTITY_MEMO.attempt]: 3,
          [EXECUTION_IDENTITY_MEMO.missionId]: "mission1",
        },
      }),
    );
  });

  it("normalizes non-duplicate Temporal errors without leaking provider details", async () => {
    mockStart.mockRejectedValueOnce(new Error("Temporal connection error Authorization: secret"));

    await expect(
      dispatcher.dispatch({ taskId: "task1", attempt: 1, prompt: "test prompt" }),
    ).rejects.toThrow("TEMPORAL_DISPATCH_UNCERTAIN");
  });

  it("uses an explicit deterministic workflowId", async () => {
    mockStart.mockResolvedValueOnce({ workflowId: "custom-id" });

    const result = await dispatcher.dispatch({
      taskId: "task1",
      attempt: 1,
      prompt: "test prompt",
      workflowId: "custom-id",
    });

    expect(result).toEqual({ workflowId: "custom-id", disposition: "started" });
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
      attempt: 1,
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
        attempt: 1,
        prompt: "test prompt",
        signal: controller.signal,
      }),
    ).rejects.toThrow("TEMPORAL_DISPATCH_ABORTED");
    expect(mockStart).not.toHaveBeenCalled();
    expect(mockClient.withDeadline).not.toHaveBeenCalled();
  });
});

/**
 * A WORKFLOW ID THAT IS ALREADY TAKEN IS NOT A SUCCESSFUL DISPATCH.
 *
 * Temporal workflow ids are global and persistent. `icos-task-<taskId>` can already be
 * held by an execution on a foreign task queue, of a foreign task or attempt, or one that
 * closed days ago — and under `USE_EXISTING` every one of those came back as a handle the
 * adapter returned as a dispatch. The attempt was then recorded `dispatched`, no worker
 * ever ran it, and the only visible symptom arrived much later as a missing review.
 *
 * So the id being taken sends the dispatch through a proof step, and there are exactly
 * three ways out of it: idempotent reuse, reconciliation against ICOS's own settled
 * result, or a refusal naming the collision.
 */
describe("USE_EXISTING semantics: reuse is earned, never assumed", () => {
  const INPUT: TaskExecutionDispatchInput = {
    missionId: "m1",
    taskId: "t1",
    attempt: 2,
    prompt: "do it",
    workflowId: "icos-task-t1-attempt-2",
    executionClass: "DURABLE_MISSION_TASK",
  };

  const SAME_IDENTITY = {
    [EXECUTION_IDENTITY_MEMO.taskId]: "t1",
    [EXECUTION_IDENTITY_MEMO.attempt]: 2,
    [EXECUTION_IDENTITY_MEMO.missionId]: "m1",
  };

  function dispatcherWhereIdIsTaken(
    description: ReturnType<typeof describedAs> | Error,
    reconciler?: DurableExecutionReconciler,
  ) {
    /* The id is taken, so Temporal refuses to start: the only way to an existing one. */
    const start = vi.fn(async () => {
      throw new WorkflowExecutionAlreadyStartedError(
        "already started",
        "icos-task-t1-attempt-2",
        "runIcosTask",
      );
    });
    const describe_ = vi.fn(async () => {
      if (description instanceof Error) throw description;
      return description;
    });
    const client = {
      workflow: { start, getHandle: vi.fn(() => ({ describe: describe_ })) },
      workflowService: {
        describeTaskQueue: vi.fn(async () => ({ pollers: [{ identity: "w1" }] })),
      },
      withDeadline: vi.fn(async (_d: number, run: () => Promise<unknown>) => run()),
      withAbortSignal: vi.fn(async (_s: AbortSignal, run: () => Promise<unknown>) => run()),
    } as unknown as Client;
    return {
      start,
      dispatcher: new TemporalTaskExecutionDispatcher(
        "localhost:7233",
        "icos-tasks",
        "runIcosTask",
        true,
        client,
        10_000,
        "default",
        5_000,
        reconciler,
      ),
    };
  }

  it("OPEN_SAME_EXECUTION_REUSES: idempotent, and nothing is started twice", async () => {
    const { dispatcher, start } = dispatcherWhereIdIsTaken(
      describedAs({ status: "RUNNING", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
    );

    await expect(dispatcher.dispatch(INPUT)).resolves.toEqual({
      workflowId: "icos-task-t1-attempt-2",
      disposition: "reused",
    });
    /* SAME_ATTEMPT_NEVER_DOUBLE_EXECUTES: the start was refused and never retried. */
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("OPEN_FOREIGN_QUEUE_FAILS_CLOSED: an open execution on another queue is refused", async () => {
    /*
     * The gap the poller check could not close: it proves a consumer on the queue this
     * dispatcher intends to use, and says nothing about the queue the EXISTING execution
     * of that id sits on.
     */
    const { dispatcher } = dispatcherWhereIdIsTaken(
      describedAs({ status: "RUNNING", taskQueue: "someone-elses-queue", memo: SAME_IDENTITY }),
    );

    await expect(dispatcher.dispatch(INPUT)).rejects.toThrow("TEMPORAL_FOREIGN_TASK_QUEUE");
  });

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: another task, and another attempt", async () => {
    const foreignTask = dispatcherWhereIdIsTaken(
      describedAs({
        status: "RUNNING",
        taskQueue: "icos-tasks",
        memo: { ...SAME_IDENTITY, [EXECUTION_IDENTITY_MEMO.taskId]: "t2" },
      }),
    );
    await expect(foreignTask.dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_FOREIGN_TASK_IDENTITY",
    );

    const foreignAttempt = dispatcherWhereIdIsTaken(
      describedAs({
        status: "RUNNING",
        taskQueue: "icos-tasks",
        memo: { ...SAME_IDENTITY, [EXECUTION_IDENTITY_MEMO.attempt]: 1 },
      }),
    );
    await expect(foreignAttempt.dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_FOREIGN_ATTEMPT_IDENTITY",
    );
  });

  it("CLOSED_WITH_DURABLE_RESULT_RECONCILES: settled work is not run again", async () => {
    const hasTerminalResult = vi.fn(async (_workflowId: string) => true);
    const { dispatcher, start } = dispatcherWhereIdIsTaken(
      describedAs({ status: "COMPLETED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      { hasTerminalResult },
    );

    await expect(dispatcher.dispatch(INPUT)).resolves.toEqual({
      workflowId: "icos-task-t1-attempt-2",
      disposition: "reconciled",
    });
    expect(hasTerminalResult).toHaveBeenCalledWith("icos-task-t1-attempt-2");
    /* SAME_ATTEMPT_NEVER_DOUBLE_EXECUTES: no second execution of settled work. */
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("CLOSED_WITHOUT_RESULT_FAILS_CLOSED: a finished-but-unsettled execution", async () => {
    /*
     * The execution ended and ICOS never got its result. Reporting a dispatch here is the
     * exact shape of the original defect: the attempt sits at `dispatched` for ever.
     */
    const { dispatcher } = dispatcherWhereIdIsTaken(
      describedAs({ status: "COMPLETED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      { hasTerminalResult: vi.fn(async (_workflowId: string) => false) },
    );

    await expect(dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_CLOSED_WORKFLOW_WITHOUT_RESULT",
    );
  });

  it("TERMINATED_ATTEMPT_DOES_NOT_RESURRECT: refused, and named as terminated", async () => {
    /*
     * Termination skips the workflow's own error path, so no failure callback is ever
     * sent and ICOS holds no result. The attempt must not be restarted under its own id,
     * and must not be reported dispatched either.
     */
    const { dispatcher, start } = dispatcherWhereIdIsTaken(
      describedAs({ status: "TERMINATED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      { hasTerminalResult: vi.fn(async (_workflowId: string) => false) },
    );

    await expect(dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_TERMINATED_WORKFLOW_WITHOUT_RESULT",
    );
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("refuses a closed execution when no reconciler can answer at all", async () => {
    /* No evidence of settlement is not evidence of settlement. */
    const { dispatcher } = dispatcherWhereIdIsTaken(
      describedAs({ status: "COMPLETED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
    );

    await expect(dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_CLOSED_WORKFLOW_WITHOUT_RESULT",
    );
  });

  it("refuses when ICOS cannot be asked whether the execution settled", async () => {
    const { dispatcher } = dispatcherWhereIdIsTaken(
      describedAs({ status: "COMPLETED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      {
        hasTerminalResult: vi.fn(async (_workflowId: string): Promise<boolean> => {
          throw new Error("database down");
        }),
      },
    );

    await expect(dispatcher.dispatch(INPUT)).rejects.toThrow("TEMPORAL_RECONCILIATION_UNKNOWN");
  });

  it("refuses when the colliding execution cannot be read back", async () => {
    const vanished = dispatcherWhereIdIsTaken(
      new WorkflowNotFoundError("gone", "icos-task-t1-attempt-2", "runIcosTask"),
    );
    await expect(vanished.dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_EXISTING_WORKFLOW_VANISHED",
    );

    const unreadable = dispatcherWhereIdIsTaken(new Error("PERMISSION_DENIED"));
    await expect(unreadable.dispatcher.dispatch(INPUT)).rejects.toThrow(
      "TEMPORAL_EXISTING_WORKFLOW_UNREADABLE",
    );
  });

  it("NO_FALSE_DISPATCH_SUCCESS: no collision resolves to a plain started dispatch", async () => {
    /*
     * The single property the original defect violated. Whatever the existing execution
     * turns out to be, the answer is never "started" — because this call started nothing.
     */
    const collisions = [
      describedAs({ status: "RUNNING", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      describedAs({ status: "RUNNING", taskQueue: "other-queue", memo: SAME_IDENTITY }),
      describedAs({
        status: "RUNNING",
        taskQueue: "icos-tasks",
        type: "otherWorkflow",
        memo: SAME_IDENTITY,
      }),
      describedAs({ status: "RUNNING", taskQueue: "icos-tasks", memo: undefined }),
      describedAs({ status: "COMPLETED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      describedAs({ status: "TERMINATED", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
      describedAs({ status: "UNKNOWN", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
    ];

    for (const description of collisions) {
      const { dispatcher } = dispatcherWhereIdIsTaken(description, {
        hasTerminalResult: vi.fn(async (_workflowId: string) => false),
      });
      const outcome = await dispatcher.dispatch(INPUT).then(
        (result) => result.disposition,
        (error: Error) => error.message,
      );
      expect(outcome).not.toBe("started");
    }
  });

  it("NEW_ATTEMPT_REQUIRES_CORE3_RETRY_IDENTITY: the adapter invents no attempt", async () => {
    /*
     * A caller that cannot state its attempt gets a refusal, not a guess. The adapter
     * never derives or increments an attempt of its own: a retry's identity is issued by
     * CORE3 (`workflowIdForAttempt`), which is what keeps one logical attempt from
     * executing twice.
     */
    const { dispatcher } = dispatcherWhereIdIsTaken(
      describedAs({ status: "RUNNING", taskQueue: "icos-tasks", memo: SAME_IDENTITY }),
    );

    const { attempt: _omitted, ...withoutAttempt } = INPUT;
    await expect(dispatcher.dispatch(withoutAttempt)).rejects.toThrow(
      "TEMPORAL_EXISTING_ATTEMPT_UNVERIFIABLE",
    );
  });

  it("a certain refusal is never flattened into an uncertain dispatch", async () => {
    /*
     * `TEMPORAL_DISPATCH_UNCERTAIN` tells recovery "it may have landed, go and check".
     * A collision is certain, and sending recovery hunting for an execution this dispatch
     * deliberately declined to stand on is how a refusal becomes a stranded attempt.
     */
    const { dispatcher } = dispatcherWhereIdIsTaken(
      describedAs({ status: "RUNNING", taskQueue: "other-queue", memo: SAME_IDENTITY }),
    );

    await expect(dispatcher.dispatch(INPUT)).rejects.not.toThrow("TEMPORAL_DISPATCH_UNCERTAIN");
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
    attempt: 1,
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
      workflow: {
        start,
        getHandle: vi.fn(() => ({
          describe: vi.fn(async () => {
            throw new WorkflowNotFoundError("absent", "icos-task-t1", "runIcosTask");
          }),
        })),
      },
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

    await expect(dispatcher.dispatch(input)).resolves.toEqual({
      workflowId: "icos-task-t1",
      disposition: "started",
    });
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
      workflow: {
        start,
        getHandle: vi.fn(() => ({
          describe: vi.fn(async () => {
            throw new WorkflowNotFoundError("absent", "icos-task-t1", "runIcosTask");
          }),
        })),
      },
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
    await expect(dispatcher.dispatch(input)).resolves.toEqual({
      workflowId: "icos-task-t1",
      disposition: "started",
    });
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
