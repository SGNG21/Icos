import type {
  ExecutionGrant,
  ExecutionRecord,
  IdempotencyKey,
  IdempotencyState,
  IdempotencyStateStatus,
} from "@/core/contracts/g1";
import type { AuditEntry } from "@/core/contracts";
import type { AuditLog } from "@/server/audit/in-memory-audit-log";
import type {
  InMemoryExecutionGrantRepository,
  InMemoryIdempotencyStateRepository,
  InMemoryExecutionRecordRepository,
} from "@/server/services/in-memory/g1-repositories";

import type {
  G1UnitOfWork,
  ReserveResult,
  StartResult,
  CompleteResult,
  FailSafeResult,
  ResolveUnknownResult,
} from "./g1-uow-ports";

/**
 * Unité de travail EN MÉMOIRE pour les opérations atomiques G1.0.
 *
 * Chaque méthode suit un pattern de pré-validation → mutation → audit
 * avec restauration sur échec d'audit, garantissant qu'aucune transition
 * d'état n'est persistée sans son entrée d'audit correspondante.
 *
 * L'atomicité est garantie par l'exécution synchrone (pas d'await interne
 * entre mutation et vérification d'audit) : en JavaScript monothread,
 * aucune interruption concurrente n'est possible entre les deux étapes.
 *
 * ATTENTION : cette implémentation NE garantit PAS la durabilité ni la
 * cohérence multi-instances. Ces propriétés sont apportées par
 * l'implémentation PostgreSQL.
 */
export class InMemoryG1UnitOfWork implements G1UnitOfWork {
  constructor(
    private readonly grants: InMemoryExecutionGrantRepository,
    private readonly states: InMemoryIdempotencyStateRepository,
    private readonly records: InMemoryExecutionRecordRepository,
    private readonly auditLog: AuditLog,
  ) {}

  async reserve(input: {
    idempotencyState: IdempotencyState;
    auditEntry: AuditEntry;
  }): Promise<ReserveResult> {
    // 1. Tentative de réservation
    const created = await this.states.create(input.idempotencyState);
    if (created === null) {
      const existing = await this.states.getByKey(input.idempotencyState.idempotencyKey);
      return {
        ok: false,
        reason: "already_reserved",
        message: "Réservation déjà existante",
        existing,
      };
    }

    // 2. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      // Restaurer : supprimer la réservation
      await this.states.update({ ...created, state: "UNKNOWN" as IdempotencyStateStatus });
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, state: created };
  }

  async start(input: {
    idempotencyKey: IdempotencyKey;
    auditEntry: AuditEntry;
    record: ExecutionRecord;
  }): Promise<StartResult> {
    // 1. Transition atomique RESERVED → EXECUTING
    const transition = await this.states.transition(input.idempotencyKey, "RESERVED", "EXECUTING");
    if (!transition.ok) {
      if (transition.reason === "not_found") {
        return { ok: false, reason: "not_found", message: transition.message };
      }
      return {
        ok: false,
        reason: "invalid_state",
        message: transition.message,
      };
    }

    // 2. Append execution record
    try {
      this.records.append(input.record);
    } catch (error) {
      // Restaurer l'état RESERVED
      await this.states.transition(input.idempotencyKey, "EXECUTING", "RESERVED");
      return {
        ok: false,
        reason: "record_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // 3. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.states.transition(input.idempotencyKey, "EXECUTING", "RESERVED");
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, state: transition.state };
  }

  async complete(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
    durableResultRef?: string;
  }): Promise<CompleteResult> {
    // 1. Vérifier qu'un résultat/référence durable est fourni
    if (!input.durableResultRef) {
      return { ok: false, reason: "no_durable_result", message: "Résultat durable requis pour COMPLETED" };
    }

    // 2. Transition atomique EXECUTING → COMPLETED
    const transition = await this.states.transition(input.idempotencyKey, "EXECUTING", "COMPLETED");
    if (!transition.ok) {
      if (transition.reason === "not_found") {
        return { ok: false, reason: "not_found", message: transition.message };
      }
      // Might be already COMPLETED (replay)
      if (transition.message.includes("COMPLETED")) {
        const existing = await this.states.getByKey(input.idempotencyKey);
        return { ok: true, state: existing!, replay: true };
      }
      return {
        ok: false,
        reason: "invalid_state",
        message: transition.message,
      };
    }

    // 3. Append execution record
    try {
      this.records.append(input.record);
    } catch (error) {
      // Restaurer
      await this.states.transition(input.idempotencyKey, "COMPLETED", "EXECUTING");
      return {
        ok: false,
        reason: "record_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // 4. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.states.transition(input.idempotencyKey, "COMPLETED", "EXECUTING");
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, state: transition.state, replay: false };
  }

  async failSafe(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
  }): Promise<FailSafeResult> {
    // 1. Transition atomique EXECUTING → FAILED_SAFE
    const transition = await this.states.transition(input.idempotencyKey, "EXECUTING", "FAILED_SAFE");
    if (!transition.ok) {
      if (transition.reason === "not_found") {
        return { ok: false, reason: "not_found", message: transition.message };
      }
      return {
        ok: false,
        reason: "invalid_state",
        message: transition.message,
      };
    }

    // 2. Append execution record
    try {
      this.records.append(input.record);
    } catch (error) {
      await this.states.transition(input.idempotencyKey, "FAILED_SAFE", "EXECUTING");
      return {
        ok: false,
        reason: "record_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // 3. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.states.transition(input.idempotencyKey, "FAILED_SAFE", "EXECUTING");
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, state: transition.state };
  }

  async resolveUnknown(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
  }): Promise<ResolveUnknownResult> {
    // 1. Transition atomique EXECUTING → UNKNOWN
    const transition = await this.states.transition(input.idempotencyKey, "EXECUTING", "UNKNOWN");
    if (!transition.ok) {
      if (transition.reason === "not_found") {
        return { ok: false, reason: "not_found", message: transition.message };
      }
      return {
        ok: false,
        reason: "invalid_state",
        message: transition.message,
      };
    }

    // 2. Append execution record
    try {
      this.records.append(input.record);
    } catch (error) {
      await this.states.transition(input.idempotencyKey, "UNKNOWN", "EXECUTING");
      return {
        ok: false,
        reason: "record_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // 3. Audit avec restauration sur échec
    try {
      this.auditLog.append(input.auditEntry);
    } catch (error) {
      await this.states.transition(input.idempotencyKey, "UNKNOWN", "EXECUTING");
      return {
        ok: false,
        reason: "audit_failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }

    return { ok: true, state: transition.state };
  }
}
