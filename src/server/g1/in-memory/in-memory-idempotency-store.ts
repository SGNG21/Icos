import { type IdempotencyEntry, type IdempotencyKey, type IdempotencyState } from "@/core/g1";
import type { IdempotencyStore } from "@/server/g1/ports";

/**
 * IdempotencyStore in-memory pour tests.
 *
 * Supporte les transitions atomiques via verrouillage par clé.
 * Utile pour tester les cas de réservation concurrente.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, IdempotencyEntry>();
  private locks = new Set<string>();

  async reserve(entry: IdempotencyEntry): Promise<IdempotencyEntry | null> {
    if (this.entries.has(entry.idempotencyKey)) {
      return null; // Conflit : clé déjà existante
    }

    this.entries.set(entry.idempotencyKey, { ...entry });
    return { ...entry };
  }

  async transition(
    idempotencyKey: IdempotencyKey,
    expectedState: IdempotencyState,
    targetState: IdempotencyState,
    update: Partial<IdempotencyEntry>,
  ): Promise<IdempotencyEntry | null> {
    // Verrouillage pour simuler l'atomicité
    if (this.locks.has(idempotencyKey)) {
      return null; // Transition concurrente
    }
    this.locks.add(idempotencyKey);

    try {
      const existing = this.entries.get(idempotencyKey);
      if (!existing) return null;

      // Vérification de l'état attendu
      if (existing.state !== expectedState) return null;

      const updated: IdempotencyEntry = {
        ...existing,
        ...update,
        state: targetState,
        updatedAt: update.updatedAt ?? new Date().toISOString(),
      };

      if (
        targetState === "COMPLETED" ||
        targetState === "FAILED_SAFE" ||
        targetState === "UNKNOWN"
      ) {
        updated.completedAt = updated.updatedAt;
      }

      this.entries.set(idempotencyKey, updated);
      return { ...updated };
    } finally {
      this.locks.delete(idempotencyKey);
    }
  }

  async findByKey(idempotencyKey: IdempotencyKey): Promise<IdempotencyEntry | null> {
    return this.entries.get(idempotencyKey) ?? null;
  }

  async listByTenant(tenantId: string): Promise<IdempotencyEntry[]> {
    return Array.from(this.entries.values()).filter((e) => e.tenantId === tenantId);
  }

  /** Réinitialise le store pour les tests. */
  reset(): void {
    this.entries.clear();
    this.locks.clear();
  }

  // Snapshot / restore pour UnitOfWork
  _snapshot(): Map<string, IdempotencyEntry> {
    return new Map(this.entries);
  }

  _restore(snapshot: Map<string, IdempotencyEntry>): void {
    this.entries = snapshot;
    this.locks.clear();
  }
}
