import { WorkflowNotFoundError } from "@temporalio/client";
import { describe, expect, it } from "vitest";

import { TemporalWorkflowProbe } from "@/server/recovery/temporal-workflow-probe";

const probeWith = (describe: () => Promise<unknown>) =>
  new TemporalWorkflowProbe("unused:7233", 1_000, {
    workflow: { getHandle: () => ({ describe }) },
  } as never);
const statusOf = (name: string) => probeWith(async () => ({ status: { name } }));

describe("TemporalWorkflowProbe", () => {
  it.each([
    ["RUNNING", "running"],
    ["CONTINUED_AS_NEW", "running"],
    ["COMPLETED", "closed"],
    ["FAILED", "closed"],
    ["TERMINATED", "closed"],
    ["TIMED_OUT", "closed"],
    ["CANCELLED", "closed"],
    ["UNKNOWN", "unknown"],
  ])("maps %s → %s", async (name, expected) => {
    expect(await statusOf(name).status("wf")).toBe(expected);
  });

  it("maps WorkflowNotFoundError → not_found", async () => {
    const probe = probeWith(async () => {
      throw new WorkflowNotFoundError("nope", "wf", undefined);
    });
    expect(await probe.status("wf")).toBe("not_found");
  });

  it("fails closed (unknown) on any other error — never a destructive verdict", async () => {
    const probe = probeWith(async () => {
      throw new Error("UNAVAILABLE");
    });
    expect(await probe.status("wf")).toBe("unknown");
  });
});
