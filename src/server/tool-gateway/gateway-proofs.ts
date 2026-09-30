import { beforeEach, describe, expect, it } from "vitest";

import type { AuditEntry } from "@/core/contracts";

import {
  HARNESS_HEALTH_TTL_MS,
  SECRET,
  TENANT_A,
  TENANT_B,
  caller,
  human,
  observable,
  type Harness,
} from "./test-fixtures";

/**
 * The 15 Tool Gateway proofs (decision 0058), written once and run against
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

    async function approveSend(key: string, input?: Record<string, unknown>) {
      const first = await h.gateway.execute(caller(), mail("SEND", key, input));
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
      const other = await h.gateway.execute(
        caller(),
        mail("SEND", "appr-key-002", { to: "someone-else@example.com" }),
      );
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

    it("R1 — a key and its approval belong to the requester; another agent cannot spend or replay them", async () => {
      const merge = {
        toolId: "repo",
        action: "MERGE",
        connectorInstanceId: "inst-a",
        input: { pr: 42 },
        idempotencyKey: "merge-key-01",
      };
      await h.grant("agent-1", "repo", "MERGE");
      await h.grant("agent-2", "repo", "MERGE");
      const first = await h.gateway.execute(caller("agent-1"), merge);
      if (first.kind !== "approval_required") throw new Error(first.kind);
      expect(
        (await h.gateway.decideApproval(TENANT_A, first.approvalRequestId, human(), "APPROVED")).ok,
      ).toBe(true);
      const stolen = await h.gateway.execute(caller("agent-2"), merge);
      expect(stolen).toMatchObject({
        kind: "failed",
        failureClass: "IDEMPOTENCY_CONFLICT",
        retryable: false,
        message: "idempotencyKey already used by another requester",
      });
      // Nothing about agent-1's execution leaks: no id, only the denial's own audit entry.
      expect(stolen.toolExecutionId).toBeUndefined();
      expect(stolen.auditReferences).toHaveLength(1);
      expect(stolen.auditReferences).not.toContain(first.auditReferences[0]);
      expect(h.connector.effectCount()).toBe(0);
      const own = await h.gateway.execute(caller("agent-1"), merge);
      expect(own.kind).toBe("succeeded");
      expect(h.connector.effects.get("merge-key-01")).toBe(1);
      // Without the grant any more, even the requester gets no replay.
      await h.gateway.setGrant(
        human("admin-1", ["admin"]),
        { tenantId: TENANT_A, agentId: "agent-1", toolId: "repo", action: "MERGE", reason: "test" },
        "revoke",
      );
      const revoked = await h.gateway.execute(caller("agent-1"), merge);
      expect(revoked).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      expect(revoked.toolExecutionId).toBeUndefined();
    });

    it("R2 — the approver sees exactly what will run", async () => {
      await h.grant("agent-1", "mail", "SEND");
      const input = { to: "client@example.com", subject: "Invoice 42", body: "Please find…" };
      const r = await h.gateway.execute(caller(), mail("SEND", "prev-key-001", input));
      if (r.kind !== "approval_required") throw new Error(r.kind);
      const pending = (await h.gateway.cockpitSnapshot(TENANT_A)).pendingApprovals;
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        approvalRequestId: r.approvalRequestId,
        inputPreview: input,
        riskClass: "HIGH",
      });
      const huge = await h.gateway.execute(
        caller(),
        mail("SEND", "prev-key-002", { body: "x".repeat(9000) }),
      );
      expect(huge).toMatchObject({ kind: "failed", failureClass: "INVALID_INPUT" });
    });

    it("R3 — an approving agent needs operator authority", async () => {
      await h.grant("agent-1", "vfs", "WRITE");
      const r = await h.gateway.execute(caller(), fs("WRITE", "fs-write-low"));
      if (r.kind !== "approval_required") throw new Error(r.kind);
      expect(
        await h.gateway.decideApproval(
          TENANT_A,
          r.approvalRequestId,
          { kind: "agent", id: "agent-low" },
          "APPROVED",
        ),
      ).toMatchObject({ ok: false, failureClass: "PERMISSION_DENIED" });
      expect(
        (
          await h.gateway.decideApproval(
            TENANT_A,
            r.approvalRequestId,
            { kind: "agent", id: "agent-2" },
            "APPROVED",
          )
        ).ok,
      ).toBe(true);
    });

    it("S1 — input is validated against the declared schema before anything else runs", async () => {
      await h.grant("agent-1", "mail", "SEND");
      for (const [key, input] of [
        ["schema-key-01", { to: 42 }],
        ["schema-key-02", { subject: "no recipient" }],
        ["schema-key-03", { to: "x@example.com", bcc: "hidden@example.com" }],
      ] as const) {
        const r = await h.gateway.execute(caller(), mail("SEND", key, input as never));
        expect(r).toMatchObject({ kind: "failed", failureClass: "INVALID_INPUT" });
        const row = (await h.executions.getByKey(TENANT_A, key))!;
        expect(row).toMatchObject({ status: "DENIED", failureClass: "INVALID_INPUT" });
        expect(row.approvalRequestId).toBeUndefined();
        const audit = await readAudit(h);
        expect(
          audit.some(
            (a) =>
              a.details.toolExecutionId === row.toolExecutionId && a.details.status === "DENIED",
          ),
        ).toBe(true);
      }
      expect(await h.approvals.listPending(TENANT_A)).toHaveLength(0);
      expect(h.connector.effectCount()).toBe(0);
    });

    it("S2 — every refusal before execution leaves audit evidence and no side effect", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      await h.grant("agent-2", "mail", "CREATE");
      const MARKER = "PII-MARKER-jane.doe@example.com";
      const cases: [string, unknown, string][] = [
        [
          "INVALID_INTENT",
          { ...mail("CREATE", "den-key-0001", { to: MARKER }), approval: "approved" },
          "agent-1",
        ],
        [
          "UNKNOWN_CONNECTOR_INSTANCE",
          { ...mail("CREATE", "den-key-0002", { to: MARKER }), connectorInstanceId: "nope-1" },
          "agent-1",
        ],
        [
          "FOREIGN_CONNECTOR_INSTANCE",
          { ...mail("CREATE", "den-key-0003", { to: MARKER }), connectorInstanceId: "inst-b" },
          "agent-1",
        ],
        [
          "UNKNOWN_TOOL",
          { ...mail("CREATE", "den-key-0004", { to: MARKER }), toolId: "nothing" },
          "agent-1",
        ],
        ["MISSING_IDEMPOTENCY_KEY", mail("CREATE", undefined, { to: MARKER }), "agent-1"],
      ];
      for (const [reason, intent, who] of cases) {
        const r = await h.gateway.execute(caller(who), intent);
        expect(r.kind).toBe("failed");
        expect(r.auditReferences).toHaveLength(1);
        const audit = await readAudit(h);
        const entry = audit.find((a) => a.id === r.auditReferences[0])!;
        expect(entry).toMatchObject({
          eventType: "tool.request.denied",
          actor: { kind: "agent", id: who },
        });
        expect(entry.details.reason).toBe(reason);
      }
      // Keys used by someone else, or reused for another payload, are audited refusals too.
      expect(
        (await h.gateway.execute(caller("agent-1"), mail("CREATE", "den-key-0010", { to: MARKER })))
          .kind,
      ).toBe("succeeded");
      const other = await h.gateway.execute(
        caller("agent-2"),
        mail("CREATE", "den-key-0010", { to: MARKER }),
      );
      const changed = await h.gateway.execute(
        caller("agent-1"),
        mail("CREATE", "den-key-0010", { to: "changed@example.com" }),
      );
      const audit = await readAudit(h);
      const reasonOf = (r: { auditReferences: string[] }) =>
        audit.find((a) => a.id === r.auditReferences[0])?.details.reason;
      expect(reasonOf(other)).toBe("IDEMPOTENCY_KEY_OF_ANOTHER_REQUESTER");
      expect(reasonOf(changed)).toBe("IDEMPOTENCY_KEY_PAYLOAD_MISMATCH");
      // Post-claim denials (no grant, approval required) are recorded on their execution row.
      const noGrant = await h.gateway.execute(caller("agent-1"), mail("SEND", "den-key-0011"));
      expect(noGrant).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
      expect((await h.executions.getByKey(TENANT_A, "den-key-0011"))!.status).toBe("DENIED");
      // Only the one legitimate CREATE ran; no audit entry carries the input.
      expect(h.connector.effectCount()).toBe(1);
      const denials = audit.filter((a) => a.eventType === "tool.request.denied");
      expect(denials.length).toBeGreaterThanOrEqual(7);
      expect(JSON.stringify(denials)).not.toContain(MARKER);
    });

    it("S3 — the same high-risk operation under a new key is stopped unless knowingly repeated", async () => {
      await h.grant("agent-1", "mail", "SEND");
      await h.grant("agent-2", "mail", "SEND");
      await h.grant("agent-1", "mail", "CREATE");
      const input = { to: "client@example.com", subject: "Invoice 42" };
      const first = await approveSend("dupop-key-01", input);
      expect((await h.gateway.execute(caller(), mail("SEND", "dupop-key-01", input))).kind).toBe(
        "succeeded",
      );
      // New key, same meaningful operation — by the same agent or another one.
      for (const [who, key] of [
        ["agent-1", "dupop-key-02"],
        ["agent-2", "dupop-key-03"],
      ] as const) {
        const again = await h.gateway.execute(caller(who), mail("SEND", key, input));
        expect(again).toMatchObject({
          kind: "failed",
          failureClass: "DUPLICATE_OPERATION",
          retryable: false,
        });
        if (again.kind !== "failed") throw new Error(again.kind);
        // The prior execution id is disclosed to its own requester only.
        expect(again.message.includes(first.toolExecutionId)).toBe(who === "agent-1");
      }
      expect(await h.approvals.listPending(TENANT_A)).toHaveLength(0); // no approval even requested
      // An override must name the execution it repeats.
      const wrong = await h.gateway.execute(caller(), {
        ...mail("SEND", "dupop-key-04", input),
        duplicateOverride: { ofExecutionId: "toolexec-nope", reason: "resend" },
      });
      expect(wrong).toMatchObject({ kind: "failed", failureClass: "DUPLICATE_OPERATION" });
      const repeat = await h.gateway.execute(caller(), {
        ...mail("SEND", "dupop-key-05", input),
        duplicateOverride: {
          ofExecutionId: first.toolExecutionId,
          reason: "client asked for a resend",
        },
      });
      if (repeat.kind !== "approval_required") throw new Error(repeat.kind);
      // The approver sees that this is a knowing repeat.
      expect((await h.approvals.get(TENANT_A, repeat.approvalRequestId))!.duplicateOf).toBe(
        first.toolExecutionId,
      );
      await h.gateway.decideApproval(TENANT_A, repeat.approvalRequestId, human(), "APPROVED");
      const done = await h.gateway.execute(caller(), {
        ...mail("SEND", "dupop-key-05", input),
        duplicateOverride: {
          ofExecutionId: first.toolExecutionId,
          reason: "client asked for a resend",
        },
      });
      expect(done.kind).toBe("succeeded");
      expect((await h.executions.getByKey(TENANT_A, "dupop-key-05"))!.duplicateOf).toBe(
        first.toolExecutionId,
      );
      expect(h.connector.effectCount()).toBe(2);
      // Ordinary repeats stay possible: drafts, and the same send after the window.
      expect((await h.gateway.execute(caller(), mail("CREATE", "draft-dup-01", input))).kind).toBe(
        "succeeded",
      );
      expect((await h.gateway.execute(caller(), mail("CREATE", "draft-dup-02", input))).kind).toBe(
        "succeeded",
      );
      h.clock.advance(24 * 3600_000 + 1_000);
      await h.gateway.probeHealth(TENANT_A);
      expect((await h.gateway.execute(caller(), mail("SEND", "dupop-key-06", input))).kind).toBe(
        "approval_required",
      );
    });

    it("S4 — an approval is single-use", async () => {
      await h.grant("agent-1", "mail", "SEND");
      const first = await approveSend("once-key-001");
      h.connector.mode = "ratelimit"; // provider refuses; nothing applied
      expect(await h.gateway.execute(caller(), mail("SEND", "once-key-001"))).toMatchObject({
        failureClass: "RATE_LIMIT",
        retryable: true,
      });
      expect((await h.approvals.get(TENANT_A, first.approvalRequestId))!.consumedAt).toBeDefined();
      h.connector.mode = "ok";
      h.clock.advance(31_000);
      // The retry needs a NEW approval: the first one was spent on the first dispatch.
      const retry = await h.gateway.execute(caller(), mail("SEND", "once-key-001"));
      expect(retry.kind).toBe("approval_required");
      if (retry.kind !== "approval_required") throw new Error("unreachable");
      expect(retry.approvalRequestId).not.toBe(first.approvalRequestId);
      expect(h.connector.effectCount()).toBe(0);
    });

    it("S5 — health is dated evidence: none or stale reads UNKNOWN, never an assumed HEALTHY", async () => {
      await h.grant("agent-1", "mail", "READ");
      h.clock.advance(HARNESS_HEALTH_TTL_MS + 1_000); // evidence expired, as after a long outage/restart
      const view = (await h.gateway.cockpitSnapshot(TENANT_A)).connectorHealth.find(
        (c) => c.instanceId === "inst-a",
      )!;
      expect(view.status).toBe("UNKNOWN");
      // A dispatch on stale evidence re-probes THIS instance first; a probe that throws is
      // UNKNOWN, so nothing is dispatched.
      h.connector.health = async () => {
        throw new Error("probe crashed");
      };
      expect(await h.gateway.execute(caller(), mail("READ"))).toMatchObject({
        failureClass: "PROVIDER_UNAVAILABLE",
      });
      expect((await h.gateway.cockpitSnapshot(TENANT_A)).connectorHealth[0].status).toBe("UNKNOWN");
      expect(h.connector.effectCount()).toBe(0);
      h.connector.health = async () => "DEGRADED";
      await h.gateway.probeHealth(TENANT_A);
      const degraded = (await h.gateway.cockpitSnapshot(TENANT_A)).connectorHealth[0];
      expect(degraded).toMatchObject({
        status: "DEGRADED",
        checkedAt: h.clock.now().toISOString(),
      });
      expect((await h.gateway.execute(caller(), mail("READ"))).kind).toBe("succeeded");
      // A restarted gateway reads the same evidence (no fabricated state either way).
      h.rebuild();
      expect((await h.gateway.cockpitSnapshot(TENANT_A)).connectorHealth[0].status).toBe(
        "DEGRADED",
      );
    });

    it("S6 — connector output is untrusted data and cannot change policy, grants or approvals", async () => {
      await h.grant("agent-1", "mail", "READ");
      await h.grant("agent-1", "mail", "SEND");
      const pending = await h.gateway.execute(caller(), mail("SEND", "adv-key-0001"));
      if (pending.kind !== "approval_required") throw new Error(pending.kind);
      const grantsBefore = await h.gateway.listGrants(TENANT_A);
      h.connector.mode = "adversarial";
      const r = await h.gateway.execute(caller(), mail("READ"));
      if (r.kind !== "succeeded") throw new Error(r.kind);
      expect(r.result).toMatchObject({
        trust: "UNTRUSTED_EXTERNAL_DATA",
        contentType: "application/json",
        source: { connectorId: "fake", instanceId: "inst-a", toolId: "mail", action: "READ" },
        toolExecutionId: r.toolExecutionId,
        scope: { tenantId: TENANT_A },
        replayed: false,
      });
      // The hostile text is delivered as data, verbatim, and nothing else happened.
      expect(r.result.data.system).toContain("SYSTEM OVERRIDE");
      expect(await h.gateway.listGrants(TENANT_A)).toEqual(grantsBefore);
      expect((await h.approvals.get(TENANT_A, pending.approvalRequestId))!.status).toBe("PENDING");
      h.connector.mode = "ok";
      expect((await h.gateway.execute(caller(), mail("SEND", "adv-key-0001"))).kind).toBe(
        "approval_required",
      );
      expect(h.connector.effectCount()).toBe(0);
      // The evidence records the trust class; the connector could not rewrite its instance.
      const row = (await h.executions.list(TENANT_A, { status: ["SUCCEEDED"] }))[0];
      expect(row.resultTrust).toBe("UNTRUSTED_EXTERNAL_DATA");
      expect(h.registry.get(TENANT_A, "inst-a")).toMatchObject({
        tenantId: TENANT_A,
        enabled: true,
      });
    });

    it("S7 — only an authorised human administers grants; revocation keeps its evidence", async () => {
      const g = {
        tenantId: TENANT_A,
        agentId: "agent-1",
        toolId: "mail",
        action: "SEND" as const,
        reason: "sales outreach",
      };
      expect(
        await h.gateway.setGrant({ kind: "agent", id: "agent-1" } as never, g, "grant"),
      ).toMatchObject({ ok: false, failureClass: "PERMISSION_DENIED" });
      expect(await h.gateway.setGrant(human("op-1", ["operator"]), g, "grant")).toMatchObject({
        ok: false,
        failureClass: "PERMISSION_DENIED",
      });
      expect(
        await h.gateway.setGrant(human("adm-1", ["admin"]), { ...g, reason: " " }, "grant"),
      ).toMatchObject({ ok: false, failureClass: "INVALID_INPUT" });
      expect(
        await h.gateway.setGrant(human("adm-1", ["admin"]), { ...g, agentId: "ghost" }, "grant"),
      ).toMatchObject({ ok: false, failureClass: "NOT_FOUND" });
      expect((await h.gateway.setGrant(human("adm-1", ["admin"]), g, "grant")).ok).toBe(true);
      const [active] = await h.gateway.listGrants(TENANT_A, "agent-1");
      expect(active).toMatchObject({ grantedBy: "adm-1", reason: "sales outreach" });
      expect(active.revokedAt).toBeUndefined();
      expect(
        (
          await h.gateway.setGrant(
            human("adm-2", ["admin"]),
            { ...g, reason: "campaign over" },
            "revoke",
          )
        ).ok,
      ).toBe(true);
      const [revoked] = await h.gateway.listGrants(TENANT_A, "agent-1");
      expect(revoked).toMatchObject({
        grantedBy: "adm-1",
        revokedBy: "adm-2",
        revokeReason: "campaign over",
      });
      expect(revoked.revokedAt).toBeDefined();
      expect(
        await h.gateway.checkCapabilities(caller(), [{ toolId: "mail", action: "SEND" }]),
      ).toEqual({
        granted: [],
        missing: [{ toolId: "mail", action: "SEND" }],
      });
      const audit = await readAudit(h);
      expect(audit.filter((a) => a.eventType === "tool.grant.changed").map((a) => a.actor)).toEqual(
        [
          { kind: "human", id: "adm-1" },
          { kind: "human", id: "adm-2" },
        ],
      );
    });

    it("R4 — an absurd provider Retry-After cannot crash settlement or pin the instance", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      h.connector.mode = "ratelimit";
      h.connector.retryAfter = 1e13;
      const r = await h.gateway.execute(caller(), mail("CREATE", "ra-key-00001"));
      expect(r).toMatchObject({ kind: "failed", failureClass: "RATE_LIMIT", retryable: true });
      expect(await h.executions.getByKey(TENANT_A, "ra-key-00001")).toMatchObject({
        status: "FAILED",
        settlementState: "NOT_APPLIED",
      });
      h.connector.mode = "ok";
      h.clock.advance(3_600_000 + 1_000); // clamped to at most 1 h
      expect((await h.gateway.execute(caller(), mail("CREATE", "ra-key-00001"))).kind).toBe(
        "succeeded",
      );
    });

    it("R5 — reconciliation does not rewrite an unresolvable settlement on every run", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      h.connector.reconcile = async () => ({ settlement: "UNKNOWN" as const });
      h.connector.mode = "throw";
      await h.gateway.execute(caller(), mail("CREATE", "churn-key-01"));
      expect((await h.gateway.reconcile(TENANT_A)).map((e) => e.failureClass)).toEqual([
        "SETTLEMENT_UNKNOWN",
      ]);
      const auditBefore = (await readAudit(h)).length;
      const version = (await h.executions.getByKey(TENANT_A, "churn-key-01"))!.version;
      for (let i = 0; i < 3; i++) expect(await h.gateway.reconcile(TENANT_A)).toEqual([]);
      expect((await readAudit(h)).length).toBe(auditBefore);
      expect((await h.executions.getByKey(TENANT_A, "churn-key-01"))!.version).toBe(version);
    });

    it("R6 — multibyte input over the preview budget is an audited refusal, never a crash", async () => {
      await h.grant("agent-1", "mail", "SEND");
      // 3000 chars, 9000 UTF-8 bytes: under a naive length check, over the byte budget.
      const r = await h.gateway.execute(
        caller(),
        mail("SEND", "mb-key-00001", { to: "x@example.com", body: "文".repeat(3000) }),
      );
      expect(r).toMatchObject({ kind: "failed", failureClass: "INVALID_INPUT" });
      expect((await h.executions.getByKey(TENANT_A, "mb-key-00001"))!.status).toBe("DENIED");
      expect(await h.approvals.listPending(TENANT_A)).toHaveLength(0);
    });

    it("R7 — refused approval decisions and grant changes are audited too", async () => {
      await h.grant("agent-1", "mail", "SEND");
      const p = await h.gateway.execute(caller(), mail("SEND", "refuse-key-1"));
      if (p.kind !== "approval_required") throw new Error(p.kind);
      await h.gateway.decideApproval(
        TENANT_A,
        p.approvalRequestId,
        human("v-1", ["viewer"]),
        "APPROVED",
      );
      await h.gateway.setGrant(
        human("op-1", ["operator"]),
        {
          tenantId: TENANT_A,
          agentId: "agent-1",
          toolId: "mail",
          action: "PAY" as never,
          reason: "x",
        },
        "grant",
      );
      const refusals = (await readAudit(h)).filter((a) => a.eventType === "tool.request.denied");
      expect(refusals.map((a) => [a.actor.id, a.details.reason])).toEqual([
        ["v-1", "APPROVAL_DECISION_REFUSED"],
        ["op-1", "GRANT_CHANGE_REFUSED"],
      ]);
    });

    it("P15 — UNKNOWN safety state fails closed", async () => {
      await h.grant("agent-1", "mail", "CREATE");
      await h.grant("agent-1", "mail", "READ");
      // Unknown connector health → no dispatch.
      await h.health.put({
        tenantId: TENANT_A,
        instanceId: "inst-a",
        status: "UNKNOWN",
        checkedAt: h.clock.now().toISOString(),
        expiresAt: new Date(h.clock.now().getTime() + 60_000).toISOString(),
      });
      expect(await h.gateway.execute(caller(), mail("READ"))).toMatchObject({
        kind: "failed",
        failureClass: "PROVIDER_UNAVAILABLE",
      });
      await h.gateway.probeHealth(TENANT_A);
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
