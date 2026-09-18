import type {
  AutonomousMissionRuntime,
  AutonomousMissionRuntimeRepository,
} from "@/server/autonomy/runtime";

/**
 * Phase 6 — In-memory autonomous runtime repository.
 *
 * Faithful in-memory analogue of PostgresAutonomousMissionRuntimeRepository for
 * deterministic E2E and concurrency proofs. It enforces the same ownership /
 * lease / fencing contract:
 *   - createIfAbsent is a no-op when a runtime already exists;
 *   - claim() succeeds only when unowned or the lease has expired;
 *   - saveOwned() and renewClaim() fail closed when the caller is not the
 *     current, non-expired owner;
 *   - listRecoverable() excludes terminal and legitimately `waiting` runtimes.
 *
 * A single mutable Map is the store; every returned value is deep-cloned so a
 * caller cannot mutate persisted state by reference.
 */
const TERMINAL_STATES = new Set<AutonomousMissionRuntime["state"]>([
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "escalated",
]);

function clone(runtime: AutonomousMissionRuntime): AutonomousMissionRuntime {
  return {
    ...runtime,
    startedAt: new Date(runtime.startedAt),
    updatedAt: new Date(runtime.updatedAt),
    lastHeartbeatAt: new Date(runtime.lastHeartbeatAt),
    lastProgressAt: new Date(runtime.lastProgressAt),
    leaseUntil: runtime.leaseUntil ? new Date(runtime.leaseUntil) : runtime.leaseUntil,
  };
}

export class InMemoryAutonomousMissionRuntimeRepository implements AutonomousMissionRuntimeRepository {
  private readonly runtimes = new Map<string, AutonomousMissionRuntime>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async create(runtime: AutonomousMissionRuntime): Promise<void> {
    if (this.runtimes.has(runtime.missionId)) {
      throw new Error(`AUTONOMOUS_RUNTIME_ALREADY_EXISTS:${runtime.missionId}`);
    }
    this.runtimes.set(runtime.missionId, clone(runtime));
  }

  async createIfAbsent(runtime: AutonomousMissionRuntime): Promise<boolean> {
    if (this.runtimes.has(runtime.missionId)) {
      return false;
    }
    this.runtimes.set(runtime.missionId, clone(runtime));
    return true;
  }

  async get(missionId: string): Promise<AutonomousMissionRuntime | null> {
    const runtime = this.runtimes.get(missionId);
    return runtime ? clone(runtime) : null;
  }

  async listRecoverable(limit = 100): Promise<AutonomousMissionRuntime[]> {
    const nowMs = this.now().getTime();
    return [...this.runtimes.values()]
      .filter((runtime) => {
        if (TERMINAL_STATES.has(runtime.state)) return false;
        // `waiting` runtimes resume through event-driven callbacks, not sweeps.
        if (runtime.state === "waiting") return false;
        const leaseExpired = !runtime.leaseUntil || runtime.leaseUntil.getTime() <= nowMs;
        return leaseExpired;
      })
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
      .slice(0, limit)
      .map(clone);
  }

  async save(runtime: AutonomousMissionRuntime): Promise<void> {
    this.runtimes.set(runtime.missionId, clone(runtime));
  }

  async claim(missionId: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("AUTONOMOUS_RUNTIME_INVALID_LEASE");
    }
    const runtime = this.runtimes.get(missionId);
    if (!runtime) return false;

    const nowMs = this.now().getTime();
    const heldByOther =
      runtime.ownerToken &&
      runtime.ownerToken !== ownerToken &&
      runtime.leaseUntil &&
      runtime.leaseUntil.getTime() > nowMs;
    if (heldByOther) return false;

    this.runtimes.set(missionId, {
      ...runtime,
      ownerToken,
      leaseUntil: new Date(nowMs + leaseMs),
    });
    return true;
  }

  async release(missionId: string, ownerToken: string): Promise<void> {
    const runtime = this.runtimes.get(missionId);
    if (!runtime || runtime.ownerToken !== ownerToken) return;
    this.runtimes.set(missionId, {
      ...runtime,
      ownerToken: null,
      leaseUntil: null,
    });
  }

  async saveOwned(runtime: AutonomousMissionRuntime, ownerToken: string): Promise<void> {
    const existing = this.runtimes.get(runtime.missionId);
    if (!this.isOwner(existing, ownerToken)) {
      throw new Error("AUTONOMOUS_RUNTIME_OWNERSHIP_LOST");
    }
    this.runtimes.set(runtime.missionId, {
      ...clone(runtime),
      ownerToken,
      leaseUntil: existing?.leaseUntil ?? null,
    });
  }

  async renewClaim(missionId: string, ownerToken: string, leaseMs: number): Promise<boolean> {
    if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
      throw new Error("AUTONOMOUS_RUNTIME_INVALID_LEASE");
    }
    const runtime = this.runtimes.get(missionId);
    if (!this.isOwner(runtime, ownerToken)) return false;
    this.runtimes.set(missionId, {
      ...runtime!,
      leaseUntil: new Date(this.now().getTime() + leaseMs),
    });
    return true;
  }

  private isOwner(runtime: AutonomousMissionRuntime | undefined, ownerToken: string): boolean {
    return Boolean(
      runtime &&
      runtime.ownerToken === ownerToken &&
      runtime.leaseUntil &&
      runtime.leaseUntil.getTime() > this.now().getTime(),
    );
  }
}
