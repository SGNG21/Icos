import { describe, expect, it, vi } from "vitest";

import { RuntimeDispatchRouter } from "./runtime-dispatch-router";
import { orchestratorFor, requireExecutionClass } from "@/core/execution/execution-class";

/**
 * One task class, one orchestrator — decided before dispatch and never inferred.
 *
 * The router used to choose by asking whether the worker's runtime had an executor
 * adapter configured. Declaring `ICOS_WORKER_EXEC_COMMANDS`, so `tools.governed` would
 * stop reporting NOT_CONNECTED while hermes ran every mission, therefore moved every
 * `binary` worker off Temporal and into the in-process executor — silently, with no code
 * change, and durable multi-step work landed on a path that cannot survive a restart.
 *
 * These pin the separation: executor is configuration, orchestrator is a property of the
 * work.
 */
function router(options: { externalRuntimes?: string[] } = {}) {
  const external = { dispatch: vi.fn(async () => ({ workflowId: "wf-in-process" })) };
  const fallback = { dispatch: vi.fn(async () => ({ workflowId: "wf-temporal" })) };
  const instance = new RuntimeDispatchRouter({
    dispatchAttempts: {
      getByWorkflowId: vi.fn(async () => ({ workerId: "w1", missionTaskId: "mt1" })),
    },
    workers: { get: vi.fn(async () => ({ id: "w1", runtime: "binary" })) },
    external,
    fallback,
    externalRuntimes: (options.externalRuntimes ?? ["binary"]) as never,
  } as never);
  return { instance, external, fallback };
}

const base = { taskId: "t1", prompt: "do the thing", workflowId: "icos-task-t1" };

describe("execution path contract", () => {
  it("a durable mission task always goes to the durable orchestrator", async () => {
    const { instance, external, fallback } = router();

    await instance.dispatch({ ...base, executionClass: "DURABLE_MISSION_TASK" } as never);

    expect(fallback.dispatch).toHaveBeenCalledTimes(1);
    expect(external.dispatch).not.toHaveBeenCalled();
  });

  it("declaring an executor cannot move mission work in-process", async () => {
    /* The exact regression: an adapter exists for this runtime, and it changes nothing. */
    const { instance, external, fallback } = router({ externalRuntimes: ["binary"] });

    await instance.dispatch({ ...base, executionClass: "DURABLE_MISSION_TASK" } as never);

    expect(external.dispatch).not.toHaveBeenCalled();
    expect(fallback.dispatch).toHaveBeenCalledTimes(1);
  });

  it("an interactive command runs in process and opens no workflow", async () => {
    const { instance, external, fallback } = router();

    await instance.dispatch({ ...base, executionClass: "INTERACTIVE_COMMAND" } as never);

    expect(external.dispatch).toHaveBeenCalledTimes(1);
    expect(fallback.dispatch).not.toHaveBeenCalled();
  });

  it("an interactive command with no adapter fails rather than becoming a workflow", async () => {
    const { instance, fallback } = router({ externalRuntimes: [] });

    await expect(
      instance.dispatch({ ...base, executionClass: "INTERACTIVE_COMMAND" } as never),
    ).rejects.toThrow("EXECUTION_IN_PROCESS_UNAVAILABLE");
    expect(fallback.dispatch).not.toHaveBeenCalled();
  });

  it("a dispatch with no execution class fails closed", async () => {
    const { instance, external, fallback } = router();

    await expect(instance.dispatch({ ...base } as never)).rejects.toThrow(
      "EXECUTION_CLASS_REQUIRED",
    );
    expect(external.dispatch).not.toHaveBeenCalled();
    expect(fallback.dispatch).not.toHaveBeenCalled();
  });

  it("an unknown execution class fails closed", () => {
    expect(() => requireExecutionClass("SOMETHING_ELSE")).toThrow("EXECUTION_CLASS_REQUIRED");
    expect(() => requireExecutionClass(undefined)).toThrow("EXECUTION_CLASS_REQUIRED");
  });

  it("the mapping is total and has no fallback in either direction", () => {
    expect(orchestratorFor("DURABLE_MISSION_TASK")).toBe("temporal");
    expect(orchestratorFor("INTERACTIVE_COMMAND")).toBe("in_process");
  });

  it("a retry keeps the class it was dispatched with", async () => {
    const { instance, external, fallback } = router();
    const attempt = { ...base, executionClass: "DURABLE_MISSION_TASK" } as never;

    await instance.dispatch(attempt);
    await instance.dispatch(attempt);

    /* Recovery cannot switch orchestration mechanisms mid-task. */
    expect(fallback.dispatch).toHaveBeenCalledTimes(2);
    expect(external.dispatch).not.toHaveBeenCalled();
  });
});
