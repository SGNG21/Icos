import { describe, expect, it, vi } from "vitest";

import type { WorkerRegistryEntry } from "@/core/contracts/worker-registry";
import { workerRegistryEntrySchema } from "@/core/contracts/worker-registry";
import type { DispatchAttempt } from "@/core/contracts/dispatch-attempt";
import { RuntimeDispatchRouter } from "./runtime-dispatch-router";
import type { TaskExecutionDispatcher } from "./ports";

/*
 * M8 / DEFECT 22 — the dispatch seam chooses BY RUNTIME.
 *
 * The defect these pin: `container.taskExecution` was unconditionally Temporal, so every
 * M6.3/M7 certification described a capability the real runtime did not have. The risk in
 * fixing it is re-opening the provider-name defect at the same seam, so the tests below
 * care as much about what the router must NOT look at as what it must.
 */

const WORKER_ID = "11111111-1111-4111-8111-111111111111";

const worker = (over: Partial<WorkerRegistryEntry> = {}): WorkerRegistryEntry =>
  workerRegistryEntrySchema.parse({
    id: WORKER_ID,
    workerKind: "agent",
    displayName: "w",
    capabilities: ["code-generation"],
    runtime: "binary",
    runtimeSupport: "SUPPORTED_RUNTIME",
    health: "healthy",
    availability: "available",
    updatedAt: new Date().toISOString(),
    ...over,
  });

const attempt = (over: Partial<DispatchAttempt> = {}): DispatchAttempt =>
  ({
    id: "a1",
    missionId: "m1",
    missionTaskId: "mt1",
    taskId: "t1",
    attempt: 1,
    workflowId: "wf-1",
    prompt: "do work",
    workerId: WORKER_ID,
    state: "dispatched",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as DispatchAttempt;

function harness(
  over: {
    attempt?: DispatchAttempt | null;
    worker?: WorkerRegistryEntry | null;
    externalRuntimes?: Array<"node" | "docker" | "binary" | "wasm" | "unknown">;
  } = {},
) {
  const external = { dispatch: vi.fn(async () => ({ workflowId: "wf-1" })) };
  const fallback = { dispatch: vi.fn(async () => ({ workflowId: "wf-1" })) };

  const router = new RuntimeDispatchRouter({
    dispatchAttempts: {
      getByWorkflowId: vi.fn(async () =>
        over.attempt === undefined ? attempt() : over.attempt,
      ),
    },
    workers: {
      get: vi.fn(async () => (over.worker === undefined ? worker() : over.worker)),
    },
    external: external as unknown as TaskExecutionDispatcher,
    fallback: fallback as unknown as TaskExecutionDispatcher,
    externalRuntimes: over.externalRuntimes ?? ["binary"],
  });

  return { router, external, fallback };
}

/*
 * These exercise adapter selection WITHIN the in-process class. The orchestrator itself
 * is no longer inferred from adapters — see `execution-path-contract.test.ts` — so each
 * dispatch declares its class, and what remains under test is that the runtime (never the
 * worker kind or provider) decides whether this process can launch it.
 */
const input = {
  taskId: "t1",
  prompt: "do work",
  workflowId: "wf-1",
  executionClass: "INTERACTIVE_COMMAND",
} as const;

describe("M8 runtime dispatch router", () => {
  it("ROUTES TO THE EXTERNAL EXECUTOR when the worker's runtime has an adapter", async () => {
    const h = harness({ externalRuntimes: ["binary"] });

    await h.router.dispatch(input);

    expect(h.external.dispatch).toHaveBeenCalledTimes(1);
    expect(h.fallback.dispatch).not.toHaveBeenCalled();
  });

  it("REFUSES rather than silently becoming a workflow when the runtime has NO adapter", async () => {
    /*
     * `binary` is not configured here, so this process cannot launch it. It used to fall
     * through to the durable dispatcher, which is how an interactive call could quietly
     * become a workflow. Now it fails.
     */
    const h = harness({ externalRuntimes: ["node"] });

    await expect(h.router.dispatch(input)).rejects.toThrow("EXECUTION_IN_PROCESS_UNAVAILABLE");
    expect(h.fallback.dispatch).not.toHaveBeenCalled();
    expect(h.external.dispatch).not.toHaveBeenCalled();
  });

  it("NOTHING CONFIGURED still runs MISSION work durably", async () => {
    /*
     * The old property was "a deployment that has not opted in is bit-for-bit
     * unchanged", which held only while adapters chose the orchestrator. The orchestrator
     * is now the declared class, so the honest version of that safety property is: an
     * unconfigured deployment still runs mission work on the durable path.
     */
    const h = harness({ externalRuntimes: [] });

    await h.router.dispatch({ ...input, executionClass: "DURABLE_MISSION_TASK" });

    expect(h.fallback.dispatch).toHaveBeenCalledTimes(1);
    expect(h.external.dispatch).not.toHaveBeenCalled();
  });

  it("THE DECISION IGNORES WORKER KIND — no provider-name routing is reintroduced", async () => {
    /*
     * `hermes` is a worker KIND in the legacy enum and the exact kind
     * `CompositeTaskExecutionDispatcher` branches on. It must change nothing here.
     */
    const asHermesKind = harness({
      worker: worker({ workerKind: "hermes", runtime: "binary" }),
      externalRuntimes: ["binary"],
    });
    await asHermesKind.router.dispatch(input);
    expect(asHermesKind.external.dispatch).toHaveBeenCalledTimes(1);

    /* Same kind, different runtime: this process cannot launch it, so it refuses. */
    const sameKindOtherRuntime = harness({
      worker: worker({ workerKind: "hermes", runtime: "docker" }),
      externalRuntimes: ["binary"],
    });
    await expect(sameKindOtherRuntime.router.dispatch(input)).rejects.toThrow(
      "EXECUTION_IN_PROCESS_UNAVAILABLE",
    );
    expect(sameKindOtherRuntime.external.dispatch).not.toHaveBeenCalled();
    expect(sameKindOtherRuntime.fallback.dispatch).not.toHaveBeenCalled();
  });

  it("A PROVIDER IN METADATA CHANGES NOTHING", async () => {
    const h = harness({
      worker: worker({ runtime: "binary", metadata: { provider: "anything", model: "x" } }),
      externalRuntimes: ["binary"],
    });
    await h.router.dispatch(input);
    /* Routed on runtime alone; the provider is recorded evidence, never a routing key. */
    expect(h.external.dispatch).toHaveBeenCalledTimes(1);
  });

  it("AN UNRESOLVABLE RUNTIME refuses in-process rather than guessing", async () => {
    /*
     * Previously each of these fell through to the durable dispatcher. Under the class
     * contract that would be the silent switch again, so an interactive command whose
     * runtime cannot be resolved now fails instead.
     */
    const noWorkflow = harness();
    await expect(
      noWorkflow.router.dispatch({ taskId: "t1", prompt: "p", executionClass: "INTERACTIVE_COMMAND" }),
    ).rejects.toThrow("EXECUTION_IN_PROCESS_UNAVAILABLE");

    for (const h of [
      harness({ attempt: null }),
      /* Routed to a worker that has since been deregistered: its runtime is unknowable. */
      harness({ worker: null }),
      harness({ attempt: attempt({ workerId: undefined }) }),
    ]) {
      await expect(h.router.dispatch(input)).rejects.toThrow("EXECUTION_IN_PROCESS_UNAVAILABLE");
      expect(h.fallback.dispatch).not.toHaveBeenCalled();
    }
  });

  it("REPORTS which runtimes it will execute itself", () => {
    const h = harness({ externalRuntimes: ["node", "binary"] });
    expect(h.router.external()).toEqual(["binary", "node"]);
  });
});
