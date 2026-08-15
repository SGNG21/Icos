import { randomUUID } from "node:crypto";

import { eq, and, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { ExecutionGrant, ExecutionRecord, IdempotencyState } from "@/core/contracts/tool";
import { IDEMPOTENCY_TERMINAL, isIdempotencyTransitionAllowed } from "@/core/contracts/tool";
import type { ExecutionGrantRepository, ExecutionRecordRepository } from "@/server/repositories/tool-ports";
import { executionGrants, executionRecords } from "@/server/database/schema";

// ─────────────────────────────────────
// Postgres Grant Repository
// ─────────────────────────────────────

export class PostgresGrantRepository implements ExecutionGrantRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async create(grant: ExecutionGrant): Promise<ExecutionGrant> {
    const row = mapGrantToRow(grant);
    await this.db.insert(executionGrants).values(row);
    return grant;
  }

  async findById(id: string): Promise<ExecutionGrant | null> {
    const rows = await this.db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.id, id))
      .limit(1);
    return rows.length > 0 ? mapRowToGrant(rows[0]) : null;
  }

  async consume(id: string): Promise<boolean> {
    const now = new Date();
    const result = await this.db
      .update(executionGrants)
      .set({
        status: "consumed",
        updatedAt: now.toISOString(),
      })
      .where(
        and(
          eq(executionGrants.id, id),
          eq(executionGrants.status, "issued"),
          sql`${executionGrants.expiresAt} > ${now.toISOString()}`,
        ),
      )
      .returning({ id: executionGrants.id });

    return result.length > 0;
  }

  async expireStale(now: string): Promise<number> {
    const result = await this.db
      .update(executionGrants)
      .set({
        status: "expired",
        updatedAt: now,
      })
      .where(
        and(
          eq(executionGrants.status, "issued"),
          sql`${executionGrants.expiresAt} < ${now}`,
        ),
      )
      .returning({ id: executionGrants.id });

    return result.length;
  }
}

// ─────────────────────────────────────
// Postgres Execution Record Repository
// ─────────────────────────────────────

export class PostgresExecutionRecordRepository implements ExecutionRecordRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async reserve(input: {
    idempotencyKey: string;
    grantId: string;
    tenantId: string;
    missionId: string;
    runId: string;
    toolId: string;
    requestHash: string;
    input: unknown;
  }): Promise<{
    reserved: boolean;
    record: ExecutionRecord;
    conflict?: "idempotency_conflict";
  }> {
    // Tentative d'insertion atomique
    const now = new Date().toISOString();
    const id = `exec-rec-${randomUUID().slice(0, 8)}`;

    try {
      await this.db.insert(executionRecords).values({
        id,
        idempotencyKey: input.idempotencyKey,
        grantId: input.grantId,
        tenantId: input.tenantId,
        missionId: input.missionId,
        runId: input.runId,
        toolId: input.toolId,
        requestHash: input.requestHash,
        state: "RESERVED",
        input: input.input,
        attempts: [],
        createdAt: now,
      });

      return {
        reserved: true,
        record: {
          id,
          idempotencyKey: input.idempotencyKey,
          grantId: input.grantId,
          tenantId: input.tenantId,
          missionId: input.missionId,
          runId: input.runId,
          toolId: input.toolId as ExecutionRecord["toolId"],
          requestHash: input.requestHash,
          state: "RESERVED",
          attempts: [],
          createdAt: now,
        },
      };
    } catch {
      // CONFLICT — idempotencyKey existe déjà
      const existing = await this.findByIdempotencyKey(input.idempotencyKey);
      if (!existing) {
        // Race condition : l'insert a échoué mais on ne trouve pas l'existant
        return {
          reserved: false,
          record: {
            id,
            idempotencyKey: input.idempotencyKey,
            grantId: input.grantId,
            tenantId: input.tenantId,
            missionId: input.missionId,
            runId: input.runId,
            toolId: input.toolId as ExecutionRecord["toolId"],
            requestHash: input.requestHash,
            state: "UNKNOWN",
            attempts: [],
            createdAt: now,
          },
          conflict: "idempotency_conflict",
        };
      }

      if (existing.requestHash !== input.requestHash) {
        return { reserved: false, record: existing, conflict: "idempotency_conflict" };
      }

      return { reserved: false, record: existing };
    }
  }

  async transitionState(
    idempotencyKey: string,
    expectedState: IdempotencyState,
    targetState: IdempotencyState,
    attempt?: { attemptNumber: number; startedAt: string; status: "executing" },
    error?: { code: string; message: string },
  ): Promise<{ ok: boolean; record?: ExecutionRecord }> {
    if (!isIdempotencyTransitionAllowed(expectedState, targetState)) {
      return { ok: false };
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      state: targetState,
      updatedAt: now,
    };

    if (IDEMPOTENCY_TERMINAL.includes(targetState)) {
      updates.completedAt = now;
    }

    if (error) {
      updates.error = error;
    }

    if (attempt) {
      // Append attempt via SQL
      updates.attempts = sql`${executionRecords.attempts} || ${JSON.stringify([attempt])}::jsonb`;
    }

    const result = await this.db
      .update(executionRecords)
      .set(updates)
      .where(
        and(
          eq(executionRecords.idempotencyKey, idempotencyKey),
          eq(executionRecords.state, expectedState),
        ),
      )
      .returning();

    if (result.length === 0) return { ok: false };

    return { ok: true, record: mapRowToRecord(result[0]) };
  }

  async complete(input: {
    idempotencyKey: string;
    targetState: "COMPLETED" | "FAILED_SAFE" | "UNKNOWN";
    attempt: {
      attemptNumber: number;
      startedAt: string;
      completedAt: string;
      status: "succeeded" | "failed";
      result?: unknown;
      error?: { code: string; message: string };
    };
    output?: unknown;
    error?: { code: string; message: string };
    durationMs: number;
  }): Promise<{ ok: boolean; record?: ExecutionRecord }> {
    const now = new Date().toISOString();

    const result = await this.db
      .update(executionRecords)
      .set({
        state: input.targetState,
        completedAt: now,
        updatedAt: now,
        output: input.output ?? null,
        error: input.error ?? null,
        attempts: sql`${executionRecords.attempts} || ${JSON.stringify([input.attempt])}::jsonb`,
      })
      .where(
        and(
          eq(executionRecords.idempotencyKey, input.idempotencyKey),
          sql`${executionRecords.state} IN ('RESERVED', 'EXECUTING')`,
        ),
      )
      .returning();

    if (result.length === 0) return { ok: false };
    return { ok: true, record: mapRowToRecord(result[0]) };
  }

  async findByIdempotencyKey(key: string): Promise<ExecutionRecord | null> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.idempotencyKey, key))
      .limit(1);
    return rows.length > 0 ? mapRowToRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.id, id))
      .limit(1);
    return rows.length > 0 ? mapRowToRecord(rows[0]) : null;
  }

  async findStale(before: string): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(
        and(
          sql`${executionRecords.state} IN ('RESERVED', 'EXECUTING')`,
          sql`${executionRecords.createdAt} < ${before}`,
        ),
      );
    return rows.map(mapRowToRecord);
  }
}

// ─────────────────────────────────────
// Mappers
// ─────────────────────────────────────

function mapGrantToRow(grant: ExecutionGrant) {
  return {
    id: grant.id,
    tenantId: grant.tenantId,
    principalId: grant.principalId,
    missionId: grant.missionId,
    runId: grant.runId,
    toolId: grant.toolId,
    toolDefinitionHash: grant.toolDefinitionHash,
    toolVersion: grant.toolVersion,
    capability: grant.capability,
    operation: grant.operation,
    resource: grant.resource,
    requestHash: grant.requestHash,
    idempotencyKey: grant.idempotencyKey,
    status: grant.status,
    policyProvenance: grant.policyProvenance,
    credentialRequirements: grant.credentialRequirements,
    networkRequired: grant.networkRequired,
    isolationLevel: grant.isolationLevel,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
  };
}

function mapRowToGrant(row: Record<string, unknown>): ExecutionGrant {
  return {
    id: row.id as string,
    tenantId: row.tenantId as string,
    principalId: row.principalId as string,
    missionId: row.missionId as string,
    runId: row.runId as string,
    toolId: row.toolId as ExecutionGrant["toolId"],
    toolDefinitionHash: row.toolDefinitionHash as string,
    toolVersion: row.toolVersion as string,
    capability: row.capability as string,
    operation: row.operation as string,
    resource: row.resource as string,
    requestHash: row.requestHash as string,
    idempotencyKey: row.idempotencyKey as string,
    status: (row.status as ExecutionGrant["status"]),
    policyProvenance: row.policyProvenance as ExecutionGrant["policyProvenance"],
    credentialRequirements: (row.credentialRequirements ?? []) as string[],
    networkRequired: (row.networkRequired ?? false) as boolean,
    isolationLevel: (row.isolationLevel ?? "none") as ExecutionGrant["isolationLevel"],
    issuedAt: row.issuedAt as string,
    expiresAt: row.expiresAt as string,
  };
}

function mapRowToRecord(row: Record<string, unknown>): ExecutionRecord {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotencyKey as string,
    grantId: row.grantId as string,
    tenantId: row.tenantId as string,
    missionId: row.missionId as string,
    runId: row.runId as string,
    toolId: row.toolId as ExecutionRecord["toolId"],
    requestHash: row.requestHash as string,
    state: row.state as IdempotencyState,
    attempts: (row.attempts ?? []) as ExecutionRecord["attempts"],
    output: row.output as ExecutionRecord["output"],
    error: row.error as ExecutionRecord["error"],
    createdAt: row.createdAt as string,
    completedAt: row.completedAt as string | undefined,
  };
}
