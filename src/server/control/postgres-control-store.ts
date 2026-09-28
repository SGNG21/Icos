import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { auditEntrySchema, type AuditEntry } from "@/core/contracts";
import type {
  CommandStatus,
  ControlCommandType,
  ControlTargetKind,
  ReauthStatus,
  RejectionCode,
  RiskClass,
  RuntimeFlags,
} from "@/core/control/contracts";
import type { ProofCheck } from "@/core/control/policy";
import type { Database } from "@/server/database/client";
import { auditToRow } from "@/server/database/mappers";
import {
  auditEntries,
  controlCommands,
  controlReauthProofs,
  controlStateVersions,
  missionControlHolds,
  runtimeControlFlags,
} from "@/server/database/schema";

import type { CommandRecord, ControlStore, ControlTx, ReauthProofRecord } from "./ports";

type Executor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

const FLAGS_ID = "global";

/**
 * PostgreSQL control store (decision 0044, migration 0048).
 *
 * One command = one transaction. `pg_advisory_xact_lock` on the command id
 * serializes duplicate requests (idempotency); `SELECT … FOR UPDATE` on the
 * target's version row serializes conflicting commands (BR-11). Everything a
 * command writes — its record, its audit entry, the version, holds and flags —
 * commits or rolls back together.
 */
export class PostgresControlStore implements ControlStore {
  constructor(private readonly db: Database) {}

  async transaction<T>(commandId: string, fn: (tx: ControlTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`control:${commandId}`}, 0))`,
      );
      return fn(this.txOps(tx as unknown as Executor));
    });
  }

  private txOps(tx: Executor): ControlTx {
    return {
      getCommand: (id) => readCommand(tx, id),
      saveCommand: async (r) => {
        const row = toRow(r);
        await tx
          .insert(controlCommands)
          .values(row)
          .onConflictDoUpdate({
            target: controlCommands.commandId,
            set: {
              status: row.status,
              reauth: row.reauth,
              rejectionCode: row.rejectionCode,
              rejectionMessage: row.rejectionMessage,
              version: row.version,
              auditEntryId: row.auditEntryId,
              completedAt: row.completedAt,
            },
          });
      },
      lockVersion: async (kind, id) => {
        await tx
          .insert(controlStateVersions)
          .values({ targetKind: kind, targetId: id, version: 0 })
          .onConflictDoNothing();
        const rows = await tx
          .select({ version: controlStateVersions.version })
          .from(controlStateVersions)
          .where(
            and(eq(controlStateVersions.targetKind, kind), eq(controlStateVersions.targetId, id)),
          )
          .for("update");
        return rows[0].version;
      },
      setVersion: async (kind, id, version) => {
        await tx
          .update(controlStateVersions)
          .set({ version, updatedAt: new Date() })
          .where(
            and(eq(controlStateVersions.targetKind, kind), eq(controlStateVersions.targetId, id)),
          );
      },
      isHeld: (missionId) => isHeld(tx, missionId),
      setHold: async (missionId, commandId, at) => {
        await tx
          .insert(missionControlHolds)
          .values({ missionId, heldByCommandId: commandId, heldAt: new Date(at) });
      },
      clearHold: async (missionId) => {
        await tx.delete(missionControlHolds).where(eq(missionControlHolds.missionId, missionId));
      },
      getFlags: () => readFlags(tx, true),
      setFlags: async (f, commandId, at) => {
        const updated = await tx
          .update(runtimeControlFlags)
          .set({
            safeMode: f.safeMode,
            dispatchEnabled: f.dispatchEnabled,
            integrationEnabled: f.integrationEnabled,
            externalActionsEnabled: f.externalActionsEnabled,
            updatedAt: new Date(at),
            updatedByCommandId: commandId,
          })
          .where(eq(runtimeControlFlags.id, FLAGS_ID))
          .returning({ id: runtimeControlFlags.id });
        if (updated.length !== 1) throw new Error("RUNTIME_CONTROL_FLAGS_MISSING");
      },
      checkProof: async (tokenHash, userId, sessionId, now): Promise<ProofCheck> => {
        const [p] = await tx
          .select()
          .from(controlReauthProofs)
          .where(eq(controlReauthProofs.tokenHash, tokenHash));
        if (!p || p.userId !== userId || p.sessionId !== sessionId || p.consumedAt)
          return "invalid";
        return p.expiresAt.getTime() <= now.getTime() ? "expired" : "valid";
      },
      consumeProof: async (tokenHash, at) => {
        const rows = await tx
          .update(controlReauthProofs)
          .set({ consumedAt: new Date(at) })
          .where(
            and(
              eq(controlReauthProofs.tokenHash, tokenHash),
              isNull(controlReauthProofs.consumedAt),
            ),
          )
          .returning({ id: controlReauthProofs.id });
        return rows.length === 1;
      },
      appendAudit: async (entry: AuditEntry) => {
        await tx.insert(auditEntries).values(auditToRow(auditEntrySchema.parse(entry)));
      },
    };
  }

  getCommand(commandId: string) {
    return readCommand(this.db, commandId);
  }

  readFlags() {
    return readFlags(this.db, false);
  }

  isHeld(missionId: string) {
    return isHeld(this.db, missionId);
  }

  async readVersions(kind: ControlTargetKind, ids: readonly string[]) {
    const out = new Map(ids.map((id) => [id, 0]));
    if (ids.length === 0) return out;
    const rows = await this.db
      .select()
      .from(controlStateVersions)
      .where(
        and(
          eq(controlStateVersions.targetKind, kind),
          inArray(controlStateVersions.targetId, [...ids]),
        ),
      );
    for (const r of rows) out.set(r.targetId, r.version);
    return out;
  }

  async listHeldMissionIds() {
    return (
      await this.db.select({ id: missionControlHolds.missionId }).from(missionControlHolds)
    ).map((r) => r.id);
  }

  async insertReauthProof(r: ReauthProofRecord) {
    await this.db.insert(controlReauthProofs).values({
      id: r.id,
      tokenHash: r.tokenHash,
      userId: r.userId,
      sessionId: r.sessionId,
      createdAt: new Date(r.createdAt),
      expiresAt: new Date(r.expiresAt),
    });
  }
}

async function readCommand(db: Executor, commandId: string): Promise<CommandRecord | null> {
  const [row] = await db
    .select()
    .from(controlCommands)
    .where(eq(controlCommands.commandId, commandId));
  return row ? fromRow(row) : null;
}

async function isHeld(db: Executor, missionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: missionControlHolds.missionId })
    .from(missionControlHolds)
    .where(eq(missionControlHolds.missionId, missionId));
  return rows.length > 0;
}

/** Throws when the single flags row is absent: the runtime must fail closed. */
async function readFlags(db: Executor, forUpdate: boolean): Promise<RuntimeFlags> {
  const query = db.select().from(runtimeControlFlags).where(eq(runtimeControlFlags.id, FLAGS_ID));
  const [row] = forUpdate ? await query.for("update") : await query;
  if (!row) throw new Error("RUNTIME_CONTROL_FLAGS_MISSING");
  return {
    safeMode: row.safeMode,
    dispatchEnabled: row.dispatchEnabled,
    integrationEnabled: row.integrationEnabled,
    externalActionsEnabled: row.externalActionsEnabled,
  };
}

function toRow(r: CommandRecord): typeof controlCommands.$inferInsert {
  return {
    commandId: r.commandId,
    actorUserId: r.actorUserId,
    idempotencyKey: r.idempotencyKey,
    requestHash: r.requestHash,
    commandType: r.type,
    targetKind: r.targetKind,
    targetId: r.targetId,
    riskClass: r.riskClass,
    reason: r.reason,
    expectedVersion: r.expectedVersion,
    status: r.status,
    reauth: r.reauth,
    rejectionCode: r.rejectionCode,
    rejectionMessage: r.rejectionMessage,
    version: r.version,
    auditEntryId: r.auditEntryId,
    createdAt: new Date(r.createdAt),
    completedAt: r.completedAt ? new Date(r.completedAt) : null,
  };
}

function fromRow(row: typeof controlCommands.$inferSelect): CommandRecord {
  return {
    commandId: row.commandId,
    actorUserId: row.actorUserId,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    type: row.commandType as ControlCommandType,
    targetKind: row.targetKind as ControlTargetKind,
    targetId: row.targetId,
    riskClass: row.riskClass as RiskClass,
    reason: row.reason,
    expectedVersion: row.expectedVersion,
    status: row.status as CommandStatus | "ADMITTED",
    reauth: row.reauth as ReauthStatus,
    rejectionCode: row.rejectionCode as RejectionCode | null,
    rejectionMessage: row.rejectionMessage,
    version: row.version,
    auditEntryId: row.auditEntryId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
