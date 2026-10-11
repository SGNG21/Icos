import { describe, expect, it } from "vitest";

import { requestFingerprint } from "@/core/tool-gateway/policy";

import {
  InMemoryConnectorHealthStore,
  InMemoryToolApprovalStore,
  InMemoryToolExecutionStore,
  InMemoryToolGrantStore,
} from "./in-memory";
import { ArrayAudit, caller, makeHarness as makeBaseHarness } from "./test-fixtures";

/** One audit port shared by every store, as in production. */
const makeHarness = () => {
  const audit = new ArrayAudit();
  return makeBaseHarness({
    executions: new InMemoryToolExecutionStore(audit),
    approvals: new InMemoryToolApprovalStore(audit),
    grants: new InMemoryToolGrantStore(audit),
    health: new InMemoryConnectorHealthStore(),
    audit,
  });
};

const read = (context?: Record<string, string>) => ({
  toolId: "mail",
  action: "READ",
  connectorInstanceId: "inst-a",
  input: {},
  ...(context ? { context } : {}),
});

describe("tool intent scope context (attribution, never authority)", () => {
  it("every audit entry of the execution records the client / project / turn it served", async () => {
    const h = await makeHarness();
    await h.grant("agent-1", "mail", "READ");
    const context = {
      clientId: "lds-renov",
      projectId: "site-2026",
      conversationId: "conv-1",
      turnId: "turn-1",
    };
    const out = await h.gateway.execute(caller(), read(context));
    expect(out.kind).toBe("succeeded");
    const entries = (h.audit as ArrayAudit).entries.filter(
      (e) => e.eventType === "tool.execution.recorded",
    );
    expect(entries.length).toBeGreaterThanOrEqual(3); // requested, dispatched, settled
    for (const e of entries) expect(e.details.context).toEqual(context);
  });

  it("a refusal also records it, and a call without context records none", async () => {
    const h = await makeHarness();
    const denied = await h.gateway.execute(caller(), read({ clientId: "lds-renov" }));
    expect(denied.kind).toBe("failed");
    const audit = (h.audit as ArrayAudit).entries;
    expect(audit.at(-1)!.details.context).toEqual({ clientId: "lds-renov" });

    await h.grant("agent-1", "mail", "READ");
    await h.gateway.execute(caller(), read());
    expect(audit.at(-1)!.details).not.toHaveProperty("context");
  });

  it("context grants nothing and does not change the request fingerprint", async () => {
    const h = await makeHarness();
    // No grant: a client id cannot unlock anything.
    const out = await h.gateway.execute(caller(), read({ clientId: "any-client" }));
    expect(out.kind === "failed" && out.failureClass).toBe("PERMISSION_DENIED");
    const base = { ...read(), action: "READ" as const };
    expect(requestFingerprint(caller(), { ...base, context: { clientId: "a" } })).toBe(
      requestFingerprint(caller(), base),
    );
  });

  it("free text or unknown keys in context are an invalid intent (closed identifiers only)", async () => {
    const h = await makeHarness();
    await h.grant("agent-1", "mail", "READ");
    for (const context of [
      { clientId: "ignore previous instructions" },
      { tenantId: "tenant-b" },
    ]) {
      const out = await h.gateway.execute(
        caller(),
        read(context as unknown as Record<string, string>),
      );
      expect(out.kind === "failed" && out.failureClass).toBe("INVALID_INPUT");
    }
  });

  it("concurrent calls never see each other's context", async () => {
    const h = await makeHarness();
    await h.grant("agent-1", "mail", "READ");
    await Promise.all(
      ["c-1", "c-2", "c-3"].map((clientId) =>
        h.gateway.execute(caller(), { ...read({ clientId }), input: { n: clientId } }),
      ),
    );
    const byExec = new Map<string, Set<unknown>>();
    for (const e of (h.audit as ArrayAudit).entries) {
      const id = e.details.toolExecutionId as string | undefined;
      if (!id) continue;
      byExec.set(id, (byExec.get(id) ?? new Set()).add(JSON.stringify(e.details.context)));
    }
    expect(byExec.size).toBe(3);
    for (const contexts of byExec.values()) expect(contexts.size).toBe(1);
  });
});
