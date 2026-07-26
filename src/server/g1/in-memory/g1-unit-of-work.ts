import type {
  ExecutionGrant,
  ExecutionRecord,
  IdempotencyEntry,
  IdempotencyKey,
  IdempotencyState,
} from "@/core/g1";
import type {
  GrantRepository,
  G1UnitOfWork,
  IdempotencyStore,
  ExecutionRecordStore,
} from "@/server/g1/ports";

import { InMemoryGrantRepository } from "./in-memory-grant-repository";
import { InMemoryIdempotencyStore } from "./in-memory-idempotency-store";
import { InMemoryExecutionRecordStore } from "./in-memory-execution-record-store";

/**
 * G1UnitOfWork in-memory — transaction autour des stores.
 *
 * - begin() : checkpoint de l'état courant
 * - commit() : valide les changements, jette le checkpoint
 * - rollback() : restaure le checkpoint, annule toute mutation
 *
 * Le snapshot capture l'état des trois stores au moment de begin().
 * Toute mutation entre begin() et commit()/rollback() est soit
 * validée (commit) soit annulée (rollback).
 */
export class InMemoryG1UnitOfWork implements G1UnitOfWork {
  readonly grants: GrantRepository;
  readonly idempotency: IdempotencyStore;
  readonly records: ExecutionRecordStore;

  private innerGrants: InMemoryGrantRepository;
  private innerIdempotency: InMemoryIdempotencyStore;
  private innerRecords: InMemoryExecutionRecordStore;

  private snapshotGrants: Map<string, ExecutionGrant> | null = null;
  private snapshotIdempotency: Map<string, IdempotencyEntry> | null = null;
  private snapshotRecords: Map<string, ExecutionRecord> | null = null;

  constructor() {
    this.innerGrants = new InMemoryGrantRepository();
    this.innerIdempotency = new InMemoryIdempotencyStore();
    this.innerRecords = new InMemoryExecutionRecordStore();

    this.grants = this.innerGrants;
    this.idempotency = this.innerIdempotency;
    this.records = this.innerRecords;
  }

  async begin(): Promise<void> {
    this.snapshotGrants = this.innerGrants._snapshot();
    this.snapshotIdempotency = this.innerIdempotency._snapshot();
    this.snapshotRecords = this.innerRecords._snapshot();
  }

  async commit(): Promise<void> {
    this.snapshotGrants = null;
    this.snapshotIdempotency = null;
    this.snapshotRecords = null;
  }

  async rollback(): Promise<void> {
    if (this.snapshotGrants !== null) {
      this.innerGrants._restore(this.snapshotGrants);
      this.snapshotGrants = null;
    }
    if (this.snapshotIdempotency !== null) {
      this.innerIdempotency._restore(this.snapshotIdempotency);
      this.snapshotIdempotency = null;
    }
    if (this.snapshotRecords !== null) {
      this.innerRecords._restore(this.snapshotRecords);
      this.snapshotRecords = null;
    }
  }
}
