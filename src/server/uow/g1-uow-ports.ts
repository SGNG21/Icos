import type {
  ExecutionRecord,
  IdempotencyKey,
  IdempotencyState,
} from "@/core/contracts/g1";
import type { AuditEntry } from "@/core/contracts";

// ─────────────────────────────────────
// Result types
// ─────────────────────────────────────

export type ReserveResult =
  | { ok: true; state: IdempotencyState }
  | { ok: false; reason: "already_reserved" | "audit_failed"; message: string; existing?: IdempotencyState | null };

export type StartResult =
  | { ok: true; state: IdempotencyState }
  | { ok: false; reason: "not_found" | "invalid_state" | "record_failed" | "audit_failed"; message: string };

export type CompleteResult =
  | { ok: true; state: IdempotencyState; replay: boolean }
  | { ok: false; reason: "not_found" | "invalid_state" | "no_durable_result" | "record_failed" | "audit_failed"; message: string };

export type FailSafeResult =
  | { ok: true; state: IdempotencyState }
  | { ok: false; reason: "not_found" | "invalid_state" | "record_failed" | "audit_failed"; message: string };

export type ResolveUnknownResult =
  | { ok: true; state: IdempotencyState }
  | { ok: false; reason: "not_found" | "invalid_state" | "record_failed" | "audit_failed"; message: string };

// ─────────────────────────────────────
// G1 Unit of Work — Atomic lifecycle transitions
// ─────────────────────────────────────

/**
 * Unité de travail transactionnelle pour le cycle de vie G1.
 *
 * Chaque méthode encapsule :
 * 1. Transition d'état de l'IdempotencyState
 * 2. Append de l'ExecutionRecord
 * 3. Append de l'entrée d'audit
 *
 * Soit l'ensemble réussit, soit rien n'est appliqué.
 *
 * Règles :
 * - COMPLETED exige un `durableResultRef` (référence au résultat durable)
 * - UNKNOWN → JAMAIS de rejeu automatique
 * - Toute transition incomplète laisse un état récupérable sûr
 *   (RESERVED peut être re-pris, EXECUTING peut redevenir RESERVED
 *    si le verrou est stale, etc.)
 */
export interface G1UnitOfWork {
  /**
   * reserve : crée une réservation atomique (RESERVED) + ExecutionRecord +
   * audit. Échoue si l'idempotencyKey existe déjà.
   */
  reserve(input: {
    idempotencyState: IdempotencyState;
    auditEntry: AuditEntry;
  }): Promise<ReserveResult>;

  /**
   * start : transition atomique RESERVED → EXECUTING + ExecutionRecord + audit.
   * L'exécution externe ne peut démarrer qu'après cette transition réussie.
   */
  start(input: {
    idempotencyKey: IdempotencyKey;
    auditEntry: AuditEntry;
    record: ExecutionRecord;
  }): Promise<StartResult>;

  /**
   * complete : transition atomique EXECUTING → COMPLETED + ExecutionRecord +
   * audit. Exige une `durableResultRef`.
   *
   * Retourne `replay: true` si l'état était déjà COMPLETED
   * (idempotent replay).
   */
  complete(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
    durableResultRef: string;
  }): Promise<CompleteResult>;

  /**
   * failSafe : transition atomique EXECUTING → FAILED_SAFE + ExecutionRecord +
   * audit.
   */
  failSafe(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
  }): Promise<FailSafeResult>;

  /**
   * resolveUnknown : transition atomique EXECUTING → UNKNOWN + ExecutionRecord +
   * audit. NE JAMAIS appelé pour un rejeu automatique.
   */
  resolveUnknown(input: {
    idempotencyKey: IdempotencyKey;
    record: ExecutionRecord;
    auditEntry: AuditEntry;
  }): Promise<ResolveUnknownResult>;
}
