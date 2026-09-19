import { and, eq, sql } from "drizzle-orm";

import type {
  RecoveryClaimResult,
  RecoveryUnitRef,
  RecoveryUnitRepository,
} from "@/core/contracts/recovery";
import type { Database } from "@/server/database/client";
import { recoveryUnits } from "@/server/database/schema";
import { MAX_RECOVERY_BACKOFF_MS } from "@/server/recovery/in-memory-recovery-unit-repository";

const ms = (value: number) => sql`(${value} * interval '1 millisecond')`;

/** Toutes les comparaisons de temps utilisent `now()` PostgreSQL (aucune dérive entre process). */
export class PostgresRecoveryUnitRepository implements RecoveryUnitRepository {
  constructor(private readonly db: Database) {}

  async claim(
    unit: RecoveryUnitRef,
    ownerToken: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<RecoveryClaimResult> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("RECOVERY_INVALID_LEASE");

    // Atomic: exactly one concurrent claimant wins (row insert or guarded update).
    const claimed = await this.db
      .insert(recoveryUnits)
      .values({
        kind: unit.kind,
        unitKey: unit.key,
        missionId: unit.missionId,
        ownerToken,
        leaseUntil: sql`now() + ${ms(leaseMs)}`,
      })
      .onConflictDoUpdate({
        target: [recoveryUnits.kind, recoveryUnits.unitKey],
        set: { ownerToken, leaseUntil: sql`now() + ${ms(leaseMs)}`, updatedAt: sql`now()` },
        setWhere: sql`${recoveryUnits.resolvedAt} is null
          and (${recoveryUnits.leaseUntil} is null or ${recoveryUnits.leaseUntil} <= now())
          and ${recoveryUnits.attemptCount} < ${maxAttempts}`,
      })
      .returning({ kind: recoveryUnits.kind });
    if (claimed.length === 1) return "claimed";

    const identity = and(eq(recoveryUnits.kind, unit.kind), eq(recoveryUnits.unitKey, unit.key));
    // Not claimable: exhausted (lease free, budget spent) → declare it once; otherwise resolved/held.
    const exhausted = await this.db
      .update(recoveryUnits)
      .set({
        resolvedAt: sql`now()`,
        outcome: "EXHAUSTED",
        ownerToken: null,
        leaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          identity,
          sql`${recoveryUnits.resolvedAt} is null`,
          sql`(${recoveryUnits.leaseUntil} is null or ${recoveryUnits.leaseUntil} <= now())`,
          sql`${recoveryUnits.attemptCount} >= ${maxAttempts}`,
        ),
      )
      .returning({ kind: recoveryUnits.kind });
    if (exhausted.length === 1) return "exhausted";

    const row = await this.db
      .select({ resolvedAt: recoveryUnits.resolvedAt })
      .from(recoveryUnits)
      .where(identity)
      .limit(1);
    return row[0]?.resolvedAt ? "resolved" : "held";
  }

  private ownedBy(unit: RecoveryUnitRef, ownerToken: string) {
    return and(
      eq(recoveryUnits.kind, unit.kind),
      eq(recoveryUnits.unitKey, unit.key),
      eq(recoveryUnits.ownerToken, ownerToken),
      sql`${recoveryUnits.resolvedAt} is null`,
    );
  }

  async complete(unit: RecoveryUnitRef, ownerToken: string, outcome: string): Promise<boolean> {
    const rows = await this.db
      .update(recoveryUnits)
      .set({
        resolvedAt: sql`now()`,
        outcome,
        ownerToken: null,
        leaseUntil: null,
        updatedAt: sql`now()`,
      })
      .where(this.ownedBy(unit, ownerToken))
      .returning({ kind: recoveryUnits.kind });
    return rows.length === 1;
  }

  async defer(
    unit: RecoveryUnitRef,
    ownerToken: string,
    reason: string,
    cooldownMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(recoveryUnits)
      .set({
        outcome: reason,
        ownerToken: null,
        leaseUntil: sql`now() + ${ms(cooldownMs)}`,
        updatedAt: sql`now()`,
      })
      .where(this.ownedBy(unit, ownerToken))
      .returning({ kind: recoveryUnits.kind });
    return rows.length === 1;
  }

  async fail(
    unit: RecoveryUnitRef,
    ownerToken: string,
    errorCode: string,
    backoffMs: number,
  ): Promise<boolean> {
    const rows = await this.db
      .update(recoveryUnits)
      .set({
        attemptCount: sql`${recoveryUnits.attemptCount} + 1`,
        lastError: errorCode,
        ownerToken: null,
        // Backoff = base * 2^(previous failures), capped (mirrors the in-memory implementation).
        leaseUntil: sql`now() + least(${ms(backoffMs)} * power(2, ${recoveryUnits.attemptCount}), ${ms(MAX_RECOVERY_BACKOFF_MS)})`,
        updatedAt: sql`now()`,
      })
      .where(this.ownedBy(unit, ownerToken))
      .returning({ kind: recoveryUnits.kind });
    return rows.length === 1;
  }
}
