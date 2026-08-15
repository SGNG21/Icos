import type {
  ExecutionGrant,
  ExecutionGrantStatus,
  ExecutionRecord,
  IdempotencyState,
} from "@/core/contracts/tool";

// ─────────────────────────────────────
// Execution Grant Repository
// ─────────────────────────────────────

export interface ExecutionGrantRepository {
  create(grant: ExecutionGrant): Promise<ExecutionGrant>;
  findById(id: string): Promise<ExecutionGrant | null>;
  /**
   * Consomme atomiquement le grant : status issued → consumed.
   * Retourne false si déjà consommé, expiré, ou introuvable.
   */
  consume(id: string): Promise<boolean>;
  /**
   * Expire les grants dont expiresAt est dépassé.
   * Retourne le nombre de grants expirés.
   */
  expireStale(now: string): Promise<number>;
}

// ─────────────────────────────────────
// Execution Record Repository
// ─────────────────────────────────────

export interface ExecutionRecordRepository {
  /**
   * Réservation atomique : INSERT si idempotencyKey inconnue → RESERVED
   * Si existe déjà et payload identique → retourne l'existant
   * Si existe déjà et payload DIFFÉRENT → idempotency_conflict
   */
  reserve(input: {
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
  }>;

  /**
   * Transition atomique de l'état avec condition sur l'état actuel.
   * Ex: RESERVED → EXECUTING uniquement si état == RESERVED.
   */
  transitionState(
    idempotencyKey: string,
    expectedState: IdempotencyState,
    targetState: IdempotencyState,
    attempt?: { attemptNumber: number; startedAt: string; status: "executing" },
    error?: { code: string; message: string },
  ): Promise<{ ok: boolean; record?: ExecutionRecord }>;

  /**
   * Complète atomiquement l'exécution : enregistre le résultat,
   * ajoute la tentative, transitionne l'état.
   */
  complete(input: {
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
  }): Promise<{ ok: boolean; record?: ExecutionRecord }>;

  findByIdempotencyKey(key: string): Promise<ExecutionRecord | null>;
  findById(id: string): Promise<ExecutionRecord | null>;

  /**
   * Récupère les RESERVED ou EXECUTING dont la dernière mise à jour
   * est antérieure à un timestamp donné (staleness detection).
   */
  findStale(before: string): Promise<ExecutionRecord[]>;
}
