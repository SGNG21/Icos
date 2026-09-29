import { describe, expect, it } from "vitest";

import { act } from "./model";

import { canDecideApproval, effectiveApproval, requestFingerprint } from "./policy";

describe("tool policy (pure)", () => {
  it("HIGH/CRITICAL are forced to human approval, whatever the definition declares", () => {
    const declared = act("SEND", "HIGH", "external", "x", {
      approval: { mode: "human_or_agent", selfApprovalAllowed: true },
    });
    expect(effectiveApproval(declared)).toMatchObject({
      mode: "human",
      selfApprovalAllowed: false,
    });
    const req = { requesterAgentId: "agent-1" } as never;
    expect(canDecideApproval(declared, req, { kind: "agent", id: "agent-2" })).toBe(false);
    expect(canDecideApproval(declared, req, { kind: "human", id: "h" })).toBe(true);
  });

  it("an agent may approve a MEDIUM action only as policy allows, and itself only if self-approval is allowed", () => {
    const req = { requesterAgentId: "agent-1" } as never;
    const other = act("WRITE", "MEDIUM", "internal", "x", { approval: { mode: "human_or_agent" } });
    expect(canDecideApproval(other, req, { kind: "agent", id: "agent-2" })).toBe(true);
    expect(canDecideApproval(other, req, { kind: "agent", id: "agent-1" })).toBe(false);
    const humanOnly = act("WRITE", "MEDIUM", "internal", "x", { approval: { mode: "human" } });
    expect(canDecideApproval(humanOnly, req, { kind: "agent", id: "agent-2" })).toBe(false);
  });

  it("the fingerprint is key-order independent and tenant-bound", () => {
    const i = (input: Record<string, never>) => ({
      toolId: "mail",
      action: "SEND" as const,
      connectorInstanceId: "inst",
      input,
    });
    const a = requestFingerprint({ tenantId: "t1", agentId: "x" }, i({ a: 1, b: 2 } as never));
    expect(requestFingerprint({ tenantId: "t1", agentId: "y" }, i({ b: 2, a: 1 } as never))).toBe(
      a,
    );
    expect(
      requestFingerprint({ tenantId: "t2", agentId: "x" }, i({ a: 1, b: 2 } as never)),
    ).not.toBe(a);
  });
});
