import type { ExecutionGrant } from "@/core/g1";
import type { GrantRepository } from "@/server/g1/ports";

/**
 * GrantRepository in-memory pour tests.
 *
 * Comportement par défaut : grants stockés en mémoire vive.
 * concurrentMap simulé par verrouillage explicite dans consumeAtomically.
 */
export class InMemoryGrantRepository implements GrantRepository {
  private grants = new Map<string, ExecutionGrant>();
  private locks = new Set<string>();

  async save(grant: ExecutionGrant): Promise<void> {
    this.grants.set(grant.id, { ...grant });
  }

  async findById(id: string): Promise<ExecutionGrant | null> {
    return this.grants.get(id) ?? null;
  }

  async consumeAtomically(id: string): Promise<boolean> {
    // Verrouillage simple pour simuler l'atomicité
    if (this.locks.has(id)) {
      return false; // Déjà en cours de consommation
    }
    this.locks.add(id);

    try {
      const grant = this.grants.get(id);
      if (!grant) return false;
      if (grant.consumedAt !== null) return false; // Déjà consommé
      if (new Date(grant.expiresAt) < new Date()) return false; // Expiré

      grant.consumedAt = new Date().toISOString();
      this.grants.set(id, { ...grant });
      return true;
    } finally {
      this.locks.delete(id);
    }
  }

  async listAvailable(tenantId: string): Promise<ExecutionGrant[]> {
    const now = new Date();
    return Array.from(this.grants.values()).filter(
      (g) => g.tenantId === tenantId && g.consumedAt === null && new Date(g.expiresAt) > now,
    );
  }

  /** Réinitialise le store pour les tests. */
  reset(): void {
    this.grants.clear();
    this.locks.clear();
  }

  // Snapshot / restore pour UnitOfWork
  _snapshot(): Map<string, ExecutionGrant> {
    return new Map(this.grants);
  }

  _restore(snapshot: Map<string, ExecutionGrant>): void {
    this.grants = snapshot;
    this.locks.clear();
  }
}
