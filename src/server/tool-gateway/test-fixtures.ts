import { inspect } from "node:util";

import type { Agent, JsonValue } from "@/core/contracts";
import {
  connectorDefinitionSchema,
  type ConnectorInstance,
  type ToolGrant,
} from "@/core/tool-gateway/model";

import { act } from "./connectors/catalog";
import { ToolGateway } from "./gateway";
import {
  ConnectorRegistry,
  EnvCredentialResolver,
  InMemoryToolApprovalStore,
  InMemoryToolExecutionStore,
  InMemoryToolGrantStore,
} from "./in-memory";
import type {
  Connector,
  ConnectorOutcome,
  ReconcileOutcome,
  ToolApprovalStore,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";

/** Shared by the unit and Postgres proof suites. Not a test file. */

export const SECRET = "sk-live-TEST-9f8e7d6c5b4a39281706f5e4d3c2b1a0";
export const TENANT_A = "tenant-a";
export const TENANT_B = "tenant-b";

export const FAKE_DEFINITION = connectorDefinitionSchema.parse({
  connectorId: "fake",
  category: "EMAIL",
  availability: "CONNECTED",
  supportsCancel: false,
  supportsReconcile: true,
  tools: [
    {
      toolId: "mail",
      version: "1.0.0",
      category: "EMAIL",
      description: "fake mailbox",
      capabilities: ["mail"],
      actions: [
        act("READ", "LOW", "none", "read"),
        act("CREATE", "LOW", "external", "draft", { reconcilable: true }),
        act("SEND", "HIGH", "external", "send", {
          reconcilable: true,
          approval: { ttlSeconds: 600 },
        }),
      ],
      credential: { kind: "api_key", required: true },
      rateLimit: { maxRequests: 50, perSeconds: 60 },
      timeoutMs: 1_000,
      auditPolicy: { persistResult: "summary" },
    },
    {
      toolId: "vfs",
      version: "1.0.0",
      category: "FILES",
      description: "fake files",
      capabilities: ["vfs"],
      actions: [
        act("READ", "LOW", "none", "read"),
        act("WRITE", "MEDIUM", "internal", "write", {
          approval: { mode: "human_or_agent", selfApprovalAllowed: true },
        }),
        act("DELETE", "HIGH", "internal", "delete"),
      ],
      timeoutMs: 1_000,
      auditPolicy: { persistResult: "summary" },
    },
    {
      toolId: "repo",
      version: "1.0.0",
      category: "GITHUB",
      description: "fake repo",
      capabilities: ["repo"],
      actions: [act("READ", "LOW", "none", "read"), act("MERGE", "HIGH", "external", "merge")],
      timeoutMs: 1_000,
      auditPolicy: { persistResult: "summary" },
    },
  ],
});

export type FakeMode =
  "ok" | "auth" | "ratelimit" | "hang" | "applied_then_crash" | "throw" | "echo_secret";

/** Counts real side effects per idempotency key: the ground truth for "no duplicate". */
export class FakeConnector implements Connector {
  readonly definition = FAKE_DEFINITION;
  mode: FakeMode = "ok";
  healthStatus: Awaited<ReturnType<Connector["health"]>> = "HEALTHY";
  effects = new Map<string, number>();
  seenCredential: string | undefined;

  effectCount(): number {
    return [...this.effects.values()].reduce((a, b) => a + b, 0);
  }

  async health() {
    return this.healthStatus;
  }

  async execute(
    toolId: string,
    action: string,
    input: Record<string, JsonValue>,
    ctx: Parameters<Connector["execute"]>[3],
  ): Promise<ConnectorOutcome> {
    this.seenCredential = ctx.credential?.reveal();
    await Promise.resolve();
    switch (this.mode) {
      case "auth":
        return {
          ok: false,
          failureClass: "AUTH_FAILURE",
          settlement: "NOT_APPLIED",
          message: "401",
        };
      case "ratelimit":
        return {
          ok: false,
          failureClass: "RATE_LIMIT",
          settlement: "NOT_APPLIED",
          message: "429",
          retryAfterSeconds: 30,
        };
      case "hang":
        return new Promise(() => {});
      case "throw":
        throw new Error(`boom ${SECRET}`);
      default:
        break;
    }
    if (action !== "READ")
      this.effects.set(ctx.idempotencyKey, (this.effects.get(ctx.idempotencyKey) ?? 0) + 1);
    if (this.mode === "applied_then_crash") throw new TypeError("socket hang up");
    const output: Record<string, JsonValue> = { toolId, action, echo: input };
    if (this.mode === "echo_secret") output.leak = `token=${ctx.credential?.reveal()}`;
    return {
      ok: true,
      output,
      summary: { ok: true },
      providerOperationId: `op-${ctx.idempotencyKey}`,
    };
  }

  async reconcile(
    _t: string,
    _a: string,
    ref: { idempotencyKey: string },
  ): Promise<ReconcileOutcome> {
    return this.effects.has(ref.idempotencyKey)
      ? { settlement: "APPLIED" as const, providerOperationId: `op-${ref.idempotencyKey}` }
      : { settlement: "NOT_APPLIED" as const };
  }
}

export const agent = (id: string, level: Agent["authorizationLevel"] = 2): Agent => ({
  id,
  name: id,
  role: "worker",
  status: "available",
  authorizationLevel: level,
  description: "test agent",
});

export const instance = (
  tenantId: string,
  instanceId: string,
  credRef?: string,
): ConnectorInstance => ({
  instanceId,
  connectorId: "fake",
  tenantId,
  credential: credRef ? { ref: credRef, tenantId, kind: "api_key" } : undefined,
  config: {},
  status: "HEALTHY",
});

export class Clock {
  constructor(public t = new Date("2026-09-29T10:00:00.000Z")) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

export interface Harness {
  gateway: ToolGateway;
  connector: FakeConnector;
  registry: ConnectorRegistry;
  executions: ToolExecutionStore;
  approvals: ToolApprovalStore;
  grants: ToolGrantStore;
  clock: Clock;
  grant(
    agentId: string,
    toolId: string,
    action: ToolGrant["action"],
    tenantId?: string,
  ): Promise<void>;
  rebuild(): ToolGateway;
}

export function makeHarness(stores?: {
  executions: ToolExecutionStore;
  approvals: ToolApprovalStore;
  grants: ToolGrantStore;
}): Harness {
  const clock = new Clock();
  const connector = new FakeConnector();
  const registry = new ConnectorRegistry();
  registry.register(instance(TENANT_A, "inst-a", "cred_a"));
  registry.register(instance(TENANT_B, "inst-b", "cred_b"));
  const s = stores ?? {
    executions: new InMemoryToolExecutionStore(),
    approvals: new InMemoryToolApprovalStore(),
    grants: new InMemoryToolGrantStore(),
  };
  const agents = new Map([
    ["agent-1", agent("agent-1")],
    ["agent-2", agent("agent-2")],
    ["agent-low", agent("agent-low", 0)],
  ]);
  const credentials = new EnvCredentialResolver(
    new Map([
      ["cred_a", { tenantId: TENANT_A, envVar: "FAKE_TOOL_SECRET" }],
      ["cred_b", { tenantId: TENANT_B, envVar: "FAKE_TOOL_SECRET" }],
    ]),
    { FAKE_TOOL_SECRET: SECRET },
    clock.now,
  );
  let n = 0;
  const build = () =>
    new ToolGateway({
      connectors: [connector],
      registry,
      agents: { getById: async (id) => agents.get(id) ?? null },
      credentials,
      now: clock.now,
      newId: (p) => `${p}-${++n}`,
      orphanGraceMs: 1_000,
      ...s,
    });
  const h: Harness = {
    gateway: build(),
    connector,
    registry,
    clock,
    ...s,
    grant: async (agentId, toolId, action, tenantId = TENANT_A) => {
      const r = await h.gateway.setGrant(
        { kind: "human", id: "owner-1", roles: ["admin"] },
        { tenantId, agentId, toolId, action },
        "grant",
      );
      if (!r.ok) throw new Error(r.message);
    },
    rebuild: () => (h.gateway = build()),
  };
  return h;
}

/** Everything a model or log could ever observe, flattened. */
export const observable = (...values: unknown[]) =>
  values.map((v) => `${JSON.stringify(v)}\n${inspect(v, { depth: 20 })}`).join("\n");

export const caller = (agentId = "agent-1", tenantId = TENANT_A) => ({ tenantId, agentId });
export const human = (
  id = "human-1",
  roles: ("operator" | "viewer" | "admin")[] = ["operator"],
) => ({ kind: "human" as const, id, roles });
