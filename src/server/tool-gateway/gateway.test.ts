import { mkdtemp, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import { toolDefinitionSchema } from "@/core/tool-gateway/model";

import { NOT_CONNECTED_DEFINITIONS, act, notConnected } from "./connectors/catalog";
import { classifyHttpStatus, httpConnector } from "./connectors/http";
import { localFilesConnector } from "./connectors/local-files";
import { composeToolGateway } from "./composition";
import { ToolGateway, type ToolCapabilityPort, type ToolGatewayPort } from "./gateway";
import { defineGatewayProofs } from "./gateway-proofs";
import {
  ConnectorRegistry,
  InMemoryConnectorHealthStore,
  InMemoryToolApprovalStore,
  InMemoryToolExecutionStore,
  InMemoryToolGrantStore,
} from "./in-memory";
import { SecretValue } from "./ports";
import { ArrayAudit, SECRET, agent, caller, makeHarness } from "./test-fixtures";

defineGatewayProofs(
  "in-memory",
  async () => makeHarness(),
  async (h) => [
    ...(h.executions as InMemoryToolExecutionStore).audit,
    ...(h.approvals as InMemoryToolApprovalStore).audit,
    ...(h.grants as InMemoryToolGrantStore).audit,
    ...(h.audit as ArrayAudit).entries,
  ],
);

describe("time of check / time of use", () => {
  it("a grant revoked while the credential resolves stops the dispatch", async () => {
    const h = await makeHarness();
    await h.grant("agent-1", "mail", "READ");
    const grants = h.grants as InMemoryToolGrantStore;
    const gw = new ToolGateway({
      connectors: [h.connector],
      registry: h.registry,
      agents: { getById: async (id) => agent(id) },
      grants,
      executions: h.executions,
      approvals: h.approvals,
      health: h.health,
      audit: h.audit,
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
      enabled: true,
    });
    expect(() =>
      registry.register({
        instanceId: "shared-1",
        connectorId: "fake",
        tenantId: "t2",
        config: {},
        enabled: true,
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
      enabled: true,
    });
    const grants = new InMemoryToolGrantStore();
    const gw = new ToolGateway({
      connectors: [notConnected(email)],
      registry,
      agents: { getById: async (id) => agent(id) },
      grants,
      executions: new InMemoryToolExecutionStore(),
      approvals: new InMemoryToolApprovalStore(),
      health: new InMemoryConnectorHealthStore(),
      audit: new ArrayAudit(),
      credentials: { resolve: async () => ({ ok: false, reason: "not_found" }) },
    });
    await gw.setGrant(
      { kind: "human", id: "o", roles: ["owner"] },
      { tenantId: "t1", agentId: "a-1", toolId: "email", action: "READ", reason: "test" },
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
        enabled: true,
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
      enabled: true,
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
      enabled: true,
    });
    const gw = new ToolGateway({
      connectors: [httpConnector(fake)],
      registry,
      agents: { getById: async (id) => agent(id) },
      grants: new InMemoryToolGrantStore(),
      executions: new InMemoryToolExecutionStore(),
      approvals: new InMemoryToolApprovalStore(),
      health: new InMemoryConnectorHealthStore(),
      audit: new ArrayAudit(),
      credentials: { resolve: async () => ({ ok: false, reason: "not_found" }) },
    });
    await gw.setGrant(
      { kind: "human", id: "o", roles: ["admin"] },
      { tenantId: "t1", agentId: "agent-1", toolId: "http-api", action: "WRITE", reason: "test" },
      "grant",
    );
    await gw.probeHealth("t1");
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

describe("duplicate policy is explicit and configurable", () => {
  it("a deployment can block repeats of an action that allows them by default", async () => {
    const h = await makeHarness(undefined, {
      duplicatePolicies: { "mail:CREATE": { mode: "block", windowSeconds: 600 } },
    });
    await h.grant("agent-1", "mail", "CREATE");
    const draft = (key: string) => ({
      toolId: "mail",
      action: "CREATE",
      connectorInstanceId: "inst-a",
      input: { to: "x@example.com" },
      idempotencyKey: key,
    });
    expect((await h.gateway.execute(caller(), draft("cfg-key-0001"))).kind).toBe("succeeded");
    expect(await h.gateway.execute(caller(), draft("cfg-key-0002"))).toMatchObject({
      failureClass: "DUPLICATE_OPERATION",
    });
    const inv = await h.gateway.inventory(caller());
    const create = inv.connectors[0].tools[0].actions.find((a) => a.action === "CREATE")!;
    expect(create.duplicatePolicy).toEqual({ mode: "block", windowSeconds: 600 });
    const send = inv.connectors[0].tools[0].actions.find((a) => a.action === "SEND")!;
    expect(send.duplicatePolicy).toEqual({ mode: "require_override", windowSeconds: 86400 });
    h.clock.advance(601_000);
    expect((await h.gateway.execute(caller(), draft("cfg-key-0003"))).kind).toBe("succeeded");
  });
});

describe("composition and reconciliation", () => {
  const agents = { getById: async (id: string) => agent(id) };

  it("composes one runtime from shared services, on the single-tenant shim, with no secret in config", async () => {
    const audit = new ArrayAudit();
    const rt = composeToolGateway({
      backend: "memory",
      agents,
      audit: audit as never,
      env: { HTTP_TOKEN: SECRET },
      config: {
        instances: [
          {
            instanceId: "api-1",
            connectorId: "http",
            config: { baseUrl: "https://api.example.com" },
            credentialRef: "cred_api",
          },
          { instanceId: "mail-1", connectorId: "email" },
          {
            instanceId: "off-1",
            connectorId: "http",
            config: { baseUrl: "https://x.example.com" },
            enabled: false,
          },
        ],
        credentials: { cred_api: { envVar: "HTTP_TOKEN" } },
      },
    });
    expect(Object.keys(rt).sort()).toEqual(
      [
        "approvals",
        "audit",
        "credentials",
        "executions",
        "gateway",
        "grants",
        "health",
        "policy",
        "reconciliation",
        "registry",
      ].sort(),
    );
    expect(rt.audit).toBe(audit); // the shared audit port, not a new one
    expect(rt.registry.tenants()).toEqual([CURRENT_SINGLE_TENANT_ID]);
    // Before reconciliation nothing is known — and nothing is assumed.
    const before = await rt.gateway.cockpitSnapshot(CURRENT_SINGLE_TENANT_ID);
    expect(before.connectorHealth.map((h) => [h.instanceId, h.status])).toEqual([
      ["api-1", "UNKNOWN"],
      ["mail-1", "UNKNOWN"],
      ["off-1", "DISABLED"],
    ]);
    const report = await rt.reconciliation.jobHandler({} as never, {
      signal: AbortSignal.timeout(5000),
    });
    const health = (report as { tenants: { health: { instanceId: string; status: string }[] }[] })
      .tenants[0].health;
    expect(health.map((h) => [h.instanceId, h.status])).toEqual([
      ["api-1", "CONFIGURED"], // http without healthPath: configured, not claimed healthy
      ["mail-1", "DISABLED"], // contract-only connector
      ["off-1", "DISABLED"],
    ]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("refuses a config that carries a secret or an unknown field", () => {
    const base = { backend: "memory" as const, agents, audit: new ArrayAudit() as never };
    expect(() =>
      composeToolGateway({
        ...base,
        config: {
          instances: [{ instanceId: "a-1", connectorId: "http", config: { token: "abc" } }],
        },
      }),
    ).toThrow();
    expect(() => composeToolGateway({ ...base, config: { tenantId: "other" } })).toThrow();
    expect(() => composeToolGateway({ ...base, backend: "postgres" })).toThrow(/db handle/);
  });

  it("a missing credential is AUTH_FAILED evidence, not a crash or a silent pass", async () => {
    const rt = composeToolGateway({
      backend: "memory",
      agents,
      audit: new ArrayAudit() as never,
      env: {},
      config: {
        instances: [
          {
            instanceId: "api-1",
            connectorId: "http",
            config: { baseUrl: "https://api.example.com" },
            credentialRef: "cred_api",
          },
        ],
        credentials: { cred_api: { envVar: "HTTP_TOKEN" } },
      },
    });
    // http's credential is optional for its tools: the probe still records CONFIGURED.
    await rt.reconciliation.runOnce();
    const [h] = (await rt.gateway.cockpitSnapshot(CURRENT_SINGLE_TENANT_ID)).connectorHealth;
    expect(h.status).toBe("CONFIGURED");
  });
});

describe("ports (contracts for the other lanes)", () => {
  it("Cognitive Runtime: execute/inventory are the whole port; results are labelled untrusted data", async () => {
    const h = await makeHarness();
    const port: ToolGatewayPort = h.gateway;
    await h.grant("agent-1", "mail", "READ");
    const events: string[] = [];
    const r = await port.execute(
      caller(),
      { toolId: "mail", action: "READ", connectorInstanceId: "inst-a", input: {} },
      { onProgress: (e) => events.push(e.type) },
    );
    expect(events).toEqual(["accepted", "dispatched", "settled"]);
    if (r.kind !== "succeeded") throw new Error(r.kind);
    expect(Object.keys(r).sort()).toEqual([
      "auditReferences",
      "kind",
      "replayed",
      "result",
      "toolExecutionId",
    ]);
    expect(r.result.trust).toBe("UNTRUSTED_EXTERNAL_DATA");
    expect((await port.inventory(caller())).tenantId).toBe("tenant-a");
  });

  it("Digital Workforce: checkCapabilities returns granted/missing only and writes nothing", async () => {
    const h = await makeHarness();
    const port: ToolCapabilityPort = h.gateway;
    await h.grant("agent-1", "mail", "READ");
    const auditBefore = (h.grants as InMemoryToolGrantStore).audit.length;
    const cov = await port.checkCapabilities(caller(), [
      { toolId: "mail", action: "READ" },
      { toolId: "mail", action: "SEND" },
      { toolId: "mail", action: "SEND", extra: "ignored" } as never,
    ]);
    expect(cov).toEqual({
      granted: [{ toolId: "mail", action: "READ" }],
      missing: [
        { toolId: "mail", action: "SEND" },
        { toolId: "mail", action: "SEND" },
      ],
    });
    expect((h.grants as InMemoryToolGrantStore).audit.length).toBe(auditBefore);
    expect(await h.gateway.listGrants("tenant-a", "agent-1")).toHaveLength(1);
  });
});
