import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RECOVERY LOOKS WHERE WORK RUNS: the probe's client is built in the dispatcher's namespace
 * (twin of temporal-task-execution-dispatcher.namespace.test.ts). A probe left in `default`
 * while workflows run in TEMPORAL_NAMESPACE reports every live attempt "not found", and the
 * sweeper then supersedes running work.
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
      constructor(options: { connection: unknown; namespace?: string }) {
        clientCtor(options);
        this.workflow = {
          getHandle: vi.fn(() => ({
            describe: vi.fn(async () => {
              throw new actual.WorkflowNotFoundError("absent", "wf-1", "runIcosTask");
            }),
          })),
        };
      }
    },
  };
});

import { TemporalWorkflowProbe } from "./temporal-workflow-probe";

describe("TemporalWorkflowProbe — the client is built in the configured namespace", () => {
  beforeEach(() => clientCtor.mockClear());

  it("passes TEMPORAL_NAMESPACE to the Client before the first describe", async () => {
    const probe = new TemporalWorkflowProbe("localhost:7233", 1_000, undefined, "icos-prod");
    const status = await probe.status("wf-1");
    expect(status).toBe("not_found");
    expect(clientCtor).toHaveBeenCalledTimes(1);
    expect(clientCtor).toHaveBeenCalledWith({ connection: fakeConnection, namespace: "icos-prod" });
  });

  it("without a namespace it stays in `default`, explicitly", async () => {
    const probe = new TemporalWorkflowProbe("localhost:7233", 1_000);
    await probe.status("wf-1");
    expect(clientCtor).toHaveBeenCalledWith({ connection: fakeConnection, namespace: "default" });
  });
});
