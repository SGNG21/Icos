import { randomUUID } from "node:crypto";

import type {
  ExecutionGrant,
  ExecutionGrantStatus,
  ExecutionRecord,
  IdempotencyState,
} from "@/core/contracts/tool";
import { IDEMPOTENCY_TERMINAL, isIdempotencyTransitionAllowed } from "@/core/contracts/tool";
import type {
  ExecutionGrantRepository,
  ExecutionRecordRepository,
} from "@/server/repositories/tool-ports";

// ─────────────────────────────────────
// In-Memory Grant Repository
// ─────────────────────────────────────

export class InMemoryGrantRepository implements ExecutionGrantRepository {
  private readonly grants = new Map<string, ExecutionGrant>();

  async create(grant: ExecutionGrant): Promise<ExecutionGrant> {
    this.grants.set(grant.id, { ...grant });
    return grant;
  }

  async findById(id: string): Promise<ExecutionGrant | null> {
    return this.grants.get(id) ?? null;
  }

  async consume(id: string): Promise<boolean> {
    const grant = this.grants.get(id);
    if (!grant) return false;
    if (grant.status === "consumed" || grant.status === "expired") return false;
    if (new Date(grant.expiresAt) < new Date()) {
      this.grants.set(id, { ...grant, status: "expired" });
      return false;
    }
    this.grants.set(id, { ...grant, status: "consumed" });
    return true;
  }

  async expireStale(now: string): Promise<number> {
    let count = 0;
    for (const [id, grant] of this.grants) {
      if (grant.status === "issued" && new Date(grant.expiresAt) < new Date(now)) {
        this.grants.set(id, { ...grant, status: "expired" });
        count++;
      }
    }
    return count;
  }

  /** Réinitialisation pour les tests. */
  reset(): void {
    this.grants.clear();
  }
}

// ─────────────────────────────────────
// In-Memory Execution Record Repository
// ─────────────────────────────────────

export class InMemoryExecutionRecordRepository implements ExecutionRecordRepository {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly byKey = new Map<string, string>(); // idempotencyKey → record id

  async reserve(input: {
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
  }> {
    const existingId = this.byKey.get(input.idempotencyKey);
    if (existingId) {
      const existing = this.records.get(existingId)!;
      // Même requestHash → duplicate (supports replay from COMPLETED)
      if (existing.requestHash === input.requestHash) {
        return { reserved: false, record: existing };
      }
      // requestHash différent → idempotency conflict
      return { reserved: false, record: existing, conflict: "idempotency_conflict" };
    }

    const now = new Date().toISOString();
    const record: ExecutionRecord = {
      id: `exec-rec-${randomUUID().slice(0, 8)}`,
      idempotencyKey: input.idempotencyKey,
      grantId: input.grantId,
      tenantId: input.tenantId,
      missionId: input.missionId,
      runId: input.runId,
      toolId: input.toolId as ExecutionRecord["toolId"],
      requestHash: input.requestHash,
      state: "RESERVED",
      attempts: [],
      createdAt: now,
    };

    this.records.set(record.id, record);
    this.byKey.set(input.idempotencyKey, record.id);
    return { reserved: true, record };
  }

  async transitionState(
    idempotencyKey: string,
    expectedState: IdempotencyState,
    targetState: IdempotencyState,
    attempt?: { attemptNumber: number; startedAt: string; status: "executing" },
    error?: { code: string; message: string },
  ): Promise<{ ok: boolean; record?: ExecutionRecord }> {
    const recordId = this.byKey.get(idempotencyKey);
    if (!recordId) return { ok: false };

    const record = this.records.get(recordId)!;
    if (record.state !== expectedState) return { ok: false };
    if (!isIdempotencyTransitionAllowed(expectedState, targetState)) return { ok: false };

    const now = new Date().toISOString();
    const attempts = attempt ? [...record.attempts, {
      attemptNumber: attempt.attemptNumber,
      startedAt: attempt.startedAt,
      status: "executing" as const,
    }] : record.attempts;

    const updated: ExecutionRecord = {
      ...record,
      state: targetState,
      attempts,
      error: error ?? record.error,
      completedAt: IDEMPOTENCY_TERMINAL.includes(targetState) ? now : record.completedAt,
    };

    this.records.set(recordId, updated);
    return { ok: true, record: updated };
  }

  async complete(input: {
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
  }): Promise<{ ok: boolean; record?: ExecutionRecord }> {
    const recordId = this.byKey.get(input.idempotencyKey);
    if (!recordId) return { ok: false };

    const record = this.records.get(recordId)!;
    if (record.state !== "EXECUTING" && record.state !== "RESERVED") return { ok: false };
    if (!isIdempotencyTransitionAllowed(record.state, input.targetState)) return { ok: false };

    const now = new Date().toISOString();
    const attempts = [...record.attempts, {
      attemptNumber: input.attempt.attemptNumber,
      startedAt: input.attempt.startedAt,
      completedAt: input.attempt.completedAt,
      status: input.attempt.status,
      result: input.attempt.result,
      error: input.attempt.error,
    }];

    const updated: ExecutionRecord = {
      ...record,
      state: input.targetState,
      attempts,
      output: input.output ?? record.output,
      error: input.error ?? record.error,
      completedAt: now,
    };

    this.records.set(recordId, updated);
    return { ok: true, record: updated };
  }

  async findByIdempotencyKey(key: string): Promise<ExecutionRecord | null> {
    const recordId = this.byKey.get(key);
    if (!recordId) return null;
    return this.records.get(recordId) ?? null;
  }

  async findById(id: string): Promise<ExecutionRecord | null> {
    return this.records.get(id) ?? null;
  }

  async findStale(before: string): Promise<ExecutionRecord[]> {
    const result: ExecutionRecord[] = [];
    for (const record of this.records.values()) {
      if (
        (record.state === "RESERVED" || record.state === "EXECUTING") &&
        record.createdAt < before
      ) {
        result.push(record);
      }
    }
    return result;
  }

  /** Réinitialisation pour les tests. */
  reset(): void {
    this.records.clear();
    this.byKey.clear();
  }
}
