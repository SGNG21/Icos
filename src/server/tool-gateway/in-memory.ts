import type { AuditEntry } from "@/core/contracts";
import {
  toolApprovalRequestSchema,
  toolExecutionSchema,
  toolGrantSchema,
  type ConnectorInstance,
  type ConnectorStatus,
  type ToolApprovalRequest,
  type ToolExecution,
  type ToolGrant,
} from "@/core/tool-gateway/model";

import type {
  CredentialResolution,
  CredentialResolver,
  ExecutionQuery,
  ToolApprovalStore,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";
import { SecretValue } from "./ports";

/** In-memory evidence store (dev/test). Same contract as the Postgres store. */
export class InMemoryToolExecutionStore implements ToolExecutionStore {
  readonly rows = new Map<string, ToolExecution>();
  readonly audit: AuditEntry[] = [];
  private readonly k = (tenantId: string, key: string) => `${tenantId}\u0000${key}`;

  async claim(execution: ToolExecution, audit: AuditEntry) {
    const key = this.k(execution.tenantId, execution.idempotencyKey);
    const existing = this.rows.get(key);
    if (existing) return { created: false, execution: structuredClone(existing) };
    this.rows.set(key, toolExecutionSchema.parse(structuredClone(execution)));
    this.audit.push(audit);
    return { created: true, execution: structuredClone(execution) };
  }

  async update(next: ToolExecution, expectedVersion: number, audit: AuditEntry) {
    const key = this.k(next.tenantId, next.idempotencyKey);
    const current = this.rows.get(key);
    if (!current || current.version !== expectedVersion) return null;
    const stored = toolExecutionSchema.parse({
      ...structuredClone(next),
      version: expectedVersion + 1,
    });
    this.rows.set(key, stored);
    this.audit.push(audit);
    return structuredClone(stored);
  }

  async getByKey(tenantId: string, idempotencyKey: string) {
    const row = this.rows.get(this.k(tenantId, idempotencyKey));
    return row ? structuredClone(row) : null;
  }

  async list(tenantId: string, q: ExecutionQuery = {}) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          (!q.status || q.status.includes(r.status)) &&
          (!q.settlement || q.settlement.includes(r.settlementState)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, q.limit ?? 100)
      .map((r) => structuredClone(r));
  }
}

export class InMemoryToolApprovalStore implements ToolApprovalStore {
  readonly rows = new Map<string, ToolApprovalRequest>();
  readonly audit: AuditEntry[] = [];

  async create(request: ToolApprovalRequest, audit: AuditEntry) {
    this.rows.set(
      request.approvalRequestId,
      toolApprovalRequestSchema.parse(structuredClone(request)),
    );
    this.audit.push(audit);
  }
  async get(tenantId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.tenantId === tenantId ? structuredClone(r) : null;
  }
  async decide(next: ToolApprovalRequest, audit: AuditEntry) {
    const cur = this.rows.get(next.approvalRequestId);
    if (!cur || cur.tenantId !== next.tenantId || cur.status !== "PENDING") return null;
    this.rows.set(next.approvalRequestId, toolApprovalRequestSchema.parse(structuredClone(next)));
    this.audit.push(audit);
    return structuredClone(next);
  }
  async listPending(tenantId: string) {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId && r.status === "PENDING");
  }
}

export class InMemoryToolGrantStore implements ToolGrantStore {
  readonly rows: ToolGrant[] = [];
  readonly audit: AuditEntry[] = [];
  private same = (a: Pick<ToolGrant, "tenantId" | "agentId" | "toolId" | "action">, b: typeof a) =>
    a.tenantId === b.tenantId &&
    a.agentId === b.agentId &&
    a.toolId === b.toolId &&
    a.action === b.action;

  async listForAgent(tenantId: string, agentId: string) {
    return this.rows.filter((g) => g.tenantId === tenantId && g.agentId === agentId);
  }
  async put(grant: ToolGrant, audit: AuditEntry) {
    const g = toolGrantSchema.parse(grant);
    const i = this.rows.findIndex((r) => this.same(r, g));
    if (i >= 0) this.rows[i] = g;
    else this.rows.push(g);
    this.audit.push(audit);
  }
  async revoke(
    grant: Pick<ToolGrant, "tenantId" | "agentId" | "toolId" | "action">,
    audit: AuditEntry,
  ) {
    const i = this.rows.findIndex((r) => this.same(r, grant));
    if (i < 0) return false;
    this.rows.splice(i, 1);
    this.audit.push(audit);
    return true;
  }
}

/**
 * Connector instances of every tenant, with live health and rate-limit state.
 * Lookups are tenant-scoped: another tenant's instance is simply not found.
 *
 * ponytail: per-process state (health, rate-limit windows); move to a shared
 * store when the gateway runs on more than one process.
 */
export class ConnectorRegistry {
  private readonly instances = new Map<string, ConnectorInstance>();
  private readonly rateLimitedUntil = new Map<string, number>();
  private readonly windows = new Map<string, number[]>();

  register(instance: ConnectorInstance): void {
    const existing = this.instances.get(instance.instanceId);
    if (existing && existing.tenantId !== instance.tenantId) {
      throw new Error(`connector instance ${instance.instanceId} belongs to another tenant`);
    }
    this.instances.set(instance.instanceId, structuredClone(instance));
  }
  get(tenantId: string, instanceId: string): ConnectorInstance | null {
    const i = this.instances.get(instanceId);
    return i && i.tenantId === tenantId ? structuredClone(i) : null;
  }
  list(tenantId: string): ConnectorInstance[] {
    return [...this.instances.values()]
      .filter((i) => i.tenantId === tenantId)
      .map((i) => structuredClone(i));
  }
  setStatus(instanceId: string, status: ConnectorStatus): void {
    const i = this.instances.get(instanceId);
    if (i) i.status = status;
  }
  /** Provider said 429: block the instance until `now + seconds`. */
  markRateLimited(instanceId: string, now: Date, seconds: number): void {
    this.rateLimitedUntil.set(instanceId, now.getTime() + seconds * 1000);
    this.setStatus(instanceId, "RATE_LIMITED");
  }
  rateLimitedUntilOf(instanceId: string, now: Date): Date | undefined {
    const until = this.rateLimitedUntil.get(instanceId);
    if (until === undefined) return undefined;
    if (until > now.getTime()) return new Date(until);
    this.rateLimitedUntil.delete(instanceId);
    if (this.instances.get(instanceId)?.status === "RATE_LIMITED")
      this.setStatus(instanceId, "HEALTHY");
    return undefined;
  }
  /** Sliding-window local quota. False = over quota, nothing dispatched. */
  take(
    key: string,
    limit: { maxRequests: number; perSeconds: number } | undefined,
    now: Date,
  ): boolean {
    if (!limit) return true;
    const since = now.getTime() - limit.perSeconds * 1000;
    const hits = (this.windows.get(key) ?? []).filter((t) => t > since);
    if (hits.length >= limit.maxRequests) {
      this.windows.set(key, hits);
      return false;
    }
    hits.push(now.getTime());
    this.windows.set(key, hits);
    return true;
  }
}

/**
 * Resolves `cred_*` references to values held in the process environment. The
 * repository and the model only ever see the reference and the variable NAME.
 */
export class EnvCredentialResolver implements CredentialResolver {
  constructor(
    private readonly bindings: ReadonlyMap<
      string,
      { tenantId: string; envVar: string; expiresAt?: string }
    >,
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async resolve(
    ref: { ref: string; tenantId: string },
    tenantId: string,
  ): Promise<CredentialResolution> {
    const b = this.bindings.get(ref.ref);
    if (!b) return { ok: false, reason: "not_found" };
    if (b.tenantId !== tenantId || ref.tenantId !== tenantId)
      return { ok: false, reason: "tenant_mismatch" };
    if (b.expiresAt && new Date(b.expiresAt) <= this.now()) return { ok: false, reason: "expired" };
    const value = this.env[b.envVar];
    return value
      ? { ok: true, secret: new SecretValue(value) }
      : { ok: false, reason: "not_found" };
  }
}
