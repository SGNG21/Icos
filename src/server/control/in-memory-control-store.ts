import type { AuditEntry } from "@/core/contracts";
import type { ControlTargetKind, RuntimeFlags } from "@/core/control/contracts";
import { DEFAULT_RUNTIME_FLAGS, type ProofCheck } from "@/core/control/policy";

import type { CommandRecord, ControlStore, ControlTx, ReauthProofRecord } from "./ports";

interface State {
  commands: Map<string, CommandRecord>;
  versions: Map<string, number>;
  holds: Map<string, string>;
  flags: RuntimeFlags;
  proofs: Map<string, ReauthProofRecord & { consumedAt: string | null }>;
}

const clone = (s: State): State => ({
  commands: new Map([...s.commands].map(([k, v]) => [k, { ...v }])),
  versions: new Map(s.versions),
  holds: new Map(s.holds),
  flags: { ...s.flags },
  proofs: new Map([...s.proofs].map(([k, v]) => [k, { ...v }])),
});

/**
 * In-memory control store: one global mutex (transactions run one at a time)
 * and copy-on-write state, so a throwing callback leaves nothing behind —
 * the same atomicity the PostgreSQL store gets from a transaction.
 * ponytail: global lock; fine for the memory backend and unit tests only.
 */
export class InMemoryControlStore implements ControlStore {
  private state: State = {
    commands: new Map(),
    versions: new Map(),
    holds: new Map(),
    flags: { ...DEFAULT_RUNTIME_FLAGS },
    proofs: new Map(),
  };
  private queue: Promise<unknown> = Promise.resolve();
  /** Audit entries written inside committed transactions (tests read them). */
  readonly audit: AuditEntry[] = [];
  /** Test hook: make reads fail to prove callers fail closed. */
  failReads = false;

  async transaction<T>(_commandId: string, fn: (tx: ControlTx) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const draft = clone(this.state);
      const pendingAudit: AuditEntry[] = [];
      const result = await fn(this.tx(draft, pendingAudit));
      this.state = draft;
      this.audit.push(...pendingAudit);
      return result;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private tx(s: State, audit: AuditEntry[]): ControlTx {
    const key = (kind: ControlTargetKind, id: string) => `${kind}:${id}`;
    return {
      getCommand: async (id) => (s.commands.has(id) ? { ...s.commands.get(id)! } : null),
      saveCommand: async (r) => void s.commands.set(r.commandId, { ...r }),
      lockVersion: async (kind, id) => {
        if (!s.versions.has(key(kind, id))) s.versions.set(key(kind, id), 0);
        return s.versions.get(key(kind, id))!;
      },
      setVersion: async (kind, id, v) => void s.versions.set(key(kind, id), v),
      isHeld: async (id) => s.holds.has(id),
      setHold: async (id, commandId) => void s.holds.set(id, commandId),
      clearHold: async (id) => void s.holds.delete(id),
      getFlags: async () => ({ ...s.flags }),
      setFlags: async (f) => void (s.flags = { ...f }),
      checkProof: async (hash, userId, sessionId, now): Promise<ProofCheck> => {
        const p = s.proofs.get(hash);
        if (!p || p.userId !== userId || p.sessionId !== sessionId || p.consumedAt) return "invalid";
        return Date.parse(p.expiresAt) <= now.getTime() ? "expired" : "valid";
      },
      consumeProof: async (hash, at) => {
        const p = s.proofs.get(hash);
        if (!p || p.consumedAt) return false;
        p.consumedAt = at;
        return true;
      },
      appendAudit: async (e) => void audit.push(e),
    };
  }

  private guard() {
    if (this.failReads) throw new Error("CONTROL_STORE_UNAVAILABLE");
  }

  async getCommand(id: string) {
    this.guard();
    return this.state.commands.has(id) ? { ...this.state.commands.get(id)! } : null;
  }
  async readFlags() {
    this.guard();
    return { ...this.state.flags };
  }
  async isHeld(missionId: string) {
    this.guard();
    return this.state.holds.has(missionId);
  }
  async readVersions(kind: ControlTargetKind, ids: readonly string[]) {
    this.guard();
    return new Map(ids.map((id) => [id, this.state.versions.get(`${kind}:${id}`) ?? 0]));
  }
  async listHeldMissionIds() {
    this.guard();
    return [...this.state.holds.keys()];
  }
  async insertReauthProof(r: ReauthProofRecord) {
    this.guard();
    this.state.proofs.set(r.tokenHash, { ...r, consumedAt: null });
  }
}
