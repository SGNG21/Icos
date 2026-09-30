import type { AuditEntry } from "@/core/contracts";
import {
  connectorHealthRecordSchema,
  connectorInstanceSchema,
  toolApprovalRequestSchema,
  toolExecutionSchema,
  toolGrantSchema,
  type ConnectorHealthRecord,
  type ConnectorInstance,
  type ToolApprovalRequest,
  type ToolExecution,
  type ToolGrant,
} from "@/core/tool-gateway/model";

import type {
  ConnectorHealthStore,
  ToolAuditPort,
  CredentialResolution,
  CredentialResolver,
  ExecutionQuery,
  GrantKey,
  ToolApprovalStore,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";
import { SecretValue } from "./ports";

/** Statuses that mean "this operation applied, may have applied, or is on its way to". */
export const LIVE_OPERATION = (e: ToolExecution): boolean =>
  e.status === "AWAITING_APPROVAL" ||
  e.status === "EXECUTING" ||
  e.status === "SUCCEEDED" ||
  (e.status === "FAILED" &&
    (e.settlementState === "UNKNOWN" || e.settlementState === "DISPATCHED"));

/** In-memory evidence store (dev/test). Same contract as the Postgres store. */
export class InMemoryToolExecutionStore implements ToolExecutionStore {
  /** Optional shared audit port: in memory mode, evidence still reaches the canonical audit. */
  constructor(private readonly sink?: ToolAuditPort) {}

  readonly rows = new Map<string, ToolExecution>();
  readonly audit: AuditEntry[] = [];
  private readonly k = (tenantId: string, key: string) => `${tenantId}\u0000${key}`;

  async claim(execution: ToolExecution, audit: AuditEntry) {
    const key = this.k(execution.tenantId, execution.idempotencyKey);
    const existing = this.rows.get(key);
    if (existing) return { created: false, execution: structuredClone(existing) };
    this.rows.set(key, toolExecutionSchema.parse(structuredClone(execution)));
    this.audit.push(audit);
    await this.sink?.append(audit);
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
    await this.sink?.append(audit);
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

  async findLiveByOperation(tenantId: string, operationFingerprint: string, since: Date) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          r.operationFingerprint === operationFingerprint &&
          new Date(r.createdAt) >= since &&
          LIVE_OPERATION(r),
      )
      .map((r) => structuredClone(r));
  }
}

export class InMemoryToolApprovalStore implements ToolApprovalStore {
  /** Optional shared audit port: in memory mode, evidence still reaches the canonical audit. */
  constructor(private readonly sink?: ToolAuditPort) {}

  readonly rows = new Map<string, ToolApprovalRequest>();
  readonly audit: AuditEntry[] = [];

  async create(request: ToolApprovalRequest, audit: AuditEntry) {
    this.rows.set(
      request.approvalRequestId,
      toolApprovalRequestSchema.parse(structuredClone(request)),
    );
    this.audit.push(audit);
    await this.sink?.append(audit);
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
    await this.sink?.append(audit);
    return structuredClone(next);
  }
  async consume(tenantId: string, id: string, at: string, audit: AuditEntry) {
    const cur = this.rows.get(id);
    if (!cur || cur.tenantId !== tenantId || cur.status !== "APPROVED" || cur.consumedAt) {
      return false;
    }
    this.rows.set(id, { ...cur, consumedAt: at });
    this.audit.push(audit);
    await this.sink?.append(audit);
    return true;
  }
  async listPending(tenantId: string) {
    return [...this.rows.values()]
      .filter((r) => r.tenantId === tenantId && r.status === "PENDING")
      .map((r) => structuredClone(r));
  }
}

const sameGrant = (a: GrantKey, b: GrantKey) =>
  a.tenantId === b.tenantId &&
  a.agentId === b.agentId &&
  a.toolId === b.toolId &&
  a.action === b.action;

export class InMemoryToolGrantStore implements ToolGrantStore {
  /** Optional shared audit port: in memory mode, evidence still reaches the canonical audit. */
  constructor(private readonly sink?: ToolAuditPort) {}

  readonly rows: ToolGrant[] = [];
  readonly audit: AuditEntry[] = [];

  async listForAgent(tenantId: string, agentId: string) {
    return this.rows
      .filter((g) => g.tenantId === tenantId && g.agentId === agentId)
      .map((g) => structuredClone(g));
  }
  async listForTenant(tenantId: string) {
    return this.rows.filter((g) => g.tenantId === tenantId).map((g) => structuredClone(g));
  }
  async put(grant: ToolGrant, audit: AuditEntry) {
    const g = toolGrantSchema.parse(grant);
    const i = this.rows.findIndex((r) => sameGrant(r, g));
    if (i >= 0) this.rows[i] = g;
    else this.rows.push(g);
    this.audit.push(audit);
    await this.sink?.append(audit);
  }
  async revoke(
    key: GrantKey,
    r: { revokedAt: string; revokedBy: string; revokeReason: string },
    audit: AuditEntry,
  ) {
    const i = this.rows.findIndex((g) => sameGrant(g, key) && g.revokedAt === undefined);
    if (i < 0) return false;
    this.rows[i] = toolGrantSchema.parse({ ...this.rows[i], ...r });
    this.audit.push(audit);
    await this.sink?.append(audit);
    return true;
  }
}

export class InMemoryConnectorHealthStore implements ConnectorHealthStore {
  readonly rows = new Map<string, ConnectorHealthRecord>();
  private readonly k = (t: string, i: string) => `${t}\u0000${i}`;
  async get(tenantId: string, instanceId: string) {
    const r = this.rows.get(this.k(tenantId, instanceId));
    return r ? structuredClone(r) : null;
  }
  async put(record: ConnectorHealthRecord) {
    const r = connectorHealthRecordSchema.parse(record);
    this.rows.set(this.k(r.tenantId, r.instanceId), r);
  }
  async list(tenantId: string) {
    return [...this.rows.values()].filter((r) => r.tenantId === tenantId);
  }
}

/**
 * Connector instances (configuration only) of every tenant. Lookups are
 * tenant-scoped: another tenant's instance is simply not found. Live health is
 * NOT kept here — it is dated evidence in the `ConnectorHealthStore`.
 *
 * ponytail: the local sliding-window quota is per process; the provider's own
 * 429 (persisted in health evidence) is the cross-process limit.
 */
export class ConnectorRegistry {
  private readonly instances = new Map<string, ConnectorInstance>();
  private readonly windows = new Map<string, number[]>();

  register(instance: ConnectorInstance): void {
    const i = connectorInstanceSchema.parse(instance);
    const existing = this.instances.get(i.instanceId);
    if (existing && existing.tenantId !== i.tenantId) {
      throw new Error(`connector instance ${i.instanceId} belongs to another tenant`);
    }
    this.instances.set(i.instanceId, structuredClone(i));
  }
  get(tenantId: string, instanceId: string): ConnectorInstance | null {
    const i = this.instances.get(instanceId);
    return i && i.tenantId === tenantId ? structuredClone(i) : null;
  }
  /** Audit-only: whether an id exists at all, so a foreign-instance attempt is recorded as such. */
  existsInAnotherTenant(tenantId: string, instanceId: string): boolean {
    const i = this.instances.get(instanceId);
    return i !== undefined && i.tenantId !== tenantId;
  }
  list(tenantId: string): ConnectorInstance[] {
    return [...this.instances.values()]
      .filter((i) => i.tenantId === tenantId)
      .map((i) => structuredClone(i));
  }
  tenants(): string[] {
    return [...new Set([...this.instances.values()].map((i) => i.tenantId))];
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
