import {
  eq,
  and,
  asc,
  inArray,
  isNull,
  lt,
  lte,
  or,
  gt,
  sql,
} from "drizzle-orm";

import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

import type {
  Database,
} from "@/server/database/client";

import {
  autonomousMissionRuntime,
} from "@/server/database/schema";

function mapRow(
  row: typeof autonomousMissionRuntime.$inferSelect,
): AutonomousMissionRuntime {
  return {
    missionId: row.missionId,

    state:
      row.state as AutonomousMissionRuntime["state"],

    startedAt: row.startedAt,
    updatedAt: row.updatedAt,

    lastHeartbeatAt:
      row.lastHeartbeatAt,

    lastProgressAt:
      row.lastProgressAt,

    cycleCount: row.cycleCount,
    replanCount: row.replanCount,
    stagnationCount:
      row.stagnationCount,

    maxCycles: row.maxCycles,
    maxReplans: row.maxReplans,
    maxRuntimeMs:
      row.maxRuntimeMs,

    maxStagnationCycles:
      row.maxStagnationCycles,

    lastFingerprint:
      row.lastFingerprint ?? undefined,

    lastReason:
      row.lastReason ?? undefined,

    ownerToken: row.ownerToken ?? null,
    leaseUntil:
      row.leaseUntil
        ? new Date(row.leaseUntil)
        : null,
    workerId: row.workerId ?? null,
    workspaceId: row.workspaceId ?? null,
    attemptId: row.attemptId ?? null,
    workflowId: row.workflowId ?? null,
  };
}

function toRow(
  runtime: AutonomousMissionRuntime,
): typeof autonomousMissionRuntime.$inferInsert {
  return {
    missionId: runtime.missionId,

    state: runtime.state,

    startedAt: runtime.startedAt,
    updatedAt: runtime.updatedAt,

    lastHeartbeatAt:
      runtime.lastHeartbeatAt,

    lastProgressAt:
      runtime.lastProgressAt,

    cycleCount: runtime.cycleCount,
    replanCount: runtime.replanCount,
    stagnationCount:
      runtime.stagnationCount,

    maxCycles: runtime.maxCycles,
    maxReplans: runtime.maxReplans,
    maxRuntimeMs:
      runtime.maxRuntimeMs,

    maxStagnationCycles:
      runtime.maxStagnationCycles,

    lastFingerprint:
      runtime.lastFingerprint ?? null,

    lastReason:
      runtime.lastReason ?? null,

    ownerToken: runtime.ownerToken,
    leaseUntil: runtime.leaseUntil ?? null,
    workerId: runtime.workerId ?? null,
    workspaceId: runtime.workspaceId ?? null,
    attemptId: runtime.attemptId ?? null,
    workflowId: runtime.workflowId ?? null,
  };
}
export class PostgresAutonomousMissionRuntimeRepository
  implements AutonomousMissionRuntimeRepository
{
  constructor(
    private readonly db: Database,
  ) {}

  async create(
    runtime: AutonomousMissionRuntime,
  ): Promise<void> {
    await this.db
      .insert(autonomousMissionRuntime)
      .values(toRow(runtime));
  }

  async createIfAbsent(
    runtime: AutonomousMissionRuntime,
  ): Promise<boolean> {
    const rows =
      await this.db
        .insert(
          autonomousMissionRuntime,
        )
        .values(
          toRow(runtime),
        )
        .onConflictDoNothing({
          target:
            autonomousMissionRuntime
              .missionId,
        })
        .returning({
          missionId:
            autonomousMissionRuntime
              .missionId,
        });

    return rows.length === 1;
  }

  async get(
    missionId: string,
  ): Promise<
    AutonomousMissionRuntime | null
  > {
    const rows =
      await this.db
        .select()
        .from(
          autonomousMissionRuntime,
        )
        .where(
          eq(
            autonomousMissionRuntime
              .missionId,
            missionId,
          ),
        )
        .limit(1);

    return rows[0]
      ? mapRow(rows[0])
      : null;
  }

  async listRecoverable(
    limit = 100,
  ): Promise<
    AutonomousMissionRuntime[]
  > {
    if (
      !Number.isInteger(limit) ||
      limit <= 0
    ) {
      throw new Error(
        "AUTONOMOUS_RUNTIME_INVALID_RECOVERY_LIMIT",
      );
    }

    const rows =
      await this.db
        .select()
        .from(
          autonomousMissionRuntime,
        )
        .where(
          and(
            inArray(
              autonomousMissionRuntime.state,
              [
                "running",
                "replanning",
              ],
            ),
            or(
              isNull(
                autonomousMissionRuntime.ownerToken,
              ),
              isNull(
                autonomousMissionRuntime.leaseUntil,
              ),
              lte(
                autonomousMissionRuntime.leaseUntil,
                sql`now()`,
              ),
            ),
          ),
        )
        .orderBy(
          asc(
            autonomousMissionRuntime
              .lastHeartbeatAt,
          ),
        )
        .limit(limit);

    return rows.map(mapRow);
  }

  async save(
    runtime: AutonomousMissionRuntime,
  ): Promise<void> {
    const rows =
      await this.db
        .update(
          autonomousMissionRuntime,
        )
        .set({
          state:
            runtime.state,

          updatedAt:
            runtime.updatedAt,

          lastHeartbeatAt:
            runtime.lastHeartbeatAt,

          lastProgressAt:
            runtime.lastProgressAt,

          cycleCount:
            runtime.cycleCount,

          replanCount:
            runtime.replanCount,

          stagnationCount:
            runtime.stagnationCount,

          maxCycles:
            runtime.maxCycles,

          maxReplans:
            runtime.maxReplans,

          maxRuntimeMs:
            runtime.maxRuntimeMs,

          maxStagnationCycles:
            runtime.maxStagnationCycles,

          lastFingerprint:
            runtime.lastFingerprint ?? null,

          lastReason:
            runtime.lastReason ?? null,
        })
        .where(
          eq(
            autonomousMissionRuntime
              .missionId,
            runtime.missionId,
          ),
        )
        .returning({
          missionId:
            autonomousMissionRuntime
              .missionId,
        });

    if (rows.length !== 1) {
      throw new Error(
        `AUTONOMOUS_RUNTIME_NOT_FOUND:` +
          runtime.missionId,
      );
    }
  }

  async claim(
    missionId: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (
      !Number.isFinite(leaseMs) ||
      leaseMs <= 0
    ) {
      throw new Error(
        "AUTONOMOUS_RUNTIME_INVALID_LEASE",
      );
    }

    const now = new Date();

    const leaseUntil =
      new Date(
        now.getTime() + leaseMs,
      );

    const rows =
      await this.db
        .update(
          autonomousMissionRuntime,
        )
        .set({
          ownerToken,
          leaseUntil,
        })
        .where(
          and(
            eq(
              autonomousMissionRuntime.missionId,
              missionId,
            ),
            or(
              isNull(
                autonomousMissionRuntime.ownerToken,
              ),
              isNull(
                autonomousMissionRuntime.leaseUntil,
              ),
              lt(
                autonomousMissionRuntime.leaseUntil,
                now,
              ),
              eq(
                autonomousMissionRuntime.ownerToken,
                ownerToken,
              ),
            ),
          ),
        )
        .returning({
          missionId:
            autonomousMissionRuntime.missionId,
        });

    return rows.length === 1;
  }

  async release(
    missionId: string,
    ownerToken: string,
  ): Promise<void> {
    await this.db
      .update(
        autonomousMissionRuntime,
      )
      .set({
        ownerToken: null,
        leaseUntil: null,
      })
      .where(
        and(
          eq(
            autonomousMissionRuntime.missionId,
            missionId,
          ),
          eq(
            autonomousMissionRuntime.ownerToken,
            ownerToken,
          ),
        ),
      );
  }

  async saveOwned(
    runtime: AutonomousMissionRuntime,
    ownerToken: string,
  ): Promise<void> {
    const now = new Date();

    const rows =
      await this.db
        .update(autonomousMissionRuntime)
        .set({
          state: runtime.state,
          startedAt: runtime.startedAt,
          updatedAt: runtime.updatedAt,
          lastHeartbeatAt: runtime.lastHeartbeatAt,
          lastProgressAt: runtime.lastProgressAt,
          cycleCount: runtime.cycleCount,
          replanCount: runtime.replanCount,
          stagnationCount: runtime.stagnationCount,
          maxCycles: runtime.maxCycles,
          maxReplans: runtime.maxReplans,
          maxRuntimeMs: runtime.maxRuntimeMs,
          maxStagnationCycles: runtime.maxStagnationCycles,
          lastFingerprint: runtime.lastFingerprint ?? null,
          lastReason: runtime.lastReason ?? null,
        })
        .where(
          and(
            eq(autonomousMissionRuntime.missionId, runtime.missionId),
            eq(autonomousMissionRuntime.ownerToken, ownerToken),
            gt(autonomousMissionRuntime.leaseUntil, now),
          ),
        )
        .returning({ missionId: autonomousMissionRuntime.missionId });

    if (rows.length !== 1) {
      throw new Error("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
    }
  }

  async renewClaim(
    missionId: string,
    ownerToken: string,
    leaseMs: number,
  ): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("AUTONOMOUS_RUNTIME_INVALID_LEASE");
    }

    const now = new Date();
    const leaseUntil = new Date(now.getTime() + leaseMs);

    const rows =
      await this.db
        .update(autonomousMissionRuntime)
        .set({
          ownerToken,
          leaseUntil,
        })
        .where(
          and(
            eq(autonomousMissionRuntime.missionId, missionId),
            eq(autonomousMissionRuntime.ownerToken, ownerToken),
            gt(autonomousMissionRuntime.leaseUntil, now),
          ),
        )
        .returning({ missionId: autonomousMissionRuntime.missionId });

    return rows.length === 1;
  }
}