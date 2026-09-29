import { beforeEach, describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";

import {
  SECRET,
  TENANT_A,
  TENANT_B,
  caller,
  human,
  observable,
  type Harness,
} from "./test-fixtures";

/**
 * The 15 Tool Gateway proofs (decision 0055), written once and run against
 * every store implementation (in-memory unit suite, real PostgreSQL suite).
 * Not a test file: imported by `*.test.ts` / `*.integration.test.ts`.
 */
export function defineGatewayProofs(
  label: string,
  setup: () => Promise<Harness>,
  readAudit: (h: Harness) => Promise<AuditEntry[]>,
): void {
  describe(`Tool Gateway proofs — ${label}`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await setup();
    });

    const mail = (
      action: string,
      key?: string,
      input: Record<string, unknown> = { to: "x@example.com" },
    ) => ({
      toolId: "mail",
      action,
      connectorInstanceId: "inst-a",
      input,
      ...(key ? { idempotencyKey: key } : {}),
    });
    const fs = (action: string, key?: string) => ({
      toolId: "vfs",
      action,
      connectorInstanceId: "inst-a",
      input: { path: "a.txt" },
      ...(key ? { idempotencyKey: key } : {}),
    });

    async function approveSend(key: string) {
      const first = await h.gateway.execute(caller(), mail("SEND", key));
      expect(first.kind).toBe("approval_required");
      if (first.kind !== "approval_required") throw new Error("unreachable");
      const d = await h.gateway.decideApproval(
        TENANT_A,
        first.approvalRequestId,
        human(),
        "APPROVED",
      );
      expect(d.ok).toBe(true);
      return first;
    }

    it("P1 — READ permission does not imply WRITE", async () => {
      await h.grant("agent-1", "vfs", "READ");
      expect((await h.gateway.execute(caller(), fs("READ"))).kind).toBe("succeeded");
      const w = await h.gateway.execute(caller(), fs("WRITE", "write-key-01"));
      expect(w).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      expect(h.connector.effectCount()).toBe(0);
    });

    it("P2 — WRITE permission does not imply DELETE", async () => {
      await h.grant("agent-1", "vfs", "WRITE");
      const del = await h.gateway.execute(caller(), fs("DELETE", "del-key-0001"));
      expect(del).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      expect(h.connector.effectCount()).toBe(0);
    });

    it("P3 — draft email does not imply send email", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      expect((await h.gateway.execute(caller(), mail("CREATE", "draft-key-01"))).kind).toBe(
        "succeeded",
      );
      const send = await h.gateway.execute(caller(), mail("SEND", "send-key-001"));
      expect(send).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      expect(h.connector.effectCount()).toBe(1); // the draft only
    });

    it("P4 — a role requirement does not grant permission", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      const cov = await h.gateway.checkCapabilities(caller(), [
        { toolId: "mail", action: "READ" },
        { toolId: "mail", action: "CREATE" },
        { toolId: "mail", action: "SEND" },
      ]);
      expect(cov.granted).toEqual([{ toolId: "mail", action: "CREATE" }]);
      expect(cov.missing).toEqual([
        { toolId: "mail", action: "READ" },
        { toolId: "mail", action: "SEND" },
      ]);
      // Checking coverage granted nothing.
      expect((await h.gateway.execute(caller(), mail("READ"))).kind).toBe("failed");
      const inv = await h.gateway.inventory(caller());
      const actions = inv.connectors
        .find((c) => c.connectorId === "fake")!
        .tools.find((t) => t.toolId === "mail")!.actions;
      expect(actions.filter((a) => a.permitted).map((a) => a.action)).toEqual(["CREATE"]);
    });

    it("P5 — a raw credential never enters any model-facing value", async () => {
      await h.grant("agent-1", "mail", "READ");
      // Trusted fields cannot be injected by the model (strict intent).
      for (const extra of [
        { tenantId: TENANT_B },
        { credential: "x" },
        { approval: "approved" },
        { agentId: "agent-2" },
      ]) {
        const r = await h.gateway.execute(caller(), { ...mail("READ"), ...extra });
        expect(r).toMatchObject({ kind: "failed", failureClass: "INVALID_INPUT" });
      }
      // Credential-shaped input is refused.
      const bad = await h.gateway.execute(caller(), mail("READ", undefined, { apiKey: "abc" }));
      expect(bad).toMatchObject({ kind: "failed", failureClass: "INVALID_INPUT" });

      h.connector.mode = "echo_secret";
      const ok = await h.gateway.execute(caller(), mail("READ"));
      expect(ok.kind).toBe("succeeded");
      expect(h.connector.seenCredential).toBe(SECRET); // the connector did get it…
      h.connector.mode = "throw";
      const thrown = await h.gateway.execute(caller(), mail("READ"));
      expect(thrown).toMatchObject({ kind: "failed", failureClass: "UNKNOWN" });

      const everything = observable(
        ok,
        thrown,
        await h.gateway.inventory(caller()),
        await h.gateway.cockpitSnapshot(TENANT_A),
        await h.executions.list(TENANT_A),
        await readAudit(h),
      );
      expect(everything).not.toContain(SECRET); // …and nothing else did.
      expect(everything).toContain("cred_a"); // the reference is fine to show
    });

    it("P6 — a duplicate retry does not duplicate the side effect", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      const a = await h.gateway.execute(caller(), mail("CREATE", "dup-key-0001"));
      const b = await h.gateway.execute(caller(), mail("CREATE", "dup-key-0001"));
      expect(a).toMatchObject({ kind: "succeeded", replayed: false });
      expect(b).toMatchObject({
        kind: "succeeded",
        replayed: true,
        toolExecutionId: a.toolExecutionId,
      });
      // Concurrent duplicates race to one dispatch.
      const many = await Promise.all(
        Array.from({ length: 8 }, () =>
          h.gateway.execute(caller(), mail("CREATE", "dup-key-0002")),
        ),
      );
      expect(new Set(many.map((m) => m.toolExecutionId)).size).toBe(1);
      expect(h.connector.effects.get("dup-key-0002")).toBe(1);
      expect(h.connector.effectCount()).toBe(2);
      // Same key, different payload: refused, not executed.
      const c = await h.gateway.execute(
        caller(),
        mail("CREATE", "dup-key-0001", { to: "other@example.com" }),
      );
      expect(c).toMatchObject({ kind: "failed", failureClass: "IDEMPOTENCY_CONFLICT" });
      // A retry-sensitive action without a key fails closed.
      const d = await h.gateway.execute(caller(), mail("CREATE"));
      expect(d).toMatchObject({ kind: "failed", failureClass: "INVALID_INPUT" });
      expect(h.connector.effectCount()).toBe(2);
    });

    it("P7 — an approval-required action cannot execute before approval", async () => {
      await h.grant("agent-1", "mail", "SEND");
      const first = await h.gateway.execute(caller(), mail("SEND", "appr-key-001"));
      expect(first.kind).toBe("approval_required");
      const again = await h.gateway.execute(caller(), mail("SEND", "appr-key-001"));
      expect(again).toMatchObject({ kind: "approval_required" });
      if (first.kind !== "approval_required" || again.kind !== "approval_required")
        throw new Error("unreachable");
      expect(again.approvalRequestId).toBe(first.approvalRequestId);
      expect(h.connector.effectCount()).toBe(0);

      // Nobody but an authorised human can approve a HIGH action.
      const id = first.approvalRequestId;
      expect(
        await h.gateway.decideApproval(TENANT_A, id, { kind: "agent", id: "agent-1" }, "APPROVED"),
      ).toMatchObject({ ok: false, failureClass: "PERMISSION_DENIED" });
      expect(
        await h.gateway.decideApproval(TENANT_A, id, { kind: "agent", id: "agent-2" }, "APPROVED"),
      ).toMatchObject({ ok: false, failureClass: "PERMISSION_DENIED" });
      expect(
        await h.gateway.decideApproval(TENANT_A, id, human("v", ["viewer"]), "APPROVED"),
      ).toMatchObject({ ok: false, failureClass: "PERMISSION_DENIED" });
      expect(await h.gateway.decideApproval(TENANT_B, id, human(), "APPROVED")).toMatchObject({
        ok: false,
        failureClass: "NOT_FOUND",
      });
      expect(h.connector.effectCount()).toBe(0);

      expect((await h.gateway.decideApproval(TENANT_A, id, human(), "APPROVED")).ok).toBe(true);
      // The approval covers this exact request only.
      const other = await h.gateway.execute(caller(), mail("SEND", "appr-key-002"));
      expect(other.kind).toBe("approval_required");
      const done = await h.gateway.execute(caller(), mail("SEND", "appr-key-001"));
      expect(done).toMatchObject({ kind: "succeeded", replayed: false });
      expect(h.connector.effectCount()).toBe(1);
    });

    it("P7b — a MEDIUM action may be self-approved only when its policy says so", async () => {
      await h.grant("agent-1", "vfs", "WRITE");
      const r = await h.gateway.execute(caller(), fs("WRITE", "fs-write-001"));
      if (r.kind !== "approval_required") throw new Error(`expected approval, got ${r.kind}`);
      expect(
        (
          await h.gateway.decideApproval(
            TENANT_A,
            r.approvalRequestId,
            { kind: "agent", id: "agent-1" },
            "APPROVED",
          )
        ).ok,
      ).toBe(true);
      expect((await h.gateway.execute(caller(), fs("WRITE", "fs-write-001"))).kind).toBe(
        "succeeded",
      );
    });

    it("P8 — a rejected approval never executes", async () => {
      await h.grant("agent-1", "mail", "SEND");
      const first = await h.gateway.execute(caller(), mail("SEND", "rej-key-0001"));
      if (first.kind !== "approval_required") throw new Error("unreachable");
      expect(
        await h.gateway.decideApproval(TENANT_A, first.approvalRequestId, human(), "REJECTED"),
      ).toMatchObject({ ok: false, failureClass: "INVALID_INPUT" });
      expect(
        (
          await h.gateway.decideApproval(
            TENANT_A,
            first.approvalRequestId,
            human(),
            "REJECTED",
            "no",
          )
        ).ok,
      ).toBe(true);
      expect(
        await h.gateway.decideApproval(TENANT_A, first.approvalRequestId, human(), "APPROVED"),
      ).toMatchObject({ ok: false, failureClass: "CONFLICT" });
      for (let i = 0; i < 3; i++) {
        expect(await h.gateway.execute(caller(), mail("SEND", "rej-key-0001"))).toMatchObject({
          kind: "failed",
          failureClass: "APPROVAL_REJECTED",
          retryable: false,
        });
      }
      expect(h.connector.effectCount()).toBe(0);
    });

    it("P9 — an expired approval cannot execute", async () => {
      await h.grant("agent-1", "mail", "SEND");
      await approveSend("exp-key-0001");
      h.clock.advance(601_000); // ttl 600 s
      const r = await h.gateway.execute(caller(), mail("SEND", "exp-key-0001"));
      expect(r).toMatchObject({ kind: "failed", failureClass: "APPROVAL_EXPIRED" });
      expect(h.connector.effectCount()).toBe(0);
      // The next retry asks for a fresh approval instead of reusing the spent one.
      const again = await h.gateway.execute(caller(), mail("SEND", "exp-key-0001"));
      expect(again.kind).toBe("approval_required");
      // A pending request past its deadline cannot be approved either.
      if (again.kind !== "approval_required") throw new Error("unreachable");
      h.clock.advance(601_000);
      expect(
        await h.gateway.decideApproval(TENANT_A, again.approvalRequestId, human(), "APPROVED"),
      ).toMatchObject({ ok: false, failureClass: "APPROVAL_EXPIRED" });
      expect(h.connector.effectCount()).toBe(0);
    });

    it("P10 — a connector auth failure is classified and blocks the instance", async () => {
      await h.grant("agent-1", "mail", "READ");
      h.connector.mode = "auth";
      const r = await h.gateway.execute(caller(), mail("READ"));
      expect(r).toMatchObject({ kind: "failed", failureClass: "AUTH_FAILURE", retryable: false });
      h.connector.mode = "ok";
      const next = await h.gateway.execute(caller(), mail("READ"));
      expect(next).toMatchObject({ kind: "failed", failureClass: "AUTH_FAILURE" });
      expect((await h.gateway.cockpitSnapshot(TENANT_A)).connectorHealth).toContainEqual(
        expect.objectContaining({ instanceId: "inst-a", status: "AUTH_FAILED" }),
      );
    });

    it("P11 — a rate limit is classified, retryable, and stops dispatch until it clears", async () => {
      await h.grant("agent-1", "mail", "READ");
      h.connector.mode = "ratelimit";
      expect(await h.gateway.execute(caller(), mail("READ"))).toMatchObject({
        kind: "failed",
        failureClass: "RATE_LIMIT",
        retryable: true,
      });
      h.connector.mode = "ok";
      const blocked = await h.gateway.execute(caller(), mail("READ"));
      expect(blocked).toMatchObject({ kind: "failed", failureClass: "RATE_LIMIT" });
      const inv = await h.gateway.inventory(caller());
      expect(inv.connectors.find((c) => c.connectorId === "fake")!.instances[0]).toMatchObject({
        status: "RATE_LIMITED",
      });
      h.clock.advance(31_000);
      expect((await h.gateway.execute(caller(), mail("READ"))).kind).toBe("succeeded");
    });

    it("P12 — every tool result is linked to durable audit", async () => {
      await h.grant("agent-1", "mail", "SEND");
      await approveSend("aud-key-0001");
      const done = await h.gateway.execute(caller(), mail("SEND", "aud-key-0001"));
      expect(done.kind).toBe("succeeded");
      const audit = await readAudit(h);
      const byId = new Map(audit.map((a) => [a.id, a]));
      expect(done.auditReferences.length).toBeGreaterThanOrEqual(3);
      for (const ref of done.auditReferences) {
        expect(byId.get(ref)?.details.toolExecutionId).toBe(done.toolExecutionId);
      }
      const row = (await h.executions.getByKey(TENANT_A, "aud-key-0001"))!;
      expect(row).toMatchObject({
        status: "SUCCEEDED",
        settlementState: "APPLIED",
        providerOperationId: "op-aud-key-0001",
        attemptCount: 1,
      });
      expect(row.auditReferences).toEqual(done.auditReferences);
      expect(
        audit.some((a) => a.eventType === "tool.approval.decided" && a.actor.kind === "human"),
      ).toBe(true);
    });

    it("P13 — restart reconciles an in-flight side effect instead of repeating it", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      // Provider applied the effect, then the connection died: outcome unknown.
      h.connector.mode = "applied_then_crash";
      const r = await h.gateway.execute(caller(), mail("CREATE", "rec-key-0001"));
      expect(r).toMatchObject({ kind: "failed", failureClass: "UNKNOWN", retryable: false });
      expect((await h.executions.getByKey(TENANT_A, "rec-key-0001"))!.settlementState).toBe(
        "UNKNOWN",
      );
      // "Restart": a fresh gateway over the same durable stores.
      h.connector.mode = "ok";
      h.rebuild();
      const settled = await h.gateway.reconcile(TENANT_A);
      expect(settled.map((s) => s.status)).toEqual(["SUCCEEDED"]);
      const retry = await h.gateway.execute(caller(), mail("CREATE", "rec-key-0001"));
      expect(retry).toMatchObject({ kind: "succeeded", replayed: true });
      expect(h.connector.effects.get("rec-key-0001")).toBe(1);

      // A crash while EXECUTING (hung dispatch) is reconciled once orphaned.
      h.connector.mode = "hang";
      const hung = await h.gateway.execute(caller(), mail("CREATE", "rec-key-0002"));
      expect(hung).toMatchObject({ kind: "failed", failureClass: "TIMEOUT" });
      h.connector.mode = "ok";
      h.rebuild();
      const again = await h.gateway.execute(caller(), mail("CREATE", "rec-key-0002"));
      // Never applied at the provider → reconciliation proves it, and only then is it re-dispatched.
      expect(again).toMatchObject({ kind: "succeeded", replayed: false });
      expect(h.connector.effects.get("rec-key-0002")).toBe(1);
    });

    it("P14 — tool scope is isolated per client (tenant)", async () => {
      await h.grant("agent-1", "mail", "CREATE", TENANT_A);
      // Tenant B cannot use tenant A's instance, grant, or see its evidence.
      const cross = await h.gateway.execute(
        caller("agent-1", TENANT_B),
        mail("CREATE", "iso-key-0001"),
      );
      expect(cross).toMatchObject({ kind: "failed", failureClass: "POLICY_DENIED" });
      const inB = await h.gateway.execute(caller("agent-1", TENANT_B), {
        ...mail("CREATE", "iso-key-0001"),
        connectorInstanceId: "inst-b",
      });
      expect(inB).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      await h.grant("agent-1", "mail", "CREATE", TENANT_B);
      // Same idempotency key in both tenants: two independent executions.
      const a = await h.gateway.execute(
        caller("agent-1", TENANT_A),
        mail("CREATE", "iso-key-0001"),
      );
      const b = await h.gateway.execute(caller("agent-1", TENANT_B), {
        ...mail("CREATE", "iso-key-0001"),
        connectorInstanceId: "inst-b",
      });
      expect(a.kind).toBe("succeeded");
      expect(b.kind).toBe("succeeded");
      expect(a.toolExecutionId).not.toBe(b.toolExecutionId);
      const listA = await h.executions.list(TENANT_A);
      expect(listA.every((e) => e.tenantId === TENANT_A)).toBe(true);
      expect(await h.executions.getByKey(TENANT_B, "missing")).toBeNull();
      const invB = await h.gateway.inventory(caller("agent-1", TENANT_B));
      expect(JSON.stringify(invB)).not.toContain("inst-a");
    });

    it("P15 — UNKNOWN safety state fails closed", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      await h.grant("agent-1", "mail", "READ");
      // Unknown connector health → no dispatch.
      h.registry.setStatus("inst-a", "UNKNOWN");
      expect(await h.gateway.execute(caller(), mail("READ"))).toMatchObject({
        kind: "failed",
        failureClass: "PROVIDER_UNAVAILABLE",
      });
      h.registry.setStatus("inst-a", "HEALTHY");
      // Unknown requester → deny.
      expect(await h.gateway.execute(caller("ghost"), mail("READ"))).toMatchObject({
        kind: "failed",
        failureClass: "PERMISSION_DENIED",
      });
      // Unknown provider outcome on a side effect, without reconciliation → never re-dispatched.
      h.connector.mode = "throw";
      expect(await h.gateway.execute(caller(), mail("CREATE", "unk-key-0001"))).toMatchObject({
        kind: "failed",
        failureClass: "UNKNOWN",
        retryable: false,
      });
      h.connector.mode = "ok";
      h.connector.reconcile = async () => ({ settlement: "UNKNOWN" as const });
      for (let i = 0; i < 2; i++) {
        expect(await h.gateway.execute(caller(), mail("CREATE", "unk-key-0001"))).toMatchObject({
          kind: "failed",
          failureClass: "SETTLEMENT_UNKNOWN",
          retryable: false,
        });
      }
      expect(h.connector.effects.has("unk-key-0001")).toBe(false);
      // Insufficient kernel authorization level → deny even with a grant.
      await h.grant("agent-low", "vfs", "WRITE");
      expect(
        await h.gateway.execute(caller("agent-low"), fs("WRITE", "low-key-0001")),
      ).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      const snap = await h.gateway.cockpitSnapshot(TENANT_A);
      expect(snap.unsettled.map((e) => e.idempotencyKey)).toContain("unk-key-0001");
      expect(snap.blocked.length).toBeGreaterThan(0);
    });
  });
}
