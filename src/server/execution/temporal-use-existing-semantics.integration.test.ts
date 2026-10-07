import { fileURLToPath } from "node:url";

import { Client, Connection } from "@temporalio/client";
import { WorkflowIdConflictPolicy, WorkflowIdReusePolicy } from "@temporalio/common";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { identities } from "@/test/test-identity";
import { waitForQueuePoller } from "@/test/temporal-runtime-harness";

import type { DurableExecutionReconciler, TaskExecutionDispatchInput } from "./ports";
import { EXECUTION_IDENTITY_MEMO } from "./temporal-existing-execution";
import { TemporalTaskExecutionDispatcher } from "./temporal-task-execution-dispatcher";

/**
 * THE CANONICAL USE_EXISTING SEMANTICS, PROVEN AGAINST A REAL TEMPORAL SERVER.
 *
 * The unit tests fix the decision; this fixes the premises the decision rests on, and a
 * mock cannot:
 *
 *   - that `WorkflowIdConflictPolicy.FAIL` really raises AlreadyStarted on this server
 *     rather than quietly returning the existing execution;
 *   - that the ICOS identity memo survives a real payload round-trip and comes back off
 *     `describe` in the shape the decision reads;
 *   - that an execution's task queue, type and status are reported as assumed;
 *   - that `REJECT_DUPLICATE` really refuses to restart a CLOSED id.
 *
 * Every state is created on the real server. Fixtures that only need to EXIST are started
 * with a raw client (an execution on a queue nobody polls simply sits there RUNNING,
 * which is exactly the foreign-queue case); the ones that must CLOSE are run by a real
 * worker.
 *
 * No ICOS state is touched: the reconciler is the narrow port, answered here by a set of
 * workflow ids, which is precisely the question the production wiring asks of the
 * execution-results ledger.
 *
 * Requires a reachable Temporal server (TEMPORAL_ADDRESS, default localhost:7233). A test
 * that cannot reach it FAILS, exactly as production would — it is not skipped.
 */

const ADDRESS = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
const NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? "default";

const ids = identities("usexist");

/** The queue this dispatcher targets, with a real worker on it. */
let taskQueue: string;
/** A queue nothing polls: where a FOREIGN execution is parked. */
let foreignQueue: string;

let client: Client;
let connection: Connection;
let nativeConnection: NativeConnection;
let worker: Worker;
let workerRun: Promise<void>;

/** Workflow ids ICOS is pretending to hold a durable terminal result for. */
const settled = new Set<string>();
const reconciler: DurableExecutionReconciler = {
  hasTerminalResult: async (workflowId) => settled.has(workflowId),
};

/** Started, and then terminated in cleanup so nothing is left running in the namespace. */
const openedFixtures: string[] = [];

function dispatcherFor(options: {
  queue?: string;
  workflowType?: string;
  reconcile?: boolean;
}): TemporalTaskExecutionDispatcher {
  return new TemporalTaskExecutionDispatcher(
    ADDRESS,
    options.queue ?? taskQueue,
    options.workflowType ?? "probeStaysOpen",
    true,
    client,
    15_000,
    NAMESPACE,
    /* No caching of the consumer proof: each case must be judged on the live namespace. */
    0,
    options.reconcile === false ? undefined : reconciler,
  );
}

/**
 * Parks an execution on `queue` under `workflowId`, carrying `memo`, WITHOUT going through
 * the dispatcher — this is fixture setup, so it must be able to create states the
 * dispatcher would refuse to create.
 */
async function parkExecution(input: {
  workflowId: string;
  queue: string;
  workflowType?: string;
  memo?: Record<string, unknown>;
}): Promise<void> {
  await client.workflow.start(input.workflowType ?? "probeStaysOpen", {
    taskQueue: input.queue,
    workflowId: input.workflowId,
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
    ...(input.memo ? { memo: input.memo } : {}),
    args: [{}],
  });
  openedFixtures.push(input.workflowId);
}

function identityMemo(taskId: string, attempt: number, missionId?: string) {
  return {
    [EXECUTION_IDENTITY_MEMO.taskId]: taskId,
    [EXECUTION_IDENTITY_MEMO.attempt]: attempt,
    ...(missionId ? { [EXECUTION_IDENTITY_MEMO.missionId]: missionId } : {}),
  };
}

beforeAll(async () => {
  taskQueue = ids.forCase("consumed").label("queue");
  foreignQueue = ids.forCase("unconsumed").label("queue");

  connection = await Connection.connect({ address: ADDRESS, connectTimeout: 15_000 });
  client = new Client({ connection, namespace: NAMESPACE });

  nativeConnection = await NativeConnection.connect({ address: ADDRESS });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: NAMESPACE,
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL("../../test/temporal-conflict-probe/workflows.ts", import.meta.url),
    ),
  });
  workerRun = worker.run();

  /*
   * The dispatcher refuses a queue with no poller, so do not race the worker — and
   * `RUNNING` is not enough: it is the worker's own view, reached before the server has
   * registered the long-poll the guard looks for.
   */
  const readyBy = Date.now() + 60_000;
  while (worker.getState() !== "RUNNING") {
    if (Date.now() > readyBy) throw new Error("TEST_TEMPORAL_WORKER_NOT_RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await waitForQueuePoller(client, taskQueue, { namespace: NAMESPACE, timeoutMs: 60_000 });
}, 120_000);

afterAll(async () => {
  for (const workflowId of openedFixtures) {
    await client.workflow
      .getHandle(workflowId)
      .terminate("test cleanup")
      .catch(() => undefined);
  }
  worker?.shutdown();
  await workerRun?.catch(() => undefined);
  await nativeConnection?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
}, 60_000);

describe("a fresh workflow id dispatches, and carries its identity", () => {
  it("starts, and the identity memo comes back off a real describe", async () => {
    const ident = ids.forCase("fresh");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    const input: TaskExecutionDispatchInput = {
      missionId: ident.mission(),
      taskId,
      attempt: 1,
      prompt: "probe",
      workflowId,
      executionClass: "DURABLE_MISSION_TASK",
    };

    const result = await dispatcherFor({}).dispatch(input);
    openedFixtures.push(workflowId);

    expect(result).toEqual({ workflowId, disposition: "started" });

    /* The premise the whole decision rests on: a real round-trip preserves the memo. */
    const described = await client.workflow.getHandle(workflowId).describe();
    expect(described.memo).toMatchObject(identityMemo(taskId, 1, ident.mission()));
    expect(described.taskQueue).toBe(taskQueue);
    expect(described.type).toBe("probeStaysOpen");
    expect(described.status.name).toBe("RUNNING");
  }, 60_000);
});

describe("an OPEN execution", () => {
  it("OPEN_SAME_EXECUTION_REUSES: the same attempt is idempotent, not a second run", async () => {
    const ident = ids.forCase("reuse");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    const input: TaskExecutionDispatchInput = {
      missionId: ident.mission(),
      taskId,
      attempt: 1,
      prompt: "probe",
      workflowId,
      executionClass: "DURABLE_MISSION_TASK",
    };
    const dispatcher = dispatcherFor({});

    const first = await dispatcher.dispatch(input);
    openedFixtures.push(workflowId);
    const firstRunId = (await client.workflow.getHandle(workflowId).describe()).runId;

    const second = await dispatcher.dispatch(input);

    expect(first.disposition).toBe("started");
    expect(second).toEqual({ workflowId, disposition: "reused" });

    /*
     * SAME_ATTEMPT_NEVER_DOUBLE_EXECUTES, on the server's own evidence: the run id did
     * not change, so the second dispatch created no second execution.
     */
    const afterRunId = (await client.workflow.getHandle(workflowId).describe()).runId;
    expect(afterRunId).toBe(firstRunId);
  }, 60_000);

  it("OPEN_FOREIGN_QUEUE_FAILS_CLOSED: an execution nobody we run can consume", async () => {
    /*
     * The exact gap the poller guard cannot close. A worker IS polling the queue this
     * dispatcher targets, so the consumer check passes — and the execution holding the id
     * sits on a queue with no poller at all. `USE_EXISTING` returned that handle and the
     * attempt was recorded dispatched; nothing ever ran it.
     */
    const ident = ids.forCase("foreign-queue");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await parkExecution({
      workflowId,
      queue: foreignQueue,
      memo: identityMemo(taskId, 1, ident.mission()),
    });

    await expect(
      dispatcherFor({}).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 1,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_FOREIGN_TASK_QUEUE");
  }, 60_000);

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different attempt of the same task", async () => {
    const ident = ids.forCase("foreign-attempt");
    const taskId = ident.task("a");
    /*
     * Deliberately parked under the id attempt 2 would use, while carrying attempt 1's
     * identity: a corrupt pairing no honest path produces, and exactly what a reused id
     * from an earlier run looks like.
     */
    const workflowId = ident.workflow(taskId, 2);
    await parkExecution({
      workflowId,
      queue: taskQueue,
      memo: identityMemo(taskId, 1, ident.mission()),
    });

    await expect(
      dispatcherFor({}).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 2,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_FOREIGN_ATTEMPT_IDENTITY");
  }, 60_000);

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different ICOS task holding the id", async () => {
    const ident = ids.forCase("foreign-task");
    const mine = ident.task("mine");
    const theirs = ident.task("theirs");
    const workflowId = ident.workflow(mine, 1);
    await parkExecution({
      workflowId,
      queue: taskQueue,
      memo: identityMemo(theirs, 1, ident.mission()),
    });

    await expect(
      dispatcherFor({}).dispatch({
        missionId: ident.mission(),
        taskId: mine,
        attempt: 1,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_FOREIGN_TASK_IDENTITY");
  }, 60_000);

  it("refuses an execution that carries no ICOS identity at all", async () => {
    /* Not started under this contract, so nothing about it can be proven. */
    const ident = ids.forCase("no-identity");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await parkExecution({ workflowId, queue: taskQueue });

    await expect(
      dispatcherFor({}).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 1,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_EXISTING_IDENTITY_UNVERIFIABLE");
  }, 60_000);

  it("OPEN_WRONG_IDENTITY_FAILS_CLOSED: a different workflow type", async () => {
    const ident = ids.forCase("foreign-type");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await parkExecution({
      workflowId,
      queue: taskQueue,
      workflowType: "probeCompletes",
      memo: identityMemo(taskId, 1, ident.mission()),
    });

    await expect(
      dispatcherFor({ workflowType: "probeStaysOpen" }).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 1,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_UNEXPECTED_WORKFLOW_TYPE");
  }, 60_000);
});

describe("a CLOSED execution is answered by ICOS, not by Temporal", () => {
  /** Runs `probeCompletes` to completion on the real worker's queue. */
  async function closeOne(workflowId: string, memo: Record<string, unknown>): Promise<void> {
    const handle = await client.workflow.start("probeCompletes", {
      taskQueue,
      workflowId,
      workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
      memo,
      args: [{}],
    });
    await handle.result();
    expect((await handle.describe()).status.name).toBe("COMPLETED");
  }

  it("CLOSED_WITH_DURABLE_RESULT_RECONCILES: settled work is never re-executed", async () => {
    const ident = ids.forCase("closed-settled");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await closeOne(workflowId, identityMemo(taskId, 1, ident.mission()));
    const closedRunId = (await client.workflow.getHandle(workflowId).describe()).runId;

    /* ICOS holds the canonical terminal result for exactly this workflow. */
    settled.add(workflowId);

    const result = await dispatcherFor({ workflowType: "probeCompletes" }).dispatch({
      missionId: ident.mission(),
      taskId,
      attempt: 1,
      prompt: "probe",
      workflowId,
      executionClass: "DURABLE_MISSION_TASK",
    });

    expect(result).toEqual({ workflowId, disposition: "reconciled" });
    /* And nothing ran again: same run, still closed. */
    const after = await client.workflow.getHandle(workflowId).describe();
    expect(after.runId).toBe(closedRunId);
    expect(after.status.name).toBe("COMPLETED");
  }, 90_000);

  it("CLOSED_WITHOUT_RESULT_FAILS_CLOSED: finished, but never settled", async () => {
    /*
     * The execution ended and ICOS never received its result. Reporting a dispatch here
     * is the original defect exactly: the attempt sits at `dispatched` for ever, with no
     * result, no QC job and a missing review as the only symptom.
     */
    const ident = ids.forCase("closed-unsettled");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await closeOne(workflowId, identityMemo(taskId, 1, ident.mission()));

    await expect(
      dispatcherFor({ workflowType: "probeCompletes" }).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 1,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_CLOSED_WORKFLOW_WITHOUT_RESULT");
  }, 90_000);

  it("TERMINATED_ATTEMPT_DOES_NOT_RESURRECT", async () => {
    /*
     * Termination skips the workflow's own error path, so no failure callback is ever
     * sent. The attempt must neither restart under its own id nor be reported dispatched.
     */
    const ident = ids.forCase("terminated");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await parkExecution({
      workflowId,
      queue: taskQueue,
      memo: identityMemo(taskId, 1, ident.mission()),
    });
    await client.workflow.getHandle(workflowId).terminate("proof: attempt abandoned");
    const terminatedRunId = (await client.workflow.getHandle(workflowId).describe()).runId;

    await expect(
      dispatcherFor({}).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 1,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_TERMINATED_WORKFLOW_WITHOUT_RESULT");

    const after = await client.workflow.getHandle(workflowId).describe();
    expect(after.runId).toBe(terminatedRunId);
    expect(after.status.name).toBe("TERMINATED");
  }, 90_000);
});

describe("NO_FALSE_DISPATCH_SUCCESS", () => {
  it("NEW_ATTEMPT_REQUIRES_CORE3_RETRY_IDENTITY: a new attempt gets its own id and runs", async () => {
    /*
     * A retry is a NEW attempt issued by CORE3, carrying a new workflow id. The adapter
     * derives nothing: given the new identity it starts a genuinely new execution, and
     * given the old one it would have reused or refused. Both halves are the point.
     */
    const ident = ids.forCase("retry-identity");
    const taskId = ident.task("a");
    const first = ident.workflow(taskId, 1);
    const second = ident.workflow(taskId, 2);
    expect(second).not.toBe(first);

    const dispatcher = dispatcherFor({});
    const one = await dispatcher.dispatch({
      missionId: ident.mission(),
      taskId,
      attempt: 1,
      prompt: "probe",
      workflowId: first,
      executionClass: "DURABLE_MISSION_TASK",
    });
    openedFixtures.push(first);
    const two = await dispatcher.dispatch({
      missionId: ident.mission(),
      taskId,
      attempt: 2,
      prompt: "probe",
      workflowId: second,
      executionClass: "DURABLE_MISSION_TASK",
    });
    openedFixtures.push(second);

    expect(one.disposition).toBe("started");
    expect(two.disposition).toBe("started");

    /* Two distinct executions on the server, one per attempt. */
    const [a, b] = await Promise.all([
      client.workflow.getHandle(first).describe(),
      client.workflow.getHandle(second).describe(),
    ]);
    expect(a.runId).not.toBe(b.runId);
    expect(a.memo).toMatchObject(identityMemo(taskId, 1));
    expect(b.memo).toMatchObject(identityMemo(taskId, 2));
  }, 90_000);

  it("a caller that cannot state its attempt is refused, never guessed for", async () => {
    const ident = ids.forCase("no-attempt");
    const taskId = ident.task("a");
    const workflowId = ident.workflow(taskId, 1);
    await parkExecution({
      workflowId,
      queue: taskQueue,
      memo: identityMemo(taskId, 1, ident.mission()),
    });

    await expect(
      dispatcherFor({}).dispatch({
        missionId: ident.mission(),
        taskId,
        prompt: "probe",
        workflowId,
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_EXISTING_ATTEMPT_UNVERIFIABLE");
  }, 60_000);

  it("refuses to enqueue onto a queue no worker polls", async () => {
    /* The guard that preceded this work, still holding on the real server. */
    const ident = ids.forCase("no-consumer");
    const taskId = ident.task("a");

    await expect(
      dispatcherFor({ queue: foreignQueue }).dispatch({
        missionId: ident.mission(),
        taskId,
        attempt: 1,
        prompt: "probe",
        workflowId: ident.workflow(taskId, 1),
        executionClass: "DURABLE_MISSION_TASK",
      }),
    ).rejects.toThrow("TEMPORAL_NO_CONSUMER");
  }, 60_000);
});
