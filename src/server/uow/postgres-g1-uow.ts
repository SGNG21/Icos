import { eq } from "drizzle-orm";

import type { Database } from "@/server/database/client";
import {
  classifyDbError,
  PersistenceUnavailableError,
  TransientConflictError,
  uniqueConstraintName,
} from "@/server/database/errors";
import { idempotencyStates, executionRecords } from "@/server/database/g1-schema";
import { auditEntries } from "@/server/database/schema";
import type {
  ExecutionRecord,
  IdempotencyKey,
  IdempotencyState,
} from "@/core/contracts/g1";
import type { AuditEntry } from "@/core/contracts";
import { auditToRow } from "@/server/database/mappers";

import type {
  G1UnitOfWork,
  ReserveResult,
  StartResult,
  CompleteResult,
  FailSafeResult,
  ResolveUnknownResult,
} from "./g1-uow-ports";

/**
 * Unité de travail transactionnelle PostgreSQL pour G1.0.
 *
 * Chaque méthode encapsule transition d'état + execution record + audit
 * dans `db.transaction()` : soit l'ensemble réussit, soit rien n'est
 * appliqué (rollback automatique sur erreur).
 */
export class PostgresG1UnitOfWork implements G1UnitOfWork {
  constructor(private readonly db: Database) {}

  async reserve(input: {
    idempotencyState: IdempotencyState;
    auditEntry: AuditEntry;
  }): Promise<ReserveResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // 1. Insertion conditionnelle
        try {
          await tx.insert(idempotencyStates).values({
            idempotency_key: input.idempotencyState.idempotencyKey,
            request_hash: input.idempotencyState.requestHash,
            state: input.idempotencyState.state,
            attempt_number: input.idempotencyState.attemptNumber,
            tenant: input.idempotencyState.tenant,
            created_at: new Date(input.idempotencyState.createdAt),
            updated_at: new Date(input.idempotencyState.updatedAt),
            locked_at: input.idempotencyState.lockedAt
              ? new Date(input.idempotencyState.lockedAt)
              : null,
            locked_by: input.idempotencyState.lockedBy ?? null,
          });
        } catch (insertError: unknown) {
          if (uniqueConstraintName(insertError) === "idempotency_states_pkey") {
            return {
              ok: false as const,
              reason: "already_reserved" as const,
              message: "Réservation déjà existante",
            };
          }
          throw insertError;
        }

        // 2. Audit
        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));

        return { ok: true as const, state: input.idempotencyState };
      });
    } catch (error) {
      if (error instanceof TransientConflictError || error instanceof PersistenceUnavailableError) {
        throw error;
      }
      if (uniqueConstraintName(error) === "audit_entries_pkey") {
        return { ok: false, reason: "audit_failed", message: "collision d'identifiant d'audit" };
      }
      return this.mapG1Error(error, "reserve");
    }
  }

  async start(input: {
    idempotencyKey: IdempotencyKey;
    auditEntry: AuditEntry;
    record: ExecutionRecord;
  }): Promise<StartResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // 1. Lock and check current state
        const current = await tx
          .select()
          .from(idempotencyStates)
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey))
          .for("update")
          .limit(1);

        if (current.length === 0) {
          return { ok: false as const, reason: "not_found" as const, message: "État introuvable" };
        }

        if (current[0].state !== "RESERVED") {
          return {
            ok: false as const,
            reason: "invalid_state" as const,
            message: `État attendu RESERVED, réel ${current[0].state}`,
          };
        }

        // 2. Transition RESERVED → EXECUTING
        const now = new Date();
        await tx
          .update(idempotencyStates)
          .set({ state: "EXECUTING", updated_at: now })
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey));

        // 3. Execution record
        await tx.insert(executionRecords).values({
          id: input.record.id,
          idempotency_key: input.record.idempotencyKey,
          request_hash: input.record.requestHash,
          grant_id: input.record.grantId,
          tenant: input.record.tenant,
          event_type: input.record.eventType,
          actor: input.record.actor,
          classification: input.record.classification,
          occurred_at: new Date(input.record.occurredAt),
          outcome: input.record.outcome ?? null,
          error_code: input.record.errorCode ?? null,
          duration_ms: input.record.durationMs ?? null,
          artifact_refs: input.record.artifactRefs ?? null,
          output_hash: input.record.outputHash ?? null,
          policy_refs: input.record.policyRefs ?? null,
          metadata: input.record.metadata ?? null,
        });

        // 4. Audit
        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));

        return { ok: true as const, state: current[0] as unknown as IdempotencyState };
      });
    } catch (error) {
      return this.mapG1Error(error, "start");
    }
  }

  async complete(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
    durableResultRef: string;
  }): Promise<CompleteResult> {
    if (!input.durableResultRef) {
      return { ok: false, reason: "no_durable_result", message: "Résultat durable requis" };
    }

    try {
      return await this.db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(idempotencyStates)
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey))
          .for("update")
          .limit(1);

        if (current.length === 0) {
          return { ok: false as const, reason: "not_found" as const, message: "État introuvable" };
        }

        // Idempotent replay: already COMPLETED
        if (current[0].state === "COMPLETED") {
          return { ok: true as const, state: current[0] as unknown as IdempotencyState, replay: true as const };
        }

        if (current[0].state !== "EXECUTING") {
          return {
            ok: false as const,
            reason: "invalid_state" as const,
            message: `État attendu EXECUTING, réel ${current[0].state}`,
          };
        }

        const now = new Date();
        await tx
          .update(idempotencyStates)
          .set({ state: "COMPLETED", updated_at: now })
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey));

        await tx.insert(executionRecords).values({
          id: input.record.id,
          idempotency_key: input.record.idempotencyKey,
          request_hash: input.record.requestHash,
          grant_id: input.record.grantId,
          tenant: input.record.tenant,
          event_type: input.record.eventType,
          actor: input.record.actor,
          classification: input.record.classification,
          occurred_at: new Date(input.record.occurredAt),
          outcome: input.record.outcome ?? null,
          error_code: input.record.errorCode ?? null,
          duration_ms: input.record.durationMs ?? null,
          artifact_refs: input.record.artifactRefs ?? null,
          output_hash: input.record.outputHash ?? null,
          policy_refs: input.record.policyRefs ?? null,
          metadata: input.record.metadata ?? null,
        });

        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));

        return { ok: true as const, state: {} as IdempotencyState, replay: false as const };
      });
    } catch (error) {
      return this.mapG1Error(error, "complete");
    }
  }

  async failSafe(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
  }): Promise<FailSafeResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(idempotencyStates)
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey))
          .for("update")
          .limit(1);

        if (current.length === 0) {
          return { ok: false as const, reason: "not_found" as const, message: "État introuvable" };
        }

        if (current[0].state !== "EXECUTING") {
          return {
            ok: false as const,
            reason: "invalid_state" as const,
            message: `État attendu EXECUTING, réel ${current[0].state}`,
          };
        }

        const now = new Date();
        await tx
          .update(idempotencyStates)
          .set({ state: "FAILED_SAFE", updated_at: now })
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey));

        await tx.insert(executionRecords).values({
          id: input.record.id,
          idempotency_key: input.record.idempotencyKey,
          request_hash: input.record.requestHash,
          grant_id: input.record.grantId,
          tenant: input.record.tenant,
          event_type: input.record.eventType,
          actor: input.record.actor,
          classification: input.record.classification,
          occurred_at: new Date(input.record.occurredAt),
          outcome: input.record.outcome ?? null,
          error_code: input.record.errorCode ?? null,
          duration_ms: input.record.durationMs ?? null,
          artifact_refs: input.record.artifactRefs ?? null,
          output_hash: input.record.outputHash ?? null,
          policy_refs: input.record.policyRefs ?? null,
          metadata: input.record.metadata ?? null,
        });

        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));

        return { ok: true as const, state: {} as IdempotencyState };
      });
    } catch (error) {
      return this.mapG1Error(error, "failSafe");
    }
  }

  async resolveUnknown(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
  }): Promise<ResolveUnknownResult> {
    try {
      return await this.db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(idempotencyStates)
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey))
          .for("update")
          .limit(1);

        if (current.length === 0) {
          return { ok: false as const, reason: "not_found" as const, message: "État introuvable" };
        }

        if (current[0].state !== "EXECUTING") {
          return {
            ok: false as const,
            reason: "invalid_state" as const,
            message: `État attendu EXECUTING, réel ${current[0].state}`,
          };
        }

        const now = new Date();
        await tx
          .update(idempotencyStates)
          .set({ state: "UNKNOWN", updated_at: now })
          .where(eq(idempotencyStates.idempotencyKey, input.idempotencyKey));

        await tx.insert(executionRecords).values({
          id: input.record.id,
          idempotency_key: input.record.idempotencyKey,
          request_hash: input.record.requestHash,
          grant_id: input.record.grantId,
          tenant: input.record.tenant,
          event_type: input.record.eventType,
          actor: input.record.actor,
          classification: input.record.classification,
          occurred_at: new Date(input.record.occurredAt),
          outcome: input.record.outcome ?? null,
          error_code: input.record.errorCode ?? null,
          duration_ms: input.record.durationMs ?? null,
          artifact_refs: input.record.artifactRefs ?? null,
          output_hash: input.record.outputHash ?? null,
          policy_refs: input.record.policyRefs ?? null,
          metadata: input.record.metadata ?? null,
        });

        await tx.insert(auditEntries).values(auditToRow(input.auditEntry));

        return { ok: true as const, state: {} as IdempotencyState };
      });
    } catch (error) {
      return this.mapG1Error(error, "resolveUnknown");
    }
  }

  private mapG1Error<T>(error: unknown, _operation: string): T | never {
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
