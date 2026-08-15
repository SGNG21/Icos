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

/**
 * In-memory implementation of ExecutionGrantRepository.
 *
 * Thread-safety: single-threaded JavaScript environment only.
 * No durability guarantees.
 */
export class InMemoryExecutionGrantRepository implements ExecutionGrantRepository {
  private readonly grants = new Map<string, ExecutionGrant>();

  async create(grant: ExecutionGrant): Promise<ExecutionGrant> {
    this.grants.set(grant.id, { ...grant });
    return grant;
  }

  async getById(id: string): Promise<ExecutionGrant | null> {
    const grant = this.grants.get(id);
    return grant ? { ...grant } : null;
  }

  async consume(id: string): Promise<ConsumeGrantRepoResult> {
    const grant = this.grants.get(id);
    if (!grant) {
      return { ok: false, reason: "not_found", message: "Grant introuvable" };
    }
    if (grant.consumed) {
      return { ok: false, reason: "already_consumed", message: "Grant déjà consommé" };
    }
    if (new Date(grant.expiresAt) < new Date()) {
      return { ok: false, reason: "expired", message: "Grant expiré" };
    }
    const updated = { ...grant, consumed: true };
    this.grants.set(id, updated);
    return { ok: true, grant: updated };
  }

  async listForTenant(tenant: string): Promise<ExecutionGrant[]> {
    return Array.from(this.grants.values())
      .filter((g) => g.tenant === tenant)
      .map((g) => ({ ...g }));
  }
}

/**
 * In-memory implementation of IdempotencyStateRepository.
 *
 * Thread-safety: single-threaded JavaScript environment only.
 */
export class InMemoryIdempotencyStateRepository implements IdempotencyStateRepository {
  private readonly states = new Map<string, IdempotencyState>();

  async create(input: IdempotencyState): Promise<IdempotencyState | null> {
    if (this.states.has(input.idempotencyKey)) {
      return null; // concurrent creation detected
    }
    this.states.set(input.idempotencyKey, { ...input });
    return input;
  }

  async getByKey(key: IdempotencyKey): Promise<IdempotencyState | null> {
    const state = this.states.get(key);
    return state ? { ...state } : null;
  }

  async transition(
    key: IdempotencyKey,
    expected: IdempotencyStateStatus,
    target: IdempotencyStateStatus,
  ): Promise<TransitionResult> {
    const state = this.states.get(key);
    if (!state) {
      return { ok: false, reason: "not_found", message: "État d'idempotence introuvable" };
    }
    if (state.state !== expected) {
      return {
        ok: false,
        reason: "conflict",
        message: `État attendu ${expected}, réel ${state.state}`,
      };
    }
    const updated: IdempotencyState = {
      ...state,
      state: target,
      updatedAt: new Date().toISOString(),
    };
    this.states.set(key, updated);
    return { ok: true, state: updated };
  }

  async update(state: IdempotencyState): Promise<void> {
    this.states.set(state.idempotencyKey, { ...state });
  }

  async listByStatus(status: IdempotencyStateStatus): Promise<IdempotencyState[]> {
    return Array.from(this.states.values())
      .filter((s) => s.state === status)
      .map((s) => ({ ...s }));
  }

  async listForTenant(tenant: string): Promise<IdempotencyState[]> {
    return Array.from(this.states.values())
      .filter((s) => s.tenant === tenant)
      .map((s) => ({ ...s }));
  }
}

/**
 * In-memory implementation of ExecutionRecordRepository (append-only).
 */
export class InMemoryExecutionRecordRepository implements ExecutionRecordRepository {
  private readonly records: ExecutionRecord[] = [];

  async append(record: ExecutionRecord): Promise<ExecutionRecord> {
    this.records.push({ ...record });
    return record;
  }

  async listForTenant(tenant: string): Promise<ExecutionRecord[]> {
    return this.records
      .filter((r) => r.tenant === tenant)
      .map((r) => ({ ...r }));
  }

  async listForKey(key: IdempotencyKey): Promise<ExecutionRecord[]> {
    return this.records
      .filter((r) => r.idempotencyKey === key)
      .map((r) => ({ ...r }));
  }

  async list(): Promise<ExecutionRecord[]> {
    return this.records.map((r) => ({ ...r }));
  }
}
