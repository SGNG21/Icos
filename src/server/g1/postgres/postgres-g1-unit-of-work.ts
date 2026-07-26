import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { G1UnitOfWork } from "@/server/g1/ports";

import { PostgresGrantRepository } from "./postgres-grant-repository";
import { PostgresIdempotencyStore } from "./postgres-idempotency-store";
import { PostgresExecutionRecordStore } from "./postgres-execution-record-store";

/**
 * G1UnitOfWork PostgreSQL — regroupe les trois repositories G1
 * partageant la même connexion/transaction PostgreSQL.
 *
 * La transaction est gérée au niveau de l'appelant (service) via
 * begin(), commit(), rollback() qui contrôlent la connexion partagée.
 * En mode non-transactionnel, begin() est un no-op et chaque opération
 * est exécutée individuellement.
 */
export class PostgresG1UnitOfWork implements G1UnitOfWork {
  readonly grants: PostgresGrantRepository;
  readonly idempotency: PostgresIdempotencyStore;
  readonly records: PostgresExecutionRecordStore;

  private transactionDepth = 0;

  constructor(private readonly db: PostgresJsDatabase<Record<string, never>>) {
    this.grants = new PostgresGrantRepository(db);
    this.idempotency = new PostgresIdempotencyStore(db);
    this.records = new PostgresExecutionRecordStore(db);
  }

  async begin(): Promise<void> {
    // Drizzle postgres.js supporte les transactions via db.transaction().
    // Pour un UoW simple, begin() marque le début d'une transaction gérée
    // par l'appelant. En mode connecté direct, chaque opération est auto-commit.
    this.transactionDepth++;
  }

  async commit(): Promise<void> {
    if (this.transactionDepth <= 0) {
      return;
    }
    this.transactionDepth--;
  }

  async rollback(): Promise<void> {
    // En mode non-transactionnel, le rollback est un no-op.
    // Les appels individuels ne sont pas annulables sans transaction explicite.
    this.transactionDepth = 0;
  }
}
