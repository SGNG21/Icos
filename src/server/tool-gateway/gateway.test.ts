import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { toolDefinitionSchema } from "@/core/tool-gateway/model";

import { NOT_CONNECTED_DEFINITIONS, act, notConnected } from "./connectors/catalog";
import { classifyHttpStatus, httpConnector } from "./connectors/http";
import { localFilesConnector } from "./connectors/local-files";
import { ToolGateway } from "./gateway";
import { defineGatewayProofs } from "./gateway-proofs";
import {
  ConnectorRegistry,
  InMemoryToolApprovalStore,
  InMemoryToolExecutionStore,
  InMemoryToolGrantStore,
} from "./in-memory";
import { SecretValue } from "./ports";
import { SECRET, agent, caller, makeHarness } from "./test-fixtures";

defineGatewayProofs(
  "in-memory",
  async () => makeHarness(),
  async (h) => [
    ...(h.executions as InMemoryToolExecutionStore).audit,
    ...(h.approvals as InMemoryToolApprovalStore).audit,
    ...(h.grants as InMemoryToolGrantStore).audit,
  ],
);

describe("time of check / time of use", () => {
  it("a grant revoked while the credential resolves stops the dispatch", async () => {
    const h = makeHarness();
    await h.grant("agent-1", "mail", "READ");
    const grants = h.grants as InMemoryToolGrantStore;
    const gw = new ToolGateway({
      connectors: [h.connector],
      registry: h.registry,
      agents: { getById: async (id) => agent(id) },
      grants,
      executions: h.executions,
      approvals: h.approvals,
      credentials: {
        resolve: async () => {
          grants.rows.splice(0); // revoked mid-flight
          return { ok: true, secret: new SecretValue(SECRET) };
        },
      },
    });
    const r = await gw.execute(caller(), {
      toolId: "mail",
      action: "READ",
      connectorInstanceId: "inst-a",
      input: {},
    });
    expect(r).toMatchObject({ kind: "failed", failureClass: "PERMISSION_DENIED" });
    expect(h.connector.seenCredential).toBeUndefined();
  });

  it("a connector instance id cannot be taken over by another tenant", () => {
    const registry = new ConnectorRegistry();
    registry.register({
      instanceId: "shared-1",
      connectorId: "fake",
      tenantId: "t1",
      config: {},
      status: "HEALTHY",
    });
    expect(() =>
      registry.register({
        instanceId: "shared-1",
        connectorId: "fake",
        tenantId: "t2",
        config: {},
        status: "HEALTHY",
      }),
    ).toThrow(/another tenant/);
  });
});

describe("credential boundary", () => {
  it("SecretValue never serialises its value", () => {
    const s = new SecretValue(SECRET);
    const text = `${JSON.stringify({ s })} ${String(s)} ${inspect({ s })}`;
    expect(text).not.toContain(SECRET);
    expect(s.reveal()).toBe(SECRET);
  });
});

describe("tool definitions", () => {
  it("reject an external side effect without key_required idempotency", () => {
    const bad = { ...act("SEND", "LOW", "external", "x"), idempotency: "natural" };
    const r = toolDefinitionSchema.safeParse({
      toolId: "x-tool",
      version: "1.0.0",
      category: "EMAIL",
      description: "x",
      capabilities: [],
      actions: [bad],
      timeoutMs: 1000,
      auditPolicy: { persistResult: "none" },
    });
    expect(r.success).toBe(false);
  });

  it("every category of Phase 7 exists; contract-only ones are NOT_CONNECTED and refuse", async () => {
    const categories = new Set([
      ...NOT_CONNECTED_DEFINITIONS.map((d) => d.category),
      "FILES",
      "HTTP",
    ]);
    for (const c of [
      "EMAIL",
      "CALENDAR",
      "FILES",
      "GITHUB",
      "BROWSER",
      "TERMINAL",
      "CRM",
      "INVOICING",
      "TELEPHONY",
      "ANALYTICS",
      "SOCIAL",
      "MCP",
      "HTTP",
    ]) {
      expect(categories.has(c as never)).toBe(true);
    }
    const email = NOT_CONNECTED_DEFINITIONS.find((d) => d.connectorId === "email")!;
    const registry = new ConnectorRegistry();
    registry.register({
      instanceId: "mail-1",
      connectorId: "email",
      tenantId: "t1",
      config: {},
      status: "CONFIGURED",
    });
    const grants = new InMemoryToolGrantStore();
    const gw = new ToolGateway({
      connectors: [notConnected(email)],
      registry,
      agents: { getById: async (id) => agent(id) },
      grants,
      executions: new InMemoryToolExecutionStore(),
      approvals: new InMemoryToolApprovalStore(),
      credentials: { resolve: async () => ({ ok: false, reason: "not_found" }) },
    });
    await gw.setGrant(
      { kind: "human", id: "o", roles: ["owner"] },
      { tenantId: "t1", agentId: "a-1", toolId: "email", action: "READ" },
      "grant",
    );
    const r = await gw.execute(
      { tenantId: "t1", agentId: "a-1" },
      { toolId: "email", action: "READ", connectorInstanceId: "mail-1", input: {} },
    );
    expect(r).toMatchObject({ kind: "failed", failureClass: "NOT_CONNECTED" });
  });

  it("the risk model matches the governance examples", () => {
    const risk = (id: string, action: string) =>
      NOT_CONNECTED_DEFINITIONS.flatMap((d) => d.tools)
        .find((t) => t.toolId === id)!
        .actions.find((a) => a.action === action)!.risk;
    expect(risk("crm", "READ")).toBe("LOW");
    expect(risk("email", "CREATE")).toBe("LOW");
    expect(risk("email", "SEND")).toBe("HIGH");
    expect(risk("github", "DEPLOY")).toBe("HIGH");
    expect(risk("crm", "DELETE")).toBe("CRITICAL");
    expect(risk("invoicing", "PAY")).toBe("CRITICAL");
  });
});

describe("local files connector", () => {
  async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), "icos-files-"));
    const outside = await mkdtemp(path.join(tmpdir(), "icos-outside-"));
    await writeFile(path.join(root, "a.txt"), "hello");
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await mkdir(path.join(root, "sub"));
    await symlink(outside, path.join(root, "sub", "escape"));
    const ctx = {
      instance: {
        instanceId: "files-1",
        connectorId: "local-files",
        tenantId: "t1",
        config: { root },
        status: "HEALTHY" as const,
      },
      signal: AbortSignal.timeout(5000),
      idempotencyKey: "k",
      toolExecutionId: "e",
    };
    return { root, ctx };
  }

  it("reads, writes and searches inside the root", async () => {
    const { ctx } = await setup();
    expect(
      await localFilesConnector.execute("files", "READ", { path: "a.txt" }, ctx),
    ).toMatchObject({ ok: true, output: { content: "hello" } });
    expect(
      (await localFilesConnector.execute("files", "WRITE", { path: "d/b.txt", content: "x" }, ctx))
        .ok,
    ).toBe(true);
    expect(
      await localFilesConnector.execute("files", "SEARCH", { query: "b.txt" }, ctx),
    ).toMatchObject({ ok: true, output: { matches: ["d/b.txt"] } });
    expect(
      await localFilesConnector.execute("files", "READ", { path: "missing.txt" }, ctx),
    ).toMatchObject({ ok: false, failureClass: "NOT_FOUND" });
  });

  it("refuses to write through a dangling symlink to outside the root", async () => {
    const { root, ctx } = await setup();
    const outside = await mkdtemp(path.join(tmpdir(), "icos-dangling-"));
    await symlink(path.join(outside, "pwned.txt"), path.join(root, "evil"));
    const r = await localFilesConnector.execute(
      "files",
      "WRITE",
      { path: "evil", content: "x" },
      ctx,
    );
    expect(r).toMatchObject({ ok: false, failureClass: "INVALID_INPUT" });
    await expect(stat(path.join(outside, "pwned.txt"))).rejects.toThrow();
  });

  it("refuses absolute paths, traversal and symlink escapes", async () => {
    const { ctx } = await setup();
    for (const p of [
      "/etc/passwd",
      "../x",
      "sub/../../x",
      "sub/escape/secret.txt",
      "sub/escape/new.txt",
    ]) {
      const r = await localFilesConnector.execute(
        "files",
        p.endsWith("new.txt") ? "WRITE" : "READ",
        { path: p, content: "x" },
        ctx,
      );
      expect(r).toMatchObject({ ok: false, failureClass: "INVALID_INPUT" });
    }
  });
});

describe("http connector", () => {
  const ctx = (credential?: SecretValue) => ({
    instance: {
      instanceId: "h-1",
      connectorId: "http",
      tenantId: "t1",
      config: { baseUrl: "https://api.example.com/v1" },
      status: "HEALTHY" as const,
    },
    credential,
    signal: AbortSignal.timeout(5000),
    idempotencyKey: "idem-1234",
    toolExecutionId: "e",
  });

  it("classifies provider statuses", () => {
    expect(classifyHttpStatus(401).failureClass).toBe("AUTH_FAILURE");
    expect(classifyHttpStatus(429)).toEqual({ failureClass: "RATE_LIMIT", notApplied: true });
    expect(classifyHttpStatus(503)).toEqual({
      failureClass: "PROVIDER_UNAVAILABLE",
      notApplied: false,
    });
  });

  it("injects the credential only on the wire, forwards the idempotency key, stays on the base origin", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 7 }), {
        status: 201,
        headers: { "content-type": "application/json", "x-request-id": "req-1" },
      });
    }) as unknown as typeof fetch;
    const c = httpConnector(fake);
    const r = await c.execute(
      "http-api",
      "WRITE",
      { method: "POST", path: "/items", body: { a: 1 } },
      ctx(new SecretValue(SECRET)),
    );
    expect(r).toMatchObject({
      ok: true,
      providerOperationId: "req-1",
      output: { status: 201, body: { id: 7 } },
    });
    expect(calls[0].url).toBe("https://api.example.com/v1/items");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(headers["idempotency-key"]).toBe("idem-1234");
    expect(calls[0].init.redirect).toBe("error");
    for (const p of ["https://evil.com/x", "//evil.com/x", "/../admin", "items"]) {
      expect(await c.execute("http-api", "READ", { path: p }, ctx())).toMatchObject({
        ok: false,
        failureClass: "INVALID_INPUT",
      });
    }
    expect(calls).toHaveLength(1);
  });

  it("a network failure on a write is UNKNOWN settlement, never NOT_APPLIED", async () => {
    const c = httpConnector((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch);
    expect(
      await c.execute("http-api", "WRITE", { method: "POST", path: "/x" }, ctx()),
    ).toMatchObject({ ok: false, failureClass: "NETWORK_ERROR", settlement: "UNKNOWN" });
  });

  it("runs end to end through the gateway with a human-approved write", async () => {
    let hits = 0;
    const fake = (async () => {
      hits++;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const registry = new ConnectorRegistry();
    registry.register({
      instanceId: "h-1",
      connectorId: "http",
      tenantId: "t1",
      config: { baseUrl: "https://api.example.com" },
      status: "HEALTHY",
    });
    const gw = new ToolGateway({
      connectors: [httpConnector(fake)],
      registry,
      agents: { getById: async (id) => agent(id) },
      grants: new InMemoryToolGrantStore(),
      executions: new InMemoryToolExecutionStore(),
      approvals: new InMemoryToolApprovalStore(),
      credentials: { resolve: async () => ({ ok: false, reason: "not_found" }) },
    });
    await gw.setGrant(
      { kind: "human", id: "o", roles: ["admin"] },
      { tenantId: "t1", agentId: "agent-1", toolId: "http-api", action: "WRITE" },
      "grant",
    );
    const intent = {
      toolId: "http-api",
      action: "WRITE",
      connectorInstanceId: "h-1",
      input: { method: "POST", path: "/x" },
      idempotencyKey: "http-key-01",
    };
    const first = await gw.execute(caller("agent-1", "t1"), intent);
    if (first.kind !== "approval_required") throw new Error(first.kind);
    expect(hits).toBe(0);
    await gw.decideApproval(
      "t1",
      first.approvalRequestId,
      { kind: "human", id: "h", roles: ["operator"] },
      "APPROVED",
    );
    expect((await gw.execute(caller("agent-1", "t1"), intent)).kind).toBe("succeeded");
    expect((await gw.execute(caller("agent-1", "t1"), intent)).kind).toBe("succeeded");
    expect(hits).toBe(1);
  });
});
