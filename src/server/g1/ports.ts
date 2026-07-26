import type {
  ExecutionGrant,
  ExecutionRecord,
  IdempotencyEntry,
  IdempotencyKey,
  IdempotencyState,
} from "@/core/g1";

// ─────────────────────────────────────
// GrantRepository
// ─────────────────────────────────────

export interface GrantRepository {
  /** Sauvegarde un nouveau grant. */
  save(grant: ExecutionGrant): Promise<void>;

  /** Récupère un grant par son ID. */
  findById(id: string): Promise<ExecutionGrant | null>;

  /**
   * Consomme atomiquement un grant (marque consumedAt).
   * Retourne false si déjà consommé ou expiré.
   */
  consumeAtomically(id: string): Promise<boolean>;

  /** Liste les grants non consommés pour un tenant. */
  listAvailable(tenantId: string): Promise<ExecutionGrant[]>;
}

// ─────────────────────────────────────
// IdempotencyStore
// ─────────────────────────────────────

export type IdempotencyTransition =
  | { type: "reserve" }
  | { type: "start"; expectedState: "RESERVED" }
  | { type: "complete"; replayResult?: unknown }
  | { type: "fail_safe" }
  | { type: "unknown" }
  | { type: "retry" };

export interface IdempotencyStore {
  /**
   * Réserve une clé d'idempotence.
   * Retourne null si la clé existe déjà (conflit).
   */
  reserve(entry: IdempotencyEntry): Promise<IdempotencyEntry | null>;

  /**
   * Transition atomique d'un état vers un autre.
   * Retourne null si l'état actuel ne correspond pas à expectedState.
   */
  transition(
    idempotencyKey: IdempotencyKey,
    expectedState: IdempotencyState,
    targetState: IdempotencyState,
    update: Partial<IdempotencyEntry>,
  ): Promise<IdempotencyEntry | null>;

  /** Récupère une entrée par sa clé. */
  findByKey(idempotencyKey: IdempotencyKey): Promise<IdempotencyEntry | null>;

  /** Récupère toutes les entrées pour un tenant. */
  listByTenant(tenantId: string): Promise<IdempotencyEntry[]>;
}

// ─────────────────────────────────────
// ExecutionRecordStore
// ─────────────────────────────────────

export interface ExecutionRecordStore {
  /** Ajoute un nouveau record (append-only). */
  append(record: ExecutionRecord): Promise<void>;

  /** Récupère un record par son ID. */
  findById(id: string): Promise<ExecutionRecord | null>;

  /** Récupère les records par clé d'idempotence. */
  findByIdempotencyKey(idempotencyKey: IdempotencyKey): Promise<ExecutionRecord[]>;

  /** Récupère les records pour un tenant. */
  listByTenant(tenantId: string): Promise<ExecutionRecord[]>;
}

// ─────────────────────────────────────
// G1 Unit of Work
// ─────────────────────────────────────

/**
 * Permet des transitions atomiques entre Grant, IdempotencyState
 * et ExecutionRecord.
 *
 * Garantit que COMPLETED n'est jamais déclaré sans que le résultat
 * ou la référence ne soit durable.
 */
export interface G1UnitOfWork {
  /** Engage la transaction. */
  begin(): Promise<void>;
  /** Valide la transaction. */
  commit(): Promise<void>;
  /** Annule la transaction. */
  rollback(): Promise<void>;

  // Accès aux repositories dans le contexte transactionnel
  grants: GrantRepository;
  idempotency: IdempotencyStore;
  records: ExecutionRecordStore;
}
