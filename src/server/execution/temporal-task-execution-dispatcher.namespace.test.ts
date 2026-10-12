import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CLIENT LIVES IN THE DISPATCHER'S NAMESPACE.
 *
 * Measured 2026-10-12 (FABLE lab, TEMPORAL_NAMESPACE=icos-fable-lab): the consumer guard
 * described the task queue in `icos-fable-lab`, found the worker, and the workflow was then
 * started in `default`, where nothing polls — dispatch recorded, task never executed. The
 * real `Connection`/`Client` are replaced here so the construction can be observed without a
 * server; the dispatcher's own logic is untouched.
 */
const clientCtor = vi.fn();
const fakeConnection = { tag: "fake-connection" };

vi.mock("@temporalio/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@temporalio/client")>();
  return {
    ...actual,
    Connection: { connect: vi.fn(async () => fakeConnection) },
    Client: class {
      readonly workflow: unknown;
      readonly workflowService: unknown;
      readonly connection: unknown;
      readonly loadedDataConverter = {};
      readonly withDeadline = async (_deadline: number, start: () => Promise<unknown>) => start();
      readonly withAbortSignal = async (_signal: AbortSignal, start: () => Promise<unknown>) =>
        start();
      constructor(options: { connection: unknown; namespace?: string }) {
        clientCtor(options);
        this.connection = options.connection;
        this.workflowService = {
          describeTaskQueue: vi.fn(async () => ({ pollers: [{ identity: "w1" }] })),
        };
        this.workflow = {
          start: vi.fn(async () => ({ workflowId: "icos-task-task1" })),
          getHandle: vi.fn(() => ({
            describe: vi.fn(async () => {
              throw new actual.WorkflowNotFoundError("absent", "icos-task-task1", "runIcosTask");
            }),
          })),
        };
      }
    },
  };
});

import { TemporalTaskExecutionDispatcher } from "./temporal-task-execution-dispatcher";

describe("TemporalTaskExecutionDispatcher — the real client is built in the configured namespace", () => {
  beforeEach(() => clientCtor.mockClear());

  it("passes TEMPORAL_NAMESPACE to the Client, so start/describe happen where the worker polls", async () => {
    const dispatcher = new TemporalTaskExecutionDispatcher(
      "localhost:7233",
      "icos-tasks",
      "runIcosTask",
      true,
      undefined,
      1_000,
      "icos-prod",
    );
    /* The construction is the fact under test; the dispatch outcome itself is covered elsewhere. */
    await dispatcher
      .dispatch({ missionId: "m1", taskId: "task1", attempt: 1, prompt: "p" })
      .catch(() => undefined);
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({ connection: fakeConnection, namespace: "icos-prod" });
  });

  it("without TEMPORAL_NAMESPACE the client stays in `default`, explicitly", async () => {
    const dispatcher = new TemporalTaskExecutionDispatcher(
      "localhost:7233",
      "icos-tasks",
      "runIcosTask",
      true,
      undefined,
      1_000,
    );
    await dispatcher
      .dispatch({ missionId: "m1", taskId: "task1", attempt: 1, prompt: "p" })
      .catch(() => undefined);
    expect(clientCtor).toHaveBeenCalledWith({ connection: fakeConnection, namespace: "default" });
  });
});
