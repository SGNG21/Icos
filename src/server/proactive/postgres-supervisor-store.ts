import { sql, type SQL } from "drizzle-orm";

import type { Database } from "@/server/database/client";

import type {
  Outbox,
  AttentionRecord,
  AttentionState,
  ProposalRecord,
  ProposalState,
  Situation,
  StoredEvent,
  SupervisorDigest,
  SupervisorStore,
  SupervisorTx,
} from "./store";

type Row = Record<string, unknown>;
type Exec = { execute(query: SQL): Promise<unknown> };

const rows = async (db: Exec, query: SQL) => (await db.execute(query)) as unknown as Row[];
const date = (v: unknown) => (v instanceof Date ? v : new Date(String(v)));
const opt = <T>(v: unknown) => (v === null || v === undefined ? undefined : (v as T));
const iso = (d: Date) => d.toISOString();

function toSituation(r: Row): Situation {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    clientScope: opt(r.client_scope),
    projectScope: opt(r.project_scope),
    fingerprint: String(r.fingerprint),
    domain: String(r.domain),
    eventType: String(r.event_type),
    subject: String(r.subject),
    kind: r.kind as Situation["kind"],
    state: r.state as Situation["state"],
    severity: r.severity as Situation["severity"],
    eventCount: Number(r.event_count),
    maxAttention: (r.max_attention ?? null) as Situation["maxAttention"],
    sourceEventId: String(r.source_event_id),
    firstSeenAt: date(r.first_seen_at),
    lastSeenAt: date(r.last_seen_at),
    closedAt: r.closed_at ? date(r.closed_at) : undefined,
    closedBy: opt(r.closed_by),
    resolution: opt(r.resolution),
  };
}

function toEvent(r: Row): StoredEvent {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    source: String(r.source),
    origin: r.origin as StoredEvent["origin"],
    type: String(r.event_type),
    subject: String(r.subject),
    occurredAt: date(r.occurred_at),
    observedAt: date(r.observed_at),
    payloadRef: opt(r.payload_ref),
    summary: r.summary as StoredEvent["summary"],
    dedupKey: String(r.dedup_key),
    correlationId: opt(r.correlation_id),
    projectScope: opt(r.project_scope),
    clientScope: opt(r.client_scope),
    sensitivity: r.sensitivity as StoredEvent["sensitivity"],
    confidence: Number(r.confidence),
    fingerprint: (r.fingerprint ?? null) as string | null,
    situationId: (r.situation_id ?? null) as string | null,
    disposition: r.disposition as StoredEvent["disposition"],
    initiativeLevel: String(r.initiative_level),
    policyVersion: String(r.policy_version),
    reasons: r.reasons as string[],
  };
}

function toProposal(r: Row): ProposalRecord {
  return {
    proposal: r.proposal as ProposalRecord["proposal"],
    domain: String(r.domain),
    state: r.state as ProposalState,
    externalRef: opt(r.external_ref),
    createdAt: date(r.created_at),
    settledAt: r.settled_at ? date(r.settled_at) : undefined,
    attempts: Number(r.attempts ?? 0),
    lastError: opt(r.last_error),
  };
}

function toAttention(r: Row): AttentionRecord {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id),
    situationId: String(r.situation_id),
    attentionClass: r.attention_class as AttentionRecord["attentionClass"],
    channels: r.channels as string[],
    state: r.state as AttentionState,
    createdAt: date(r.created_at),
    settledAt: r.settled_at ? date(r.settled_at) : undefined,
    attempts: Number(r.attempts ?? 0),
    lastError: opt(r.last_error),
  };
}

/** Cancels a situation's undelivered/awaiting proposal (same statement as the close). */
const cancelProposals = (situationId: SQL) => sql`UPDATE supervisor_goal_proposals
  SET state = 'cancelled', settled_at = now(), claimed_until = NULL
  WHERE situation_id IN (${situationId}) AND state IN ('pending', 'delivering', 'awaiting_human')`;

const textArray = (values: readonly string[]) =>
  sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;

/**
 * PostgreSQL store (decision 0060, migration 0053). Every ingestion runs in ONE
 * transaction holding a per-tenant advisory lock, so flood bounds and execution
 * budgets are exact; uniqueness constraints are the backstop if a caller ever
 * bypasses the lock.
 *
 * ponytail: one lock per tenant serializes all of a tenant's ingestion; lock on
 * (tenant, fingerprint) plus a counter row if ingestion throughput ever matters.
 */
export class PostgresSupervisorStore implements SupervisorStore {
  constructor(private readonly db: Database) {}

  transact<T>(tenantId: string, fn: (tx: SupervisorTx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (db) => {
      await db.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`supervisor:${tenantId}`}, 0))`,
      );
      const tx: SupervisorTx = {
        now: async () => date((await rows(db, sql`SELECT clock_timestamp() AS now`))[0].now),
        findEventByDedup: async (tenant, source, dedupKey) => {
          const [r] = await rows(
            db,
            sql`SELECT * FROM supervisor_events
            WHERE tenant_id = ${tenant} AND source = ${source} AND dedup_key = ${dedupKey}`,
          );
          return r ? toEvent(r) : null;
        },
        findOpenSituation: async (tenant, fingerprint) => {
          const [r] = await rows(
            db,
            sql`SELECT * FROM supervisor_situations
            WHERE tenant_id = ${tenant} AND fingerprint = ${fingerprint} AND state = 'open'`,
          );
          return r ? toSituation(r) : null;
        },
        findLastTerminalSituation: async (tenant, fingerprint) => {
          const [r] = await rows(
            db,
            sql`SELECT * FROM supervisor_situations
            WHERE tenant_id = ${tenant} AND fingerprint = ${fingerprint} AND state <> 'open'
            ORDER BY closed_at DESC LIMIT 1`,
          );
          return r ? toSituation(r) : null;
        },
        countSituationsSince: async (tenant, domain, since) =>
          Number(
            (
              await rows(
                db,
                sql`SELECT count(*)::int AS n FROM supervisor_situations
            WHERE tenant_id = ${tenant} AND domain = ${domain}
              AND first_seen_at >= ${iso(since)}::timestamptz`,
              )
            )[0].n,
          ),
        countExecutionsSince: async (tenant, domain, action, since) =>
          Number(
            (
              await rows(
                db,
                sql`SELECT count(*)::int AS n FROM supervisor_goal_proposals
            WHERE tenant_id = ${tenant} AND domain = ${domain} AND action = ${action}
              AND disposition = 'CREATE_BOUNDED_GOAL' AND created_at >= ${iso(since)}::timestamptz`,
              )
            )[0].n,
          ),
        insertSituation: async (s) => {
          await db.execute(sql`INSERT INTO supervisor_situations (id, tenant_id, client_scope, project_scope,
              fingerprint, domain, event_type, subject, kind, state, severity, event_count, max_attention,
              source_event_id, first_seen_at, last_seen_at)
            VALUES (${s.id}, ${s.tenantId}, ${s.clientScope ?? null}, ${s.projectScope ?? null}, ${s.fingerprint},
              ${s.domain}, ${s.eventType}, ${s.subject}, ${s.kind}, 'open', ${s.severity}, ${s.eventCount},
              ${s.maxAttention}, ${s.sourceEventId}, ${iso(s.firstSeenAt)}::timestamptz, ${iso(s.lastSeenAt)}::timestamptz)`);
        },
        updateOpenSituation: async (s) => {
          const updated = await rows(
            db,
            sql`UPDATE supervisor_situations
            SET event_count = ${s.eventCount}, last_seen_at = ${iso(s.lastSeenAt)}::timestamptz,
                severity = ${s.severity}, max_attention = ${s.maxAttention}
            WHERE id = ${s.id} AND state = 'open' RETURNING id`,
          );
          if (updated.length !== 1) throw new Error("SUPERVISOR_SITUATION_NOT_OPEN");
        },
        insertEvent: async (e) => {
          await db.execute(sql`INSERT INTO supervisor_events (id, tenant_id, source, origin, event_type, subject,
              occurred_at, observed_at, payload_ref, summary, dedup_key, correlation_id, project_scope, client_scope,
              sensitivity, confidence, fingerprint, situation_id, disposition, initiative_level, policy_version, reasons)
            VALUES (${e.id}, ${e.tenantId}, ${e.source}, ${e.origin}, ${e.type}, ${e.subject},
              ${iso(e.occurredAt)}::timestamptz, ${iso(e.observedAt)}::timestamptz, ${e.payloadRef ?? null},
              ${JSON.stringify(e.summary)}::jsonb, ${e.dedupKey}, ${e.correlationId ?? null}, ${e.projectScope ?? null},
              ${e.clientScope ?? null}, ${e.sensitivity}, ${e.confidence}, ${e.fingerprint}, ${e.situationId},
              ${e.disposition}, ${e.initiativeLevel}, ${e.policyVersion}, ${textArray(e.reasons)})`);
        },
        insertProposalIfAbsent: async (r) => {
          const p = r.proposal;
          const inserted = await rows(
            db,
            sql`INSERT INTO supervisor_goal_proposals (id, tenant_id, situation_id,
              source_event_id, domain, action, route, disposition, initiative_level, risk, state, proposal, created_at)
            VALUES (${p.id}, ${p.tenantId}, ${p.situationId}, ${p.sourceEventId}, ${r.domain}, ${p.action}, ${p.route},
              ${p.disposition}, ${p.initiativeLevel}, ${p.risk}, ${r.state}, ${JSON.stringify(p)}::jsonb,
              ${iso(r.createdAt)}::timestamptz)
            ON CONFLICT (situation_id) DO NOTHING RETURNING id`,
          );
          return inserted.length === 1;
        },
        insertAttentionIfAbsent: async (a) => {
          const inserted = await rows(
            db,
            sql`INSERT INTO supervisor_attention (id, tenant_id, situation_id,
              attention_class, channels, state, created_at)
            VALUES (${a.id}, ${a.tenantId}, ${a.situationId}, ${a.attentionClass}, ${textArray(a.channels)},
              ${a.state}, ${iso(a.createdAt)}::timestamptz)
            ON CONFLICT (situation_id, attention_class) DO NOTHING RETURNING id`,
          );
          return inserted.length === 1;
        },
        closeStaleSituation: async (id, resolution) => {
          const closed = await rows(
            db,
            sql`UPDATE supervisor_situations
              SET state = 'dismissed', closed_by = 'supervisor:stale', resolution = ${resolution},
                  closed_at = clock_timestamp()
              WHERE id = ${id} AND state = 'open' RETURNING id`,
          );
          if (closed.length !== 1) throw new Error("SUPERVISOR_SITUATION_NOT_OPEN");
          await db.execute(cancelProposals(sql`${id}`));
        },
      };
      return fn(tx);
    });
  }

  readonly proposals: Outbox<ProposalRecord, ProposalState> = this.outbox(
    "supervisor_goal_proposals",
    // Only bounded goals of situations still OPEN: a closed situation never fires late.
    sql`disposition = 'CREATE_BOUNDED_GOAL' AND situation_id IN
      (SELECT id FROM supervisor_situations WHERE state = 'open')`,
    toProposal,
  );

  readonly attention: Outbox<AttentionRecord, AttentionState> = this.outbox(
    "supervisor_attention",
    sql`TRUE`,
    toAttention,
  );

  /**
   * Claim = `FOR UPDATE SKIP LOCKED` + lease: two drains (two replicas, or ingest and
   * the observation job) never deliver the same row concurrently; a crashed drain's
   * rows come back when the lease expires.
   */
  private outbox<R, S extends string>(
    table: "supervisor_goal_proposals" | "supervisor_attention",
    eligible: SQL,
    map: (r: Row) => R,
  ): Outbox<R, S> {
    const t = sql.raw(table);
    return {
      claim: async (limit, leaseMs) =>
        (
          await rows(
            this.db,
            sql`UPDATE ${t} SET state = 'delivering',
                claimed_until = now() + ${leaseMs} * interval '1 millisecond'
              WHERE id IN (SELECT id FROM ${t}
                WHERE ${eligible} AND (state = 'pending' OR (state = 'delivering' AND claimed_until <= now()))
                ORDER BY created_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
              RETURNING *`,
          )
        ).map(map),
      settle: async (id, state, externalRef) =>
        (
          await rows(
            this.db,
            table === "supervisor_goal_proposals"
              ? sql`UPDATE ${t} SET state = ${state}, external_ref = ${externalRef ?? null},
                  settled_at = now(), claimed_until = NULL
                WHERE id = ${id} AND state = 'delivering' RETURNING id`
              : sql`UPDATE ${t} SET state = ${state}, settled_at = now(), claimed_until = NULL
                WHERE id = ${id} AND state = 'delivering' RETURNING id`,
          )
        ).length === 1,
      fail: async (id, error, maxAttempts) => {
        const [r] = await rows(
          this.db,
          sql`UPDATE ${t} SET attempts = attempts + 1, last_error = ${error.slice(0, 500)},
              claimed_until = NULL,
              state = CASE WHEN attempts + 1 >= ${maxAttempts} THEN 'failed' ELSE 'pending' END
            WHERE id = ${id} AND state = 'delivering' RETURNING state`,
        );
        return r ? (r.state as "pending" | "failed") : null;
      },
    };
  }

  async getSituation(tenantId: string, id: string) {
    const [r] = await rows(
      this.db,
      sql`SELECT * FROM supervisor_situations WHERE tenant_id = ${tenantId} AND id = ${id}`,
    );
    return r ? toSituation(r) : null;
  }

  async closeSituation(
    tenantId: string,
    id: string,
    close: { state: "resolved" | "dismissed"; by: string; resolution: string },
  ) {
    return this.db.transaction(async (tx) => {
      const closed = await rows(
        tx,
        sql`UPDATE supervisor_situations
          SET state = ${close.state}, closed_by = ${close.by}, resolution = ${close.resolution},
              closed_at = now()
          WHERE tenant_id = ${tenantId} AND id = ${id} AND state = 'open' RETURNING id`,
      );
      if (closed.length !== 1) return false;
      await tx.execute(cancelProposals(sql`${id}`));
      return true;
    });
  }

  async listEvents(tenantId: string, situationId: string) {
    return (
      await rows(
        this.db,
        sql`SELECT * FROM supervisor_events
      WHERE tenant_id = ${tenantId} AND situation_id = ${situationId} ORDER BY observed_at, id`,
      )
    ).map(toEvent);
  }

  async digest(
    tenantId: string,
    window: { since: Date; until: Date; clientScope?: string },
  ): Promise<SupervisorDigest> {
    const client =
      window.clientScope === undefined ? sql`TRUE` : sql`client_scope = ${window.clientScope}`;
    const situations = (
      await rows(
        this.db,
        sql`SELECT s.*, to_jsonb(p) AS proposal_row
      FROM supervisor_situations s LEFT JOIN supervisor_goal_proposals p ON p.situation_id = s.id
      WHERE s.tenant_id = ${tenantId} AND ${window.clientScope === undefined ? sql`TRUE` : sql`s.client_scope = ${window.clientScope}`}
        AND s.last_seen_at >= ${iso(window.since)}::timestamptz AND s.first_seen_at < ${iso(window.until)}::timestamptz
      ORDER BY s.last_seen_at DESC`,
      )
    ).map((r) => ({
      ...toSituation(r),
      proposal: r.proposal_row ? toProposal(r.proposal_row as Row) : null,
    }));
    const [counts] = await rows(
      this.db,
      sql`SELECT count(*)::int AS events,
        count(*) FILTER (WHERE disposition = 'IGNORE')::int AS ignored
      FROM supervisor_events WHERE tenant_id = ${tenantId} AND ${client}
        AND observed_at >= ${iso(window.since)}::timestamptz AND observed_at < ${iso(window.until)}::timestamptz`,
    );
    return { situations, eventCount: Number(counts.events), ignoredCount: Number(counts.ignored) };
  }
}
