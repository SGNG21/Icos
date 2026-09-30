import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession, Role } from "@/core/identity";
import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import type { AuthGateway } from "@/server/auth/ports";
import { buildMemoryContainer, type Container } from "@/server/container";
import { TOOL_GATEWAY_RUNTIME_KEY } from "@/server/tool-gateway/app";
import { composeToolGateway, type ToolGatewayRuntime } from "@/server/tool-gateway/composition";
import {
  ArrayAudit,
  Clock,
  FakeConnector,
  SECRET,
  agent,
} from "@/server/tool-gateway/test-fixtures";

import { POST as decide } from "./approvals/[id]/decision/route";
import { GET as listApprovals } from "./approvals/route";
import { GET as cockpit } from "./cockpit/route";
import { GET as listGrants, POST as postGrant } from "./grants/route";

const CONTAINER_KEY = "__icosContainerPromise__";
const ORIGIN = "http://localhost";
const COOKIE = "icos.session_token=opaque-test-value";
const T = CURRENT_SINGLE_TENANT_ID;

let rt: ToolGatewayRuntime;
let clock: Clock;

function install(role: Role | null): Container {
  const session: AuthenticatedSession | null = role
    ? { user: { id: "human-1", email: "h@icos.test", name: "H", status: "active" }, roles: [role] }
    : null;
  const auth: AuthGateway = {
    createHumanUser: async () => ({ ok: false, reason: "invalid_input" }),
    readHumanUser: async () => session?.user ?? null,
    readHumanUserByEmail: async () => session?.user ?? null,
    deleteHumanUser: async () => {},
    readSession: vi.fn(async () => session),
    revokeSession: async () => {},
    revokeUserSessions: async () => {},
  };
  const container: Container = { ...buildMemoryContainer(), auth };
  (globalThis as Record<string, unknown>)[CONTAINER_KEY] = Promise.resolve(container);
  (globalThis as Record<string, unknown>)[TOOL_GATEWAY_RUNTIME_KEY] = Promise.resolve(rt);
  return container;
}

const req = (url: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method,
    headers: { "content-type": "application/json", origin: ORIGIN, cookie: COOKIE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const decideOn = (id: string, body: unknown, headers?: Record<string, string>) =>
  decide(req(`/api/tool-gateway/approvals/${id}/decision`, "POST", body, headers), {
    params: Promise.resolve({ id }),
  });

async function pendingSend(key: string) {
  const r = await rt.gateway.execute(
    { tenantId: T, agentId: "agent-1" },
    {
      toolId: "mail",
      action: "SEND",
      connectorInstanceId: "mail-1",
      input: { to: "client@example.com", subject: "Offer" },
      idempotencyKey: key,
    },
  );
  if (r.kind !== "approval_required") throw new Error(r.kind);
  return r.approvalRequestId;
}

beforeEach(async () => {
  clock = new Clock();
  rt = composeToolGateway({
    backend: "memory",
    agents: { getById: async (id) => (id.startsWith("agent-") ? agent(id) : null) },
    audit: new ArrayAudit() as never,
    connectors: [new FakeConnector()],
    env: { FAKE_TOOL_SECRET: SECRET },
    now: clock.now,
    config: {
      instances: [{ instanceId: "mail-1", connectorId: "fake", credentialRef: "cred_mail" }],
      credentials: { cred_mail: { envVar: "FAKE_TOOL_SECRET" } },
    },
  });
  await rt.reconciliation.runOnce();
  await rt.gateway.setGrant(
    { kind: "human", id: "owner-1", roles: ["owner"] },
    { tenantId: T, agentId: "agent-1", toolId: "mail", action: "SEND", reason: "test" },
    "grant",
  );
});

describe("tool approvals API", () => {
  it("requires approvals.decide to list or decide", async () => {
    const id = await pendingSend("route-key-001");
    install(null);
    expect((await listApprovals(req("/api/tool-gateway/approvals"))).status).toBe(401);
    install("viewer");
    expect((await listApprovals(req("/api/tool-gateway/approvals"))).status).toBe(403);
    expect((await decideOn(id, { decision: "APPROVED" })).status).toBe(403);
  });

  it("shows the decider the exact input, persists the SESSION identity, and never a forged one", async () => {
    const id = await pendingSend("route-key-002");
    install("operator");
    const list = (await (await listApprovals(req("/api/tool-gateway/approvals"))).json()) as {
      approvals: { approvalRequestId: string; inputPreview: unknown }[];
    };
    expect(list.approvals[0]).toMatchObject({
      approvalRequestId: id,
      inputPreview: { to: "client@example.com", subject: "Offer" },
    });
    // No identity field is accepted from the body.
    for (const forged of [
      { decision: "APPROVED", decidedBy: "ceo" },
      { decision: "APPROVED", approver: { kind: "human", id: "ceo" } },
      { decision: "APPROVED", roles: ["owner"] },
    ]) {
      expect((await decideOn(id, forged)).status).toBe(400);
    }
    expect(
      (await decideOn(id, { decision: "APPROVED" }, { origin: "http://evil.test" })).status,
    ).toBe(403);
    const ok = await decideOn(id, { decision: "APPROVED" });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { approval: { decidedBy: unknown; status: string } };
    expect(body.approval).toMatchObject({
      status: "APPROVED",
      decidedBy: { kind: "human", id: "human-1" },
    });
    // Decided once: a second decision (either way) is refused.
    expect((await decideOn(id, { decision: "REJECTED", reason: "changed mind" })).status).toBe(409);
  });

  it("rejection needs a reason, an expired request cannot be decided, an unknown one is 404", async () => {
    const id = await pendingSend("route-key-003");
    install("operator");
    expect((await decideOn(id, { decision: "REJECTED" })).status).toBe(400);
    expect((await decideOn("toolappr-nope", { decision: "APPROVED" })).status).toBe(404);
    clock.advance(600_001); // fake SEND approval TTL: 600 s
    const expired = await decideOn(id, { decision: "APPROVED" });
    expect(expired.status).toBe(409);
    expect(((await expired.json()) as { error: { details: unknown } }).error.details).toEqual({
      failureClass: "APPROVAL_EXPIRED",
    });
  });
});

describe("tool grants API", () => {
  const grant = {
    op: "grant",
    agentId: "agent-2",
    toolId: "mail",
    action: "READ",
    reason: "support triage",
  };

  it("only agentCapabilities.write may change grants; the grantor is the session user", async () => {
    install("operator");
    expect((await postGrant(req("/api/tool-gateway/grants", "POST", grant))).status).toBe(403);
    install("admin");
    expect(
      (
        await postGrant(
          req("/api/tool-gateway/grants", "POST", { ...grant, grantedBy: "someone-else" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await postGrant(req("/api/tool-gateway/grants", "POST", { ...grant, reason: "" }))).status,
    ).toBe(400);
    expect(
      (
        await postGrant(
          req("/api/tool-gateway/grants", "POST", grant, { origin: "http://evil.test" }),
        )
      ).status,
    ).toBe(403);
    const created = await postGrant(req("/api/tool-gateway/grants", "POST", grant));
    expect(created.status).toBe(201);
    expect(((await created.json()) as { grant: unknown }).grant).toMatchObject({
      agentId: "agent-2",
      grantedBy: "human-1",
      reason: "support triage",
    });
    const revoked = await postGrant(
      req("/api/tool-gateway/grants", "POST", { ...grant, op: "revoke", reason: "rotation" }),
    );
    expect(revoked.status).toBe(200);
    install("viewer");
    const listed = (await (
      await listGrants(req("/api/tool-gateway/grants?agentId=agent-2"))
    ).json()) as {
      grants: unknown[];
    };
    expect(listed.grants).toEqual([
      expect.objectContaining({
        grantedBy: "human-1",
        revokedBy: "human-1",
        revokeReason: "rotation",
      }),
    ]);
  });
});

describe("tool cockpit API", () => {
  it("is read-only, factual, previews-free and secret-free", async () => {
    await pendingSend("route-key-004");
    install(null);
    expect((await cockpit(req("/api/tool-gateway/cockpit"))).status).toBe(401);
    install("viewer");
    const res = await cockpit(req("/api/tool-gateway/cockpit"));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("client@example.com"); // preview withheld from cockpit.read
    const body = JSON.parse(text) as {
      connectorHealth: { instanceId: string; status: string; credentialRef?: string }[];
      pendingApprovals: { inputFields: string[] }[];
      inventory: { tools: { actions: Record<string, unknown>[] }[] }[];
      rateLimited: unknown[];
      blocked: unknown[];
      recentSideEffects: unknown[];
      failures: unknown[];
    };
    expect(body.connectorHealth).toEqual([
      expect.objectContaining({
        instanceId: "mail-1",
        status: "HEALTHY",
        credentialRef: "cred_mail",
      }),
    ]);
    expect(body.pendingApprovals[0].inputFields).toEqual(["to", "subject"]);
    expect(body.inventory[0].tools[0].actions[0]).not.toHaveProperty("permitted");
    for (const k of ["rateLimited", "blocked", "recentSideEffects", "failures"] as const) {
      expect(Array.isArray(body[k])).toBe(true);
    }
  });
});
