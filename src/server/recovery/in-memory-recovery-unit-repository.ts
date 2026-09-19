import type {
  RecoveryClaimResult,
  RecoveryUnitRef,
  RecoveryUnitRepository,
} from "@/core/contracts/recovery";

/** Backoff exponentiel plafonné : `base * 2^(échecs précédents)`, max 1 h (miroir de l'implémentation SQL). */
export const MAX_RECOVERY_BACKOFF_MS = 3_600_000;

interface Row {
  ownerToken: string | null;
  leaseUntil: number | null;
  attemptCount: number;
  resolved: boolean;
}

/** Implémentation Docker-free (tests unitaires, `PERSISTENCE=memory`). Horloge injectable. */
export class InMemoryRecoveryUnitRepository implements RecoveryUnitRepository {
  private readonly rows = new Map<string, Row>();

  constructor(private readonly now: () => number = Date.now) {}

  private id(unit: RecoveryUnitRef): string {
    return `${unit.kind}|${unit.key}`;
  }

  async claim(
    unit: RecoveryUnitRef,
    ownerToken: string,
    leaseMs: number,
    maxAttempts: number,
  ): Promise<RecoveryClaimResult> {
    const id = this.id(unit);
    const row = this.rows.get(id);
    if (row?.resolved) return "resolved";
    if (row && row.leaseUntil !== null && row.leaseUntil > this.now()) return "held";
    if (row && row.attemptCount >= maxAttempts) {
      row.resolved = true;
      return "exhausted";
    }
    this.rows.set(id, {
      ownerToken,
      leaseUntil: this.now() + leaseMs,
      attemptCount: row?.attemptCount ?? 0,
      resolved: false,
    });
    return "claimed";
  }

  private owned(unit: RecoveryUnitRef, ownerToken: string): Row | null {
    const row = this.rows.get(this.id(unit));
    return row && !row.resolved && row.ownerToken === ownerToken ? row : null;
  }

  async complete(unit: RecoveryUnitRef, ownerToken: string): Promise<boolean> {
    const row = this.owned(unit, ownerToken);
    if (!row) return false;
    Object.assign(row, { resolved: true, ownerToken: null, leaseUntil: null });
    return true;
  }

  async defer(
    unit: RecoveryUnitRef,
    ownerToken: string,
    _reason: string,
    cooldownMs: number,
  ): Promise<boolean> {
    const row = this.owned(unit, ownerToken);
    if (!row) return false;
    Object.assign(row, { ownerToken: null, leaseUntil: this.now() + cooldownMs });
    return true;
  }

  async fail(
    unit: RecoveryUnitRef,
    ownerToken: string,
    _errorCode: string,
    backoffMs: number,
  ): Promise<boolean> {
    const row = this.owned(unit, ownerToken);
    if (!row) return false;
    const delay = Math.min(backoffMs * 2 ** row.attemptCount, MAX_RECOVERY_BACKOFF_MS);
    row.attemptCount += 1;
    Object.assign(row, { ownerToken: null, leaseUntil: this.now() + delay });
    return true;
  }
}
