import type {
  AttentionClass,
  Disposition,
  GoalProposal,
  Severity,
  SituationState,
  SupervisorEvent,
} from "@/core/supervisor/contracts";

/**
 * Persistence port of the Proactive Supervisor (decision 0055). The decision logic
 * lives ONCE in `ProactiveSupervisor`; a store only offers primitives inside a
 * per-tenant serialized transaction. PostgreSQL is the production store; the
 * in-memory one exists for Docker-free unit tests and runs the same contract.
 */

export interface StoredEvent extends SupervisorEvent {
  id: string;
  observedAt: Date;
  fingerprint: string | null;
  situationId: string | null;
  disposition: Disposition;
  initiativeLevel: string;
  policyVersion: string;
  reasons: string[];
}

export interface Situation {
  id: string;
  tenantId: string;
  clientScope?: string;
  projectScope?: string;
  fingerprint: string;
  domain: string;
  eventType: string;
  subject: string;
  kind: "problem" | "opportunity" | "information";
  state: SituationState;
  severity: Severity;
  eventCount: number;
  maxAttention: AttentionClass | null;
  sourceEventId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  closedAt?: Date;
  closedBy?: string;
  resolution?: string;
}

export type ProposalState =
  | "pending"
  | "delivering"
  | "awaiting_human"
  | "submitted"
  | "not_connected"
  | "denied"
  | "failed"
  | "cancelled";

export interface ProposalRecord {
  proposal: GoalProposal;
  domain: string;
  state: ProposalState;
  externalRef?: string;
  createdAt: Date;
  settledAt?: Date;
  attempts?: number;
  lastError?: string;
  claimedUntil?: Date;
}

export type AttentionState =
  "pending" | "delivering" | "delivered" | "not_connected" | "denied" | "failed";

export interface AttentionRecord {
  id: string;
  tenantId: string;
  situationId: string;
  attentionClass: AttentionClass;
  channels: string[];
  state: AttentionState;
  createdAt: Date;
  settledAt?: Date;
  attempts?: number;
  lastError?: string;
  claimedUntil?: Date;
}

/** Outbox delivery: claim (lease) → settle, or fail (retry until `maxAttempts`, then `failed`). */
export interface Outbox<R, S> {
  claim(limit: number, leaseMs: number): Promise<R[]>;
  /** Only from `delivering`: a lost lease cannot settle. */
  settle(id: string, state: S, externalRef?: string): Promise<boolean>;
  fail(id: string, error: string, maxAttempts: number): Promise<"pending" | "failed" | null>;
}

export interface SupervisorTx {
  /** The store's clock (PostgreSQL `now()` in production): one clock for every window. */
  now(): Promise<Date>;
  findEventByDedup(tenantId: string, source: string, dedupKey: string): Promise<StoredEvent | null>;
  findOpenSituation(tenantId: string, fingerprint: string): Promise<Situation | null>;
  findLastTerminalSituation(tenantId: string, fingerprint: string): Promise<Situation | null>;
  countSituationsSince(tenantId: string, domain: string, since: Date): Promise<number>;
  countExecutionsSince(
    tenantId: string,
    domain: string,
    action: string,
    since: Date,
  ): Promise<number>;
  insertSituation(situation: Situation): Promise<void>;
  /** Aggregation only: count, last seen, severity, max attention. Never the state. */
  updateOpenSituation(situation: Situation): Promise<void>;
  insertEvent(event: StoredEvent): Promise<void>;
  /** False when the situation already has a proposal (one per situation). */
  insertProposalIfAbsent(record: ProposalRecord): Promise<boolean>;
  /** False when this class was already raised for the situation. */
  insertAttentionIfAbsent(record: AttentionRecord): Promise<boolean>;
  /** Closes a quiet open situation (and cancels its undelivered proposal). */
  closeStaleSituation(id: string, resolution: string): Promise<void>;
}

export interface SupervisorDigest {
  situations: Array<Situation & { proposal: ProposalRecord | null }>;
  eventCount: number;
  ignoredCount: number;
}

export interface SupervisorStore {
  /** Serialized per tenant: flood bounds and budgets are exact, not approximate. */
  transact<T>(tenantId: string, fn: (tx: SupervisorTx) => Promise<T>): Promise<T>;
  /** Only CREATE_BOUNDED_GOAL proposals of OPEN situations are ever claimable. */
  proposals: Outbox<ProposalRecord, ProposalState>;
  attention: Outbox<AttentionRecord, AttentionState>;
  getSituation(tenantId: string, id: string): Promise<Situation | null>;
  /**
   * open → resolved|dismissed only. False if not open (terminal is never reopened).
   * Cancels the situation's undelivered or awaiting proposal in the same step.
   */
  closeSituation(
    tenantId: string,
    id: string,
    close: { state: "resolved" | "dismissed"; by: string; resolution: string },
  ): Promise<boolean>;
  listEvents(tenantId: string, situationId: string): Promise<StoredEvent[]>;
  digest(
    tenantId: string,
    window: { since: Date; until: Date; clientScope?: string },
  ): Promise<SupervisorDigest>;
}

/** Unit-test store. Same primitives, same uniqueness rules as the PostgreSQL one. */
export class InMemorySupervisorStore implements SupervisorStore {
  private readonly events: StoredEvent[] = [];
  private readonly situations = new Map<string, Situation>();
  private readonly proposals_ = new Map<string, ProposalRecord>();
  private readonly attention_ = new Map<string, AttentionRecord>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async transact<T>(tenantId: string, fn: (tx: SupervisorTx) => Promise<T>): Promise<T> {
    const previous = this.locks.get(tenantId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runAtomically(fn));
    this.locks.set(tenantId, run);
    return run;
  }

  /** All-or-nothing, like a rolled-back transaction: writes are staged, then applied. */
  private async runAtomically<T>(fn: (tx: SupervisorTx) => Promise<T>): Promise<T> {
    const staged: Array<() => void> = [];
    const stagedSituations = new Map<string, Situation>();
    const stagedProposals = new Set<string>();
    const stagedAttention = new Set<string>();
    const situation = (id: string) => stagedSituations.get(id) ?? this.situations.get(id);
    const allSituations = () => [
      ...[...this.situations.values()].filter((s) => !stagedSituations.has(s.id)),
      ...stagedSituations.values(),
    ];
    const tx: SupervisorTx = {
      now: async () => this.clock(),
      findEventByDedup: async (tenantId, source, dedupKey) =>
        this.events.find(
          (e) => e.tenantId === tenantId && e.source === source && e.dedupKey === dedupKey,
        ) ?? null,
      findOpenSituation: async (tenantId, fingerprint) =>
        allSituations().find(
          (s) => s.tenantId === tenantId && s.fingerprint === fingerprint && s.state === "open",
        ) ?? null,
      findLastTerminalSituation: async (tenantId, fingerprint) =>
        allSituations()
          .filter(
            (s) => s.tenantId === tenantId && s.fingerprint === fingerprint && s.state !== "open",
          )
          .sort((a, b) => b.closedAt!.getTime() - a.closedAt!.getTime())[0] ?? null,
      countSituationsSince: async (tenantId, domain, since) =>
        allSituations().filter(
          (s) => s.tenantId === tenantId && s.domain === domain && s.firstSeenAt >= since,
        ).length,
      countExecutionsSince: async (tenantId, domain, action, since) =>
        [...this.proposals_.values()].filter(
          (p) =>
            p.proposal.tenantId === tenantId &&
            p.domain === domain &&
            p.proposal.action === action &&
            p.proposal.disposition === "CREATE_BOUNDED_GOAL" &&
            p.createdAt >= since,
        ).length,
      insertSituation: async (s) => {
        if (
          allSituations().some(
            (o) =>
              o.tenantId === s.tenantId && o.fingerprint === s.fingerprint && o.state === "open",
          )
        ) {
          throw new Error("SUPERVISOR_OPEN_SITUATION_EXISTS");
        }
        stagedSituations.set(s.id, structuredClone(s));
      },
      updateOpenSituation: async (s) => {
        const current = situation(s.id);
        if (!current || current.state !== "open") throw new Error("SUPERVISOR_SITUATION_NOT_OPEN");
        stagedSituations.set(s.id, { ...current, ...pickAggregate(s) });
      },
      insertEvent: async (e) => {
        staged.push(() => this.events.push(structuredClone(e)));
      },
      insertProposalIfAbsent: async (r) => {
        const taken = [...this.proposals_.values()].some(
          (p) => p.proposal.situationId === r.proposal.situationId,
        );
        if (taken || stagedProposals.has(r.proposal.situationId)) return false;
        stagedProposals.add(r.proposal.situationId);
        staged.push(() => this.proposals_.set(r.proposal.id, structuredClone(r)));
        return true;
      },
      insertAttentionIfAbsent: async (r) => {
        const key = `${r.situationId}|${r.attentionClass}`;
        const taken = [...this.attention_.values()].some(
          (a) => `${a.situationId}|${a.attentionClass}` === key,
        );
        if (taken || stagedAttention.has(key)) return false;
        stagedAttention.add(key);
        staged.push(() => this.attention_.set(r.id, structuredClone(r)));
        return true;
      },
      closeStaleSituation: async (id, resolution) => {
        const current = situation(id);
        if (!current || current.state !== "open") throw new Error("SUPERVISOR_SITUATION_NOT_OPEN");
        stagedSituations.set(id, {
          ...current,
          state: "dismissed",
          closedBy: "supervisor:stale",
          resolution,
          closedAt: this.clock(),
        });
        staged.push(() => this.cancelProposals(id));
      },
    };
    const result = await fn(tx);
    for (const [id, s] of stagedSituations) this.situations.set(id, s);
    for (const apply of staged) apply();
    return result;
  }

  readonly proposals: Outbox<ProposalRecord, ProposalState> = this.outbox(
    () => [...this.proposals_.values()].map((p) => ({ record: p, id: p.proposal.id })),
    (p) =>
      p.proposal.disposition === "CREATE_BOUNDED_GOAL" &&
      this.situations.get(p.proposal.situationId)?.state === "open",
  );

  readonly attention: Outbox<AttentionRecord, AttentionState> = this.outbox(
    () => [...this.attention_.values()].map((a) => ({ record: a, id: a.id })),
    () => true,
  );

  private outbox<R extends ProposalRecord | AttentionRecord, S extends string>(
    all: () => Array<{ record: R; id: string }>,
    eligible: (record: R) => boolean,
  ): Outbox<R, S> {
    const find = (id: string) => all().find((x) => x.id === id)?.record;
    return {
      claim: async (limit, leaseMs) => {
        const now = this.clock();
        const due = all()
          .map((x) => x.record)
          .filter(
            (r) =>
              eligible(r) &&
              (r.state === "pending" || (r.state === "delivering" && r.claimedUntil! <= now)),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, limit);
        for (const r of due) {
          r.state = "delivering";
          r.claimedUntil = new Date(now.getTime() + leaseMs);
        }
        return due.map((r) => structuredClone(r));
      },
      settle: async (id, state, externalRef) => {
        const r = find(id);
        if (!r || r.state !== "delivering") return false;
        Object.assign(r, { state, settledAt: this.clock(), claimedUntil: undefined });
        if ("proposal" in r) r.externalRef = externalRef;
        return true;
      },
      fail: async (id, error, maxAttempts) => {
        const r = find(id);
        if (!r || r.state !== "delivering") return null;
        const attempts = (r.attempts ?? 0) + 1;
        const state = attempts >= maxAttempts ? "failed" : "pending";
        Object.assign(r, { state, attempts, lastError: error, claimedUntil: undefined });
        return state;
      },
    };
  }

  private cancelProposals(situationId: string): void {
    for (const p of this.proposals_.values()) {
      if (
        p.proposal.situationId === situationId &&
        ["pending", "delivering", "awaiting_human"].includes(p.state)
      ) {
        Object.assign(p, { state: "cancelled", settledAt: this.clock() });
      }
    }
  }

  async getSituation(tenantId: string, id: string) {
    const s = this.situations.get(id);
    return s && s.tenantId === tenantId ? structuredClone(s) : null;
  }

  async closeSituation(
    tenantId: string,
    id: string,
    close: { state: "resolved" | "dismissed"; by: string; resolution: string },
  ) {
    const s = this.situations.get(id);
    if (!s || s.tenantId !== tenantId || s.state !== "open") return false;
    Object.assign(s, {
      state: close.state,
      closedBy: close.by,
      resolution: close.resolution,
      closedAt: this.clock(),
    });
    this.cancelProposals(id);
    return true;
  }

  async listEvents(tenantId: string, situationId: string) {
    return this.events
      .filter((e) => e.tenantId === tenantId && e.situationId === situationId)
      .map((e) => structuredClone(e));
  }

  async digest(
    tenantId: string,
    window: { since: Date; until: Date; clientScope?: string },
  ): Promise<SupervisorDigest> {
    const inScope = (clientScope?: string) =>
      window.clientScope === undefined || clientScope === window.clientScope;
    const events = this.events.filter(
      (e) =>
        e.tenantId === tenantId &&
        inScope(e.clientScope) &&
        e.observedAt >= window.since &&
        e.observedAt < window.until,
    );
    const situations = [...this.situations.values()]
      .filter(
        (s) =>
          s.tenantId === tenantId &&
          inScope(s.clientScope) &&
          s.lastSeenAt >= window.since &&
          s.firstSeenAt < window.until,
      )
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
      .map((s) => ({
        ...structuredClone(s),
        proposal: structuredClone(
          [...this.proposals_.values()].find((p) => p.proposal.situationId === s.id) ?? null,
        ),
      }));
    return {
      situations,
      eventCount: events.length,
      ignoredCount: events.filter((e) => e.disposition === "IGNORE").length,
    };
  }
}

export const pickAggregate = (s: Situation) => ({
  eventCount: s.eventCount,
  lastSeenAt: s.lastSeenAt,
  severity: s.severity,
  maxAttention: s.maxAttention,
});
