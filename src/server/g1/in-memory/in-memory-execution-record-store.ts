import type { ExecutionRecord, IdempotencyKey } from "@/core/g1";
import type { ExecutionRecordStore } from "@/server/g1/ports";

/**
 * ExecutionRecordStore in-memory pour tests.
 *
 * Append-only : les enregistrements ne peuvent pas être modifiés
 * après insertion.
 */
export class InMemoryExecutionRecordStore implements ExecutionRecordStore {
  private records = new Map<string, ExecutionRecord>();

  async append(record: ExecutionRecord): Promise<void> {
    // Append-only : refuser l'écrasement
    if (this.records.has(record.id)) {
      throw new Error(`ExecutionRecord ${record.id} existe déjà (append-only)`);
    }
    this.records.set(record.id, { ...record });
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async findByIdempotencyKey(idempotencyKey: IdempotencyKey): Promise<ExecutionRecord[]> {
    return Array.from(this.records.values()).filter((r) => r.idempotencyKey === idempotencyKey);
  }

  async listByTenant(tenantId: string): Promise<ExecutionRecord[]> {
    return Array.from(this.records.values()).filter((r) => r.tenantId === tenantId);
  }

  /** Réinitialise le store. */
  reset(): void {
    this.records.clear();
  }

  // Snapshot / restore pour UnitOfWork
  _snapshot(): Map<string, ExecutionRecord> {
    return new Map(this.records);
  }

  _restore(snapshot: Map<string, ExecutionRecord>): void {
    this.records = snapshot;
  }
}
