import { describe, expect, it } from "vitest";

import type { AgentAction } from "@/types/actions";

import { decideExecution } from "./authorization";

const baseAction: AgentAction = {
  id: "action-001",
  initiatedByAgentId: "agent-cto",
  kind: "repository.read",
  risk: "read_only",
  requiresHumanApproval: false,
  approvalStatus: "not_required",
  requestedAt: "2026-07-21T08:00:00.000Z",
};

describe("decideExecution", () => {
  it("allows a read-only action that does not require approval", () => {
    expect(decideExecution(baseAction)).toEqual({ allowed: true, reason: "approved" });
  });

  it("refuses a sensitive action while approval is pending", () => {
    expect(
      decideExecution({
        ...baseAction,
        risk: "sensitive",
        requiresHumanApproval: true,
        approvalStatus: "pending",
      }),
    ).toEqual({ allowed: false, reason: "approval_required" });
  });

  it("allows a sensitive action only after approval", () => {
    expect(
      decideExecution({
        ...baseAction,
        risk: "sensitive",
        requiresHumanApproval: true,
        approvalStatus: "approved",
      }),
    ).toEqual({ allowed: true, reason: "approved" });
  });

  it("honors an explicit rejection for every risk level", () => {
    expect(decideExecution({ ...baseAction, approvalStatus: "rejected" })).toEqual({
      allowed: false,
      reason: "approval_rejected",
    });
  });
});
