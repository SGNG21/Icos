import { eq, and, lte } from "drizzle-orm";

import type { Database } from "@/server/database/client";
import { RepositoryMappingError, classifyDbError, uniqueConstraintName, PersistenceUnavailableError, TransientConflictError } from "@/server/database/errors";
import { executionGrants, idempotencyStates, executionRecords } from "@/server/database/g1-schema";
import type {
  ConsumeGrantRepoResult,
  ExecutionGrantRepository,
  IdempotencyStateRepository,
  ExecutionRecordRepository,
  TransitionResult,
} from "@/server/repositories/ports";
import type {
  ExecutionGrant,
  ExecutionRecord,
  IdempotencyKey,
  IdempotencyState,
  IdempotencyStateStatus,
} from "@/core/contracts/g1";

// ─────────────────────────────────────
// Mappers
// ─────────────────────────────────────

type GrantRow = typeof executionGrants.$inferSelect;
type GrantInsert = typeof executionGrants.$inferInsert;
type StateRow = typeof idempotencyStates.$inferSelect;
type StateInsert = typeof idempotencyStates.$inferInsert;
type RecordRow = typeof executionRecords.$inferSelect;
type RecordInsert = typeof executionRecords.$inferInsert;

const iso = (value: Date): string => value.toISOString();

function rowToGrant(row: GrantRow): ExecutionGrant {
  return {
    id: row.id,
    tenant: row.tenant,
    principal: row.principal,
    mission: row.mission,
    run: row.run,
    toolId: row.tool_id,
    toolDefinitionHash: row.tool_definition_hash,
    toolVersion: row.tool_version ?? undefined,
    capability: row.capability,
    operation: row.operation,
    resource: row.resource,
    requestHash: row.request_hash as ExecutionGrant["requestHash"],
    idempotencyKey: row.idempotency_key as ExecutionGrant["idempotencyKey"],
    policyProvenance: row.policy_provenance as Record<string, unknown>,
    credentialRequirements: row.credential_requirements ? (row.credential_requirements as Record<string, unknown>) : undefined,
    networkRequirements: row.network_requirements ? (row.network_requirements as Record<string, unknown>) : undefined,
    isolationRequirements: row.isolation_requirements ? (row.isolation_requirements as Record<string, unknown>) : undefined,
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    consumed: row.consumed,
  };
}

function grantToRow(grant: ExecutionGrant): GrantInsert {
  return {
    id: grant.id,
    tenant: grant.tenant,
    principal: grant.principal,
    mission: grant.mission,
    run: grant.run,
    tool_id: grant.toolId,
    tool_definition_hash: grant.toolDefinitionHash,
    tool_version: grant.toolVersion ?? null,
    capability: grant.capability,
    operation: grant.operation,
    resource: grant.resource,
    request_hash: grant.requestHash,
    idempotency_key: grant.idempotencyKey,
    policy_provenance: grant.policyProvenance,
    credential_requirements: grant.credentialRequirements ?? null,
    network_requirements: grant.networkRequirements ?? null,
    isolation_requirements: grant.isolationRequirements ?? null,
    issued_at: new Date(grant.issuedAt),
    expires_at: new Date(grant.expiresAt),
    consumed: grant.consumed,
  };
}

function rowToState(row: StateRow): IdempotencyState {
  return {
    idempotencyKey: row.idempotency_key as IdempotencyKey,
    requestHash: row.request_hash as IdempotencyState["requestHash"],
    state: row.state as IdempotencyStateStatus,
    attemptNumber: row.attempt_number,
    tenant: row.tenant,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lockedAt: row.locked_at ? iso(row.locked_at) : undefined,
    lockedBy: row.locked_by ?? undefined,
  };
}

function stateToRow(state: IdempotencyState): StateInsert {
  return {
    idempotency_key: state.idempotencyKey,
    request_hash: state.requestHash,
    state: state.state,
    attempt_number: state.attemptNumber,
    tenant: state.tenant,
    created_at: new Date(state.createdAt),
    updated_at: new Date(state.updatedAt),
    locked_at: state.lockedAt ? new Date(state.lockedAt) : null,
    locked_by: state.lockedBy ?? null,
  };
}

function rowToRecord(row: RecordRow): ExecutionRecord {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key as ExecutionRecord["idempotencyKey"],
    requestHash: row.request_hash as ExecutionRecord["requestHash"],
    grantId: row.grant_id,
    tenant: row.tenant,
    eventType: row.event_type as ExecutionRecord["eventType"],
    actor: row.actor,
    classification: row.classification as ExecutionRecord["classification"],
    occurredAt: iso(row.occurred_at),
    outcome: row.outcome ?? undefined,
    errorCode: row.error_code ?? undefined,
    durationMs: row.duration_ms ?? undefined,
    artifactRefs: row.artifact_refs ? (row.artifact_refs as string[]) : undefined,
    outputHash: row.output_hash ?? undefined,
    policyRefs: row.policy_refs ? (row.policy_refs as string[]) : undefined,
    metadata: row.metadata ? (row.metadata as Record<string, unknown>) : undefined,
  };
}

function recordToRow(record: ExecutionRecord): RecordInsert {
  return {
    id: record.id,
    idempotency_key: record.idempotencyKey,
    request_hash: record.requestHash,
    grant_id: record.grantId,
    tenant: record.tenant,
    event_type: record.eventType,
    actor: record.actor,
    classification: record.classification,
    occurred_at: new Date(record.occurredAt),
    outcome: record.outcome ?? null,
    error_code: record.errorCode ?? null,
    duration_ms: record.durationMs ?? null,
    artifact_refs: record.artifactRefs ?? null,
    output_hash: record.outputHash ?? null,
    policy_refs: record.policyRefs ?? null,
    metadata: record.metadata ?? null,
  };
}

// ─────────────────────────────────────
// PostgreSQL ExecutionGrantRepository
// ─────────────────────────────────────

export class PostgresExecutionGrantRepository implements ExecutionGrantRepository {
  constructor(private readonly db: Database) {}

  async create(grant: ExecutionGrant): Promise<ExecutionGrant> {
    try {
      const rows = await this.db.insert(executionGrants).values(grantToRow(grant)).returning();
      return rowToGrant(rows[0]);
    } catch (error) {
      throw new RepositoryMappingError(
        "execution_grants",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async getById(id: string): Promise<ExecutionGrant | null> {
    const rows = await this.db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.id, id))
      .limit(1);
    return rows.length === 0 ? null : rowToGrant(rows[0]);
  }

  async consume(id: string): Promise<ConsumeGrantRepoResult> {
    try {
      const existing = await this.db
        .select()
        .from(executionGrants)
        .where(eq(executionGrants.id, id))
        .limit(1);

      if (existing.length === 0) {
        return { ok: false, reason: "not_found", message: "Grant introuvable" };
      }

      const grant = existing[0];

      if (grant.consumed) {
        return { ok: false, reason: "already_consumed", message: "Grant déjà consommé" };
      }

      if (grant.expires_at < new Date()) {
        return { ok: false, reason: "expired", message: "Grant expiré" };
      }

      const updated = await this.db
        .update(executionGrants)
        .set({ consumed: true })
        .where(
          and(
            eq(executionGrants.id, id),
            eq(executionGrants.consumed, false),
          ),
        )
        .returning();

      if (updated.length === 0) {
        return { ok: false, reason: "already_consumed", message: "Grant déjà consommé (concurrent)" };
      }

      return { ok: true, grant: rowToGrant(updated[0]) };
    } catch (error) {
      return this.mapError<ConsumeGrantRepoResult>(error, "consume") as ConsumeGrantRepoResult;
    }
  }

  async listForTenant(tenant: string): Promise<ExecutionGrant[]> {
    const rows = await this.db
      .select()
      .from(executionGrants)
      .where(eq(executionGrants.tenant, tenant));
    return rows.map(rowToGrant);
  }

  private mapError<T>(error: unknown, _operation: string): T | never {
    switch (classifyDbError(error)) {
      case "transient":
        throw new TransientConflictError(_operation);
      case "unavailable":
        throw new PersistenceUnavailableError("connexion base de données");
      default:
        throw error;
    }
  }
}

// ─────────────────────────────────────
// PostgreSQL IdempotencyStateRepository
// ─────────────────────────────────────

export class PostgresIdempotencyStateRepository implements IdempotencyStateRepository {
  constructor(private readonly db: Database) {}

  async create(input: IdempotencyState): Promise<IdempotencyState | null> {
    try {
      const rows = await this.db.insert(idempotencyStates).values(stateToRow(input)).returning();
      return rows.length === 0 ? null : rowToState(rows[0]);
    } catch (error) {
      if (uniqueConstraintName(error) === "idempotency_states_pkey") {
        return null; // concurrent creation
      }
      return this.mapError<IdempotencyState | null>(error, "createIdempotencyState");
    }
  }

  async getByKey(key: IdempotencyKey): Promise<IdempotencyState | null> {
    const rows = await this.db
      .select()
      .from(idempotencyStates)
      .where(eq(idempotencyStates.idempotencyKey, key))
      .limit(1);
    return rows.length === 0 ? null : rowToState(rows[0]);
  }

  async transition(
    key: IdempotencyKey,
    expected: IdempotencyStateStatus,
    target: IdempotencyStateStatus,
  ): Promise<TransitionResult> {
    try {
      const now = new Date();
      const rows = await this.db
        .update(idempotencyStates)
        .set({ state: target, updated_at: now })
        .where(
          and(
            eq(idempotencyStates.idempotencyKey, key),
            eq(idempotencyStates.state, expected),
          ),
        )
        .returning();

      if (rows.length === 0) {
        // Check if key exists at all
        const existing = await this.getByKey(key);
        if (!existing) {
          return { ok: false, reason: "not_found", message: "État d'idempotence introuvable" };
        }
        return {
          ok: false,
          reason: "conflict",
          message: `État attendu ${expected}, réel ${existing.state}`,
        };
      }

      return { ok: true, state: rowToState(rows[0]) };
    } catch (error) {
      return this.mapError<TransitionResult>(error, "transition") as TransitionResult;
    }
  }

  async update(state: IdempotencyState): Promise<void> {
    try {
      await this.db
        .update(idempotencyStates)
        .set(stateToRow(state))
        .where(eq(idempotencyStates.idempotencyKey, state.idempotencyKey));
    } catch (error) {
      this.mapError<void>(error, "updateIdempotencyState");
    }
  }

  async listByStatus(status: IdempotencyStateStatus): Promise<IdempotencyState[]> {
    const rows = await this.db
      .select()
      .from(idempotencyStates)
      .where(eq(idempotencyStates.state, status))
      .orderBy(idempotencyStates.updatedAt);
    return rows.map(rowToState);
  }

  async listForTenant(tenant: string): Promise<IdempotencyState[]> {
    const rows = await this.db
      .select()
      .from(idempotencyStates)
      .where(eq(idempotencyStates.tenant, tenant))
      .orderBy(idempotencyStates.updatedAt);
    return rows.map(rowToState);
  }

  private mapError<T>(error: unknown, _operation: string): T | never {
    switch (classifyDbError(error)) {
      case "transient":
        throw new TransientConflictError(_operation);
      case "unavailable":
        throw new PersistenceUnavailableError("connexion base de données");
      default:
        throw error;
    }
  }
}

// ─────────────────────────────────────
// PostgreSQL ExecutionRecordRepository
// ─────────────────────────────────────

export class PostgresExecutionRecordRepository implements ExecutionRecordRepository {
  constructor(private readonly db: Database) {}

  async append(record: ExecutionRecord): Promise<ExecutionRecord> {
    try {
      const rows = await this.db.insert(executionRecords).values(recordToRow(record)).returning();
      return rowToRecord(rows[0]);
    } catch (error) {
      throw new RepositoryMappingError(
        "execution_records",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async listForTenant(tenant: string): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.tenant, tenant))
      .orderBy(executionRecords.occurredAt);
    return rows.map(rowToRecord);
  }

  async listForKey(key: IdempotencyKey): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .where(eq(executionRecords.idempotencyKey, key))
      .orderBy(executionRecords.occurredAt);
    return rows.map(rowToRecord);
  }

  async list(): Promise<ExecutionRecord[]> {
    const rows = await this.db
      .select()
      .from(executionRecords)
      .orderBy(executionRecords.occurredAt);
    return rows.map(rowToRecord);
  }
}
