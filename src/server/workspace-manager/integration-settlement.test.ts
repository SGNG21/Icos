import { describe, expect, it } from "vitest";

import { WorkspaceIntegrationSettlement } from "./integration-settlement";
import type { Workspace } from "./types";

const ws = (over: Partial<Workspace>): Workspace =>
  ({
    workspaceId: "w1",
    workflowId: "wf",
    status: "ready_for_integration",
    releasedAt: null,
    sourceCommit: null,
    integrationTarget: "integration/phase-7",
    ...over,
  }) as Workspace;

const settle = (workspaces: Workspace[], integrated = true) =>
  new WorkspaceIntegrationSettlement(
    { list: async () => workspaces },
    { isAncestor: async () => integrated },
  ).settlementOf("wf");

describe("WorkspaceIntegrationSettlement (DEFECT 36)", () => {
  it("no governed workspace: UNGOVERNED", async () => {
    expect(await settle([ws({ workflowId: "other" })])).toBe("UNGOVERNED");
  });

  it("awaiting review or gate: PENDING", async () => {
    expect(await settle([ws({})])).toBe("PENDING");
  });

  it("accepted and the commit is in the target: INTEGRATED", async () => {
    const accepted = ws({ status: "accepted", sourceCommit: "abc", releasedAt: "t" });
    expect(await settle([accepted])).toBe("INTEGRATED");
  });

  it("accepted but NOT in the target (NEEDS_REBASE / RACE_LOST): still PENDING, never integrated", async () => {
    expect(await settle([ws({ status: "accepted", sourceCommit: "abc" })], false)).toBe("PENDING");
    expect(
      await settle([ws({ status: "accepted", sourceCommit: "abc", releasedAt: "t" })], false),
    ).toBe("PENDING");
  });

  it("reaped without acceptance: REJECTED", async () => {
    expect(await settle([ws({ status: "rejected", releasedAt: "t" })])).toBe("REJECTED");
  });

  it("a rejected workspace is not final while another one for the workflow is live", async () => {
    expect(await settle([ws({ status: "rejected", releasedAt: "t" }), ws({ workspaceId: "w2" })])).toBe(
      "PENDING",
    );
  });
});
