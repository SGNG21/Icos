import { and, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";

import { auditEntrySchema, type AuditEntry } from "@/core/contracts";
import {
  connectorHealthRecordSchema,
  toolApprovalRequestSchema,
  toolExecutionSchema,
  toolGrantSchema,
  type ConnectorHealthRecord,
  type ToolApprovalRequest,
  type ToolExecution,
  type ToolGrant,
} from "@/core/tool-gateway/model";
import type { Database } from "@/server/database/client";
import { auditToRow } from "@/server/database/mappers";
import { auditEntries } from "@/server/database/schema";
import {
  toolApprovalRequests,
  toolConnectorHealth,
  toolExecutions,
  toolGrants,
} from "@/server/database/tool-gateway-schema";

import type {
  ConnectorHealthStore,
  ExecutionQuery,
  GrantKey,
  ToolApprovalStore,
  ToolExecutionStore,
  ToolGrantStore,
} from "./ports";

/**
 * PostgreSQL stores for the Tool Gateway. Every state change and its audit
 * entry commit in ONE transaction; every query carries `tenant_id`.
 */

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const d = (v: string | undefined) => (v === undefined ? null : new Date(v));
const iso = (v: Date | null) => (v === null ? undefined : v.toISOString());
const u = <T>(v: T | null) => (v === null ? undefined : v);

async function appendAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditEntries).values(auditToRow(auditEntrySchema.parse(entry)));
}

function execToRow(e: ToolExecution) {
  const v = toolExecutionSchema.parse(e);
  return {
    id: v.toolExecutionId,
    tenantId: v.tenantId,
    idempotencyKey: v.idempotencyKey,
    requestFingerprint: v.requestFingerprint,
    operationFingerprint: v.operationFingerprint,
    duplicateOf: v.duplicateOf ?? null,
    toolId: v.toolId,
    toolVersion: v.toolVersion,
    action: v.action,
    connectorInstanceId: v.connectorInstanceId,
    requesterAgentId: v.requesterAgentId,
    missionId: v.missionId ?? null,
    taskId: v.taskId ?? null,
    riskClass: v.riskClass,
    sideEffects: v.sideEffects,
    status: v.status,
    settlementState: v.settlementState,
    approvalRequestId: v.approvalRequestId ?? null,
    attemptCount: v.attemptCount,
    providerOperationId: v.providerOperationId ?? null,
    failureClass: v.failureClass ?? null,
    failureMessage: v.failureMessage ?? null,
    resultSummary: v.resultSummary ?? null,
    resultReference: v.resultReference ?? null,
    resultTrust: v.resultTrust ?? null,
    auditReferences: v.auditReferences,
    version: v.version,
    createdAt: new Date(v.createdAt),
    startedAt: d(v.startedAt),
    finishedAt: d(v.finishedAt),
    updatedAt: new Date(v.updatedAt),
  };
}

function rowToExec(r: typeof toolExecutions.$inferSelect): ToolExecution {
  return toolExecutionSchema.parse({
    toolExecutionId: r.id,
    tenantId: r.tenantId,
    idempotencyKey: r.idempotencyKey,
    requestFingerprint: r.requestFingerprint,
    operationFingerprint: r.operationFingerprint,
    duplicateOf: u(r.duplicateOf),
    toolId: r.toolId,
    toolVersion: r.toolVersion,
    action: r.action,
    connectorInstanceId: r.connectorInstanceId,
    requesterAgentId: r.requesterAgentId,
    missionId: u(r.missionId),
    taskId: u(r.taskId),
    riskClass: r.riskClass,
    sideEffects: r.sideEffects,
    status: r.status,
    settlementState: r.settlementState,
    approvalRequestId: u(r.approvalRequestId),
    attemptCount: r.attemptCount,
    providerOperationId: u(r.providerOperationId),
    failureClass: u(r.failureClass),
    failureMessage: u(r.failureMessage),
    resultSummary: u(r.resultSummary),
    resultReference: u(r.resultReference),
    resultTrust: u(r.resultTrust),
    auditReferences: r.auditReferences,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    updatedAt: r.updatedAt.toISOString(),
  });
}

export class PostgresToolExecutionStore implements ToolExecutionStore {
  constructor(private readonly db: Database) {}

  async claim(execution: ToolExecution, audit: AuditEntry) {
    return this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(toolExecutions)
        .values(execToRow(execution))
        .onConflictDoNothing({ target: [toolExecutions.tenantId, toolExecutions.idempotencyKey] })
        .returning();
      if (inserted.length === 1) {
        await appendAudit(tx, audit);
        return { created: true, execution: rowToExec(inserted[0]) };
      }
      const [existing] = await tx
        .select()
        .from(toolExecutions)
        .where(
          and(
            eq(toolExecutions.tenantId, execution.tenantId),
            eq(toolExecutions.idempotencyKey, execution.idempotencyKey),
          ),
        );
      return { created: false, execution: rowToExec(existing) };
    });
  }

  async update(next: ToolExecution, expectedVersion: number, audit: AuditEntry) {
    return this.db.transaction(async (tx) => {
      // Identity columns are never rewritten by an update.
      const {
        id,
        tenantId,
        idempotencyKey,
        createdAt,
        requestFingerprint,
        operationFingerprint,
        ...row
      } = execToRow(next);
      void idempotencyKey;
      void createdAt;
      void requestFingerprint;
      void operationFingerprint;
      const updated = await tx
        .update(toolExecutions)
        .set({ ...row, version: expectedVersion + 1 })
        .where(
          and(
            eq(toolExecutions.id, id),
            eq(toolExecutions.tenantId, tenantId),
            eq(toolExecutions.version, expectedVersion),
          ),
        )
        .returning();
      if (updated.length !== 1) return null;
      await appendAudit(tx, audit);
      return rowToExec(updated[0]);
    });
  }

  async getByKey(tenantId: string, idempotencyKey: string) {
    const [r] = await this.db
      .select()
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.tenantId, tenantId),
          eq(toolExecutions.idempotencyKey, idempotencyKey),
        ),
      );
    return r ? rowToExec(r) : null;
  }

  async list(tenantId: string, q: ExecutionQuery = {}) {
    const where: SQL[] = [eq(toolExecutions.tenantId, tenantId)];
    if (q.status) where.push(inArray(toolExecutions.status, [...q.status]));
    if (q.settlement) where.push(inArray(toolExecutions.settlementState, [...q.settlement]));
    const rows = await this.db
      .select()
      .from(toolExecutions)
      .where(and(...where))
      .orderBy(desc(toolExecutions.updatedAt), desc(toolExecutions.id))
      .limit(Math.min(q.limit ?? 100, 500));
    return rows.map(rowToExec);
  }

  async findLiveByOperation(tenantId: string, operationFingerprint: string, since: Date) {
    const rows = await this.db
      .select()
      .from(toolExecutions)
      .where(
        and(
          eq(toolExecutions.tenantId, tenantId),
          eq(toolExecutions.operationFingerprint, operationFingerprint),
          gte(toolExecutions.createdAt, since),
          or(
            inArray(toolExecutions.status, ["AWAITING_APPROVAL", "EXECUTING", "SUCCEEDED"]),
            and(
              eq(toolExecutions.status, "FAILED"),
              inArray(toolExecutions.settlementState, ["UNKNOWN", "DISPATCHED"]),
            ),
          ),
        ),
      )
      .orderBy(desc(toolExecutions.createdAt))
      .limit(50);
    return rows.map(rowToExec);
  }
}

function approvalToRow(a: ToolApprovalRequest) {
  const v = toolApprovalRequestSchema.parse(a);
  return {
    id: v.approvalRequestId,
    tenantId: v.tenantId,
    toolExecutionId: v.toolExecutionId,
    requestFingerprint: v.requestFingerprint,
    requesterAgentId: v.requesterAgentId,
    toolId: v.toolId,
    action: v.action,
    riskClass: v.riskClass,
    inputPreview: v.inputPreview,
    status: v.status,
    decidedByKind: v.decidedBy?.kind ?? null,
    decidedById: v.decidedBy?.id ?? null,
    reason: v.reason ?? null,
    duplicateOf: v.duplicateOf ?? null,
    consumedAt: d(v.consumedAt),
    requestedAt: new Date(v.requestedAt),
    decidedAt: d(v.decidedAt),
    expiresAt: new Date(v.expiresAt),
  };
}

function rowToApproval(r: typeof toolApprovalRequests.$inferSelect): ToolApprovalRequest {
  return toolApprovalRequestSchema.parse({
    approvalRequestId: r.id,
    tenantId: r.tenantId,
    toolExecutionId: r.toolExecutionId,
    requestFingerprint: r.requestFingerprint,
    requesterAgentId: r.requesterAgentId,
    toolId: r.toolId,
    action: r.action,
    riskClass: r.riskClass,
    inputPreview: r.inputPreview,
    status: r.status,
    decidedBy: r.decidedById ? { kind: r.decidedByKind, id: r.decidedById } : undefined,
    reason: u(r.reason),
    duplicateOf: u(r.duplicateOf),
    consumedAt: iso(r.consumedAt),
    requestedAt: r.requestedAt.toISOString(),
    decidedAt: iso(r.decidedAt),
    expiresAt: r.expiresAt.toISOString(),
  });
}

export class PostgresToolApprovalStore implements ToolApprovalStore {
  constructor(private readonly db: Database) {}

  async create(request: ToolApprovalRequest, audit: AuditEntry) {
    await this.db.transaction(async (tx) => {
      await tx.insert(toolApprovalRequests).values(approvalToRow(request));
      await appendAudit(tx, audit);
    });
  }

  async get(tenantId: string, id: string) {
    const [r] = await this.db
      .select()
      .from(toolApprovalRequests)
      .where(and(eq(toolApprovalRequests.tenantId, tenantId), eq(toolApprovalRequests.id, id)));
    return r ? rowToApproval(r) : null;
  }

  async decide(next: ToolApprovalRequest, audit: AuditEntry) {
    return this.db.transaction(async (tx) => {
      const row = approvalToRow(next);
      const updated = await tx
        .update(toolApprovalRequests)
        .set({
          status: row.status,
          decidedByKind: row.decidedByKind,
          decidedById: row.decidedById,
          reason: row.reason,
          decidedAt: row.decidedAt,
          expiresAt: row.expiresAt,
        })
        .where(
          and(
            eq(toolApprovalRequests.id, row.id),
            eq(toolApprovalRequests.tenantId, row.tenantId),
            eq(toolApprovalRequests.status, "PENDING"),
          ),
        )
        .returning();
      if (updated.length !== 1) return null;
      await appendAudit(tx, audit);
      return rowToApproval(updated[0]);
    });
  }

  async consume(tenantId: string, id: string, at: string, audit: AuditEntry) {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(toolApprovalRequests)
        .set({ consumedAt: new Date(at) })
        .where(
          and(
            eq(toolApprovalRequests.id, id),
            eq(toolApprovalRequests.tenantId, tenantId),
            eq(toolApprovalRequests.status, "APPROVED"),
            isNull(toolApprovalRequests.consumedAt),
          ),
        )
        .returning({ id: toolApprovalRequests.id });
      if (updated.length !== 1) return false;
      await appendAudit(tx, audit);
      return true;
    });
  }

  async listPending(tenantId: string) {
    const rows = await this.db
      .select()
      .from(toolApprovalRequests)
      .where(
        and(
          eq(toolApprovalRequests.tenantId, tenantId),
          eq(toolApprovalRequests.status, "PENDING"),
        ),
      )
      .orderBy(desc(toolApprovalRequests.requestedAt))
      .limit(500);
    return rows.map(rowToApproval);
  }
}

const grantWhere = (g: GrantKey) =>
  and(
    eq(toolGrants.tenantId, g.tenantId),
    eq(toolGrants.agentId, g.agentId),
    eq(toolGrants.toolId, g.toolId),
    eq(toolGrants.action, g.action),
  );

function rowToGrant(r: typeof toolGrants.$inferSelect): ToolGrant {
  return toolGrantSchema.parse({
    tenantId: r.tenantId,
    agentId: r.agentId,
    toolId: r.toolId,
    action: r.action,
    grantedBy: r.grantedBy,
    grantedAt: r.grantedAt.toISOString(),
    expiresAt: iso(r.expiresAt),
    reason: r.reason,
    revokedAt: iso(r.revokedAt),
    revokedBy: u(r.revokedBy),
    revokeReason: u(r.revokeReason),
  });
}

export class PostgresToolGrantStore implements ToolGrantStore {
  constructor(private readonly db: Database) {}

  async listForAgent(tenantId: string, agentId: string): Promise<ToolGrant[]> {
    const rows = await this.db
      .select()
      .from(toolGrants)
      .where(and(eq(toolGrants.tenantId, tenantId), eq(toolGrants.agentId, agentId)));
    return rows.map(rowToGrant);
  }

  async listForTenant(tenantId: string): Promise<ToolGrant[]> {
    const rows = await this.db.select().from(toolGrants).where(eq(toolGrants.tenantId, tenantId));
    return rows.map(rowToGrant);
  }

  async put(grant: ToolGrant, audit: AuditEntry) {
    const g = toolGrantSchema.parse(grant);
    const row = {
      tenantId: g.tenantId,
      agentId: g.agentId,
      toolId: g.toolId,
      action: g.action,
      grantedBy: g.grantedBy,
      grantedAt: new Date(g.grantedAt),
      expiresAt: d(g.expiresAt),
      reason: g.reason,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
    };
    await this.db.transaction(async (tx) => {
      await tx
        .insert(toolGrants)
        .values(row)
        .onConflictDoUpdate({
          target: [toolGrants.tenantId, toolGrants.agentId, toolGrants.toolId, toolGrants.action],
          set: {
            grantedBy: row.grantedBy,
            grantedAt: row.grantedAt,
            expiresAt: row.expiresAt,
            reason: row.reason,
            revokedAt: null,
            revokedBy: null,
            revokeReason: null,
          },
        });
      await appendAudit(tx, audit);
    });
  }

  async revoke(
    key: GrantKey,
    r: { revokedAt: string; revokedBy: string; revokeReason: string },
    audit: AuditEntry,
  ) {
    return this.db.transaction(async (tx) => {
      const updated = await tx
        .update(toolGrants)
        .set({
          revokedAt: new Date(r.revokedAt),
          revokedBy: r.revokedBy,
          revokeReason: r.revokeReason,
        })
        .where(and(grantWhere(key), isNull(toolGrants.revokedAt)))
        .returning({ agentId: toolGrants.agentId });
      if (updated.length === 0) return false;
      await appendAudit(tx, audit);
      return true;
    });
  }
}

export class PostgresConnectorHealthStore implements ConnectorHealthStore {
  constructor(private readonly db: Database) {}

  private static toRecord(r: typeof toolConnectorHealth.$inferSelect): ConnectorHealthRecord {
    return connectorHealthRecordSchema.parse({
      tenantId: r.tenantId,
      instanceId: r.instanceId,
      status: r.status,
      checkedAt: r.checkedAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      rateLimitedUntil: iso(r.rateLimitedUntil),
      detail: u(r.detail),
    });
  }

  async get(tenantId: string, instanceId: string) {
    const [r] = await this.db
      .select()
      .from(toolConnectorHealth)
      .where(
        and(
          eq(toolConnectorHealth.tenantId, tenantId),
          eq(toolConnectorHealth.instanceId, instanceId),
        ),
      );
    return r ? PostgresConnectorHealthStore.toRecord(r) : null;
  }

  async put(record: ConnectorHealthRecord) {
    const v = connectorHealthRecordSchema.parse(record);
    const row = {
      tenantId: v.tenantId,
      instanceId: v.instanceId,
      status: v.status,
      checkedAt: new Date(v.checkedAt),
      expiresAt: new Date(v.expiresAt),
      rateLimitedUntil: d(v.rateLimitedUntil),
      detail: v.detail ?? null,
    };
    await this.db
      .insert(toolConnectorHealth)
      .values(row)
      .onConflictDoUpdate({
        target: [toolConnectorHealth.tenantId, toolConnectorHealth.instanceId],
        set: {
          status: row.status,
          checkedAt: row.checkedAt,
          expiresAt: row.expiresAt,
          rateLimitedUntil: row.rateLimitedUntil,
          detail: row.detail,
        },
      });
  }

  async list(tenantId: string) {
    const rows = await this.db
      .select()
      .from(toolConnectorHealth)
      .where(eq(toolConnectorHealth.tenantId, tenantId));
    return rows.map((r) => PostgresConnectorHealthStore.toRecord(r));
  }
}
