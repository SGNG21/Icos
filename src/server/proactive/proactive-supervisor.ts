import { randomUUID } from "node:crypto";

import {
  goalProposalSchema,
  supervisorEventInputSchema,
  type GoalProposal,
  type InitiativePolicy,
  type RelevanceRule,
  type SupervisorEventInput,
} from "@/core/supervisor/contracts";
import {
  DEFAULT_STALE_AFTER_MS,
  ATTENTION_RANK,
  assess,
  attentionChannels,
  situationFingerprint,
} from "@/core/supervisor/policy";
import type {
  AttentionRecord,
  Situation,
  StoredEvent,
  SupervisorDigest,
  SupervisorStore,
} from "./store";

/**
 * Proactive Supervisor (decision 0055): observation → event → situation → proposal.
 *
 * WHAT IT MAY DO: record, aggregate, raise attention, and hand a GoalProposal to the
 * canonical CORE3 goal intake (or one governed action to the Tool Gateway).
 * WHAT IT MAY NOT DO: execute work, pick an agent or a model, call Gmail/browser/any
 * tool directly, convert a goal into a mission, or change its own authority. Every one
 * of those belongs to another owner, reached only through the ports below.
 */

export type PortStatus = "SUBMITTED" | "ACCEPTED" | "DENIED" | "NOT_CONNECTED";

/** CORE3 goal intake. Must be replay-safe: same proposal ⇒ same goal. */
export interface GoalIntakePort {
  submit(proposal: GoalProposal): Promise<{ status: PortStatus; ref?: string }>;
}

/**
 * Tool Gateway lane. The supervisor requests; the gateway authorizes and executes.
 * `requestId` is an IDEMPOTENCY KEY: a redelivery after a lost lease reuses it.
 */
export interface ToolGatewayActionPort {
  requestAction(request: {
    requestId: string;
    tenantId: string;
    clientScope?: string;
    action: string;
    risk: GoalProposal["risk"];
    capabilities: string[];
    evidence: GoalProposal["evidence"];
  }): Promise<{ status: PortStatus; ref?: string }>;
}

/** Cockpit / notification / future voice. */
export interface AttentionPort {
  deliver(record: AttentionRecord, situation: Situation): Promise<{ status: PortStatus }>;
}

/** Cognitive Memory lane: meaningful outcomes only, never raw event noise. */
export interface EpisodeSink {
  publish(episode: {
    tenantId: string;
    kind: "proposal_settled" | "situation_closed";
    situationId: string;
    summary: string;
    evidenceEventIds: string[];
  }): Promise<{ status: PortStatus }>;
}

/** Is the subject already finished (e.g. a mission in a terminal state)? */
export interface SubjectStatusPort {
  isTerminal(subject: string): Promise<boolean>;
}

const notConnected = async () => ({ status: "NOT_CONNECTED" as const });
export const NOT_CONNECTED_TOOL_GATEWAY: ToolGatewayActionPort = { requestAction: notConnected };
export const NOT_CONNECTED_ATTENTION: AttentionPort = { deliver: notConnected };
export const NOT_CONNECTED_EPISODES: EpisodeSink = { publish: notConnected };
export const NO_SUBJECT_STATUS: SubjectStatusPort = { isTerminal: async () => false };

export interface ProactiveSupervisorDeps {
  store: SupervisorStore;
  rules: readonly RelevanceRule[];
  policy: InitiativePolicy;
  goalIntake: GoalIntakePort;
  toolGateway?: ToolGatewayActionPort;
  attention?: AttentionPort;
  episodes?: EpisodeSink;
  subjects?: SubjectStatusPort;
}

export type IngestResult =
  | { status: "DUPLICATE"; eventId: string; situationId: string | null }
  | {
      status: "RECORDED";
      eventId: string;
      situationId: string | null;
      disposition: StoredEvent["disposition"];
      reasons: string[];
      proposalId: string | null;
      attention: AttentionRecord["attentionClass"] | null;
    };

const HOUR_MS = 60 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 5;
const DELIVERY_LEASE_MS = 5 * 60_000;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const PROPOSAL_OUTCOME = {
  SUBMITTED: "submitted",
  ACCEPTED: "submitted",
  DENIED: "denied",
  NOT_CONNECTED: "not_connected",
} as const;
const ATTENTION_OUTCOME = {
  SUBMITTED: "delivered",
  ACCEPTED: "delivered",
  DENIED: "denied",
  NOT_CONNECTED: "not_connected",
} as const;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export class ProactiveSupervisor {
  private readonly store: SupervisorStore;
  /** A private, frozen copy: nothing handed in later — and nothing inside — can widen it. */
  private readonly policy: InitiativePolicy;
  private readonly rules: ReadonlyMap<string, RelevanceRule>;
  private readonly goalIntake: GoalIntakePort;
  private readonly toolGateway: ToolGatewayActionPort;
  private readonly attentionPort: AttentionPort;
  private readonly episodes: EpisodeSink;
  private readonly subjects: SubjectStatusPort;

  constructor(deps: ProactiveSupervisorDeps) {
    this.store = deps.store;
    this.policy = deepFreeze(structuredClone(deps.policy));
    const rules = deepFreeze(structuredClone(deps.rules));
    this.rules = new Map(rules.map((r) => [r.eventType, r]));
    if (this.rules.size !== rules.length) throw new Error("SUPERVISOR_DUPLICATE_RELEVANCE_RULE");
    this.goalIntake = deps.goalIntake;
    this.toolGateway = deps.toolGateway ?? NOT_CONNECTED_TOOL_GATEWAY;
    this.attentionPort = deps.attention ?? NOT_CONNECTED_ATTENTION;
    this.episodes = deps.episodes ?? NOT_CONNECTED_EPISODES;
    this.subjects = deps.subjects ?? NO_SUBJECT_STATUS;
  }

  /**
   * The ONE ingestion path for push, poll, internal and scheduled observations.
   * Idempotent per (tenant, source, dedupKey); crash-safe because everything the
   * decision writes commits in one transaction, and side effects run after, from
   * durable `pending` rows (see {@link drain}).
   */
  async ingest(raw: SupervisorEventInput): Promise<IngestResult> {
    const parsed = supervisorEventInputSchema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`SUPERVISOR_INVALID_EVENT: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    const event = parsed.data;
    const rule = this.rules.get(event.type);

    // Resolved BEFORE the tenant lock: no foreign connection is awaited while holding it.
    const subjectTerminal = rule ? await this.subjects.isTerminal(event.subject) : false;

    const result = await this.store.transact(event.tenantId, async (tx): Promise<IngestResult> => {
      const existing = await tx.findEventByDedup(event.tenantId, event.source, event.dedupKey);
      if (existing)
        return { status: "DUPLICATE", eventId: existing.id, situationId: existing.situationId };

      const now = await tx.now();
      const eventId = randomUUID();
      const fingerprint = rule ? situationFingerprint(event, rule) : null;
      let open = fingerprint ? await tx.findOpenSituation(event.tenantId, fingerprint) : null;
      let stale = false;
      if (
        open &&
        now.getTime() - open.lastSeenAt.getTime() > (rule!.staleAfterMs ?? DEFAULT_STALE_AFTER_MS)
      ) {
        // Quiet for too long: that incident is over. This occurrence is a NEW one —
        // not aggregated silently into a months-old situation, and not a cooldown case.
        await tx.closeStaleSituation(open.id, `no event since ${open.lastSeenAt.toISOString()}`);
        open = null;
        stale = true;
      }
      const lastTerminal =
        fingerprint && !open && !stale
          ? await tx.findLastTerminalSituation(event.tenantId, fingerprint)
          : null;
      const since = new Date(now.getTime() - HOUR_MS);

      const decision = assess({
        event,
        rule,
        policy: this.policy,
        subjectTerminal,
        openSituation: open,
        lastTerminal: lastTerminal ? { closedAt: lastTerminal.closedAt! } : null,
        newSituationsLastHour:
          fingerprint && !open
            ? await tx.countSituationsSince(event.tenantId, rule!.domain, since)
            : 0,
        executionsLastHour: rule?.action
          ? await tx.countExecutionsSince(event.tenantId, rule.domain, rule.action.name, since)
          : 0,
        now,
      });
      const reasons = [...decision.reasons];

      let situation: Situation | null = null;
      if (decision.situation === "open") {
        situation = {
          id: randomUUID(),
          tenantId: event.tenantId,
          clientScope: event.clientScope,
          projectScope: event.projectScope,
          fingerprint: fingerprint!,
          domain: rule!.domain,
          eventType: event.type,
          subject: event.subject,
          kind: rule!.kind,
          state: "open",
          severity: decision.severity,
          eventCount: 1,
          maxAttention: null,
          sourceEventId: eventId,
          firstSeenAt: now,
          lastSeenAt: now,
        };
        await tx.insertSituation(situation);
      } else if (decision.situation === "aggregate") {
        situation = {
          ...open!,
          eventCount: open!.eventCount + 1,
          lastSeenAt: now,
          severity: decision.severity,
        };
      }

      let proposalId: string | null = null;
      let attention: AttentionRecord["attentionClass"] | null = null;
      if (situation) {
        const d = decision.disposition;
        if (
          rule!.action &&
          (d === "PROPOSE_ACTION" || d === "CREATE_BOUNDED_GOAL" || d === "ESCALATE_HUMAN")
        ) {
          const proposal = this.buildProposal(situation, eventId, rule!, decision, reasons);
          const created = await tx.insertProposalIfAbsent({
            proposal,
            domain: rule!.domain,
            state: d === "CREATE_BOUNDED_GOAL" ? "pending" : "awaiting_human",
            createdAt: now,
          });
          if (created) proposalId = proposal.id;
        }
        // Interrupt once per class, and again only if the situation got WORSE.
        if (
          decision.attention &&
          (situation.maxAttention === null ||
            ATTENTION_RANK[decision.attention] > ATTENTION_RANK[situation.maxAttention])
        ) {
          const created = await tx.insertAttentionIfAbsent({
            id: randomUUID(),
            tenantId: event.tenantId,
            situationId: situation.id,
            attentionClass: decision.attention,
            channels: attentionChannels(decision.attention),
            state: "pending",
            createdAt: now,
          });
          if (created) {
            attention = decision.attention;
            situation.maxAttention = decision.attention;
          }
        }
        if (decision.situation === "aggregate" || situation.maxAttention)
          await tx.updateOpenSituation(situation);
      }

      // An aggregated repeat that changed nothing is recorded as such — not as a new decision.
      const nothingNew = decision.situation === "aggregate" && !proposalId && !attention;
      const disposition = nothingNew ? "RECORD_ONLY" : decision.disposition;
      if (nothingNew) reasons.push("AGGREGATED");

      await tx.insertEvent({
        ...event,
        id: eventId,
        observedAt: now,
        fingerprint,
        situationId:
          situation?.id ??
          (reasons.includes("TERMINAL_COOLDOWN") ? (lastTerminal?.id ?? null) : null),
        disposition,
        initiativeLevel: decision.level,
        policyVersion: this.policy.version,
        reasons,
      });
      return {
        status: "RECORDED",
        eventId,
        situationId: situation?.id ?? null,
        disposition,
        reasons,
        proposalId,
        attention,
      };
    });

    // Side effects AFTER commit, from durable rows. A crash here loses nothing: the
    // rows stay `pending` and the next drain (every observation run) delivers them.
    if (result.status === "RECORDED" && (result.proposalId || result.attention)) {
      await this.drain().catch(() => undefined);
    }
    return result;
  }

  private buildProposal(
    situation: Situation,
    eventId: string,
    rule: RelevanceRule,
    decision: ReturnType<typeof assess>,
    reasons: string[],
  ): GoalProposal {
    const action = rule.action!;
    return goalProposalSchema.parse({
      id: `prop-${situation.id}`,
      tenantId: situation.tenantId,
      situationId: situation.id,
      sourceEventId: eventId,
      reason: `${situation.eventType} on ${situation.subject} (${rule.kind}, ${decision.severity})`,
      desiredOutcome: action.desiredOutcome,
      constraints: [
        `Initiative level ${decision.level}; action risk at most ${action.risk}`,
        ...(situation.clientScope ? [`Client scope ${situation.clientScope} only`] : []),
        ...(situation.projectScope ? [`Project scope ${situation.projectScope} only`] : []),
      ],
      urgency: decision.severity,
      risk: action.risk,
      initiativeLevel: decision.level === "UNKNOWN" ? "OBSERVE" : decision.level,
      disposition: decision.disposition,
      route: action.route,
      action: action.name,
      requestedCapabilities: [...action.capabilities],
      projectScope: situation.projectScope,
      clientScope: situation.clientScope,
      evidence: { eventIds: [eventId], policyVersion: this.policy.version, reasons: [...reasons] },
    });
  }

  /**
   * Delivers durable pending side effects (outbox). Only CREATE_BOUNDED_GOAL proposals of
   * OPEN situations are claimable; every other proposal waits for a human. Each row is
   * claimed under a lease, so concurrent drains never deliver one row twice, and each is
   * isolated: a port that throws marks THAT row for retry (then `failed` after
   * {@link MAX_DELIVERY_ATTEMPTS}) and the rest still go.
   */
  async drain(limit = 25): Promise<{ proposals: number; attention: number; failures: number }> {
    let proposals = 0;
    let attention = 0;
    let failures = 0;
    for (const record of await this.store.proposals.claim(limit, DELIVERY_LEASE_MS)) {
      const p = record.proposal;
      try {
        const outcome =
          p.route === "goal"
            ? await this.goalIntake.submit(p)
            : await this.toolGateway.requestAction({
                requestId: p.id,
                tenantId: p.tenantId,
                clientScope: p.clientScope,
                action: p.action,
                risk: p.risk,
                capabilities: p.requestedCapabilities,
                evidence: p.evidence,
              });
        const state = PROPOSAL_OUTCOME[outcome.status];
        if (await this.store.proposals.settle(p.id, state, outcome.ref)) {
          proposals += 1;
          await this.episodes
            .publish({
              tenantId: p.tenantId,
              kind: "proposal_settled",
              situationId: p.situationId,
              summary: `${p.action} ${state}${outcome.ref ? ` (${outcome.ref})` : ""}`,
              evidenceEventIds: p.evidence.eventIds,
            })
            .catch(() => undefined);
        }
      } catch (error) {
        failures += 1;
        await this.store.proposals.fail(p.id, message(error), MAX_DELIVERY_ATTEMPTS);
      }
    }
    for (const record of await this.store.attention.claim(limit, DELIVERY_LEASE_MS)) {
      try {
        const situation = await this.store.getSituation(record.tenantId, record.situationId);
        if (!situation) throw new Error("SUPERVISOR_SITUATION_NOT_FOUND");
        const { status } = await this.attentionPort.deliver(record, situation);
        if (await this.store.attention.settle(record.id, ATTENTION_OUTCOME[status])) attention += 1;
      } catch (error) {
        failures += 1;
        await this.store.attention.fail(record.id, message(error), MAX_DELIVERY_ATTEMPTS);
      }
    }
    return { proposals, attention, failures };
  }

  /** A human (or the owning runtime) closes a situation. Terminal is never reopened. */
  async closeSituation(
    tenantId: string,
    situationId: string,
    close: { state: "resolved" | "dismissed"; by: string; resolution: string },
  ): Promise<boolean> {
    const closed = await this.store.closeSituation(tenantId, situationId, close);
    if (closed) {
      const events = await this.store.listEvents(tenantId, situationId);
      await this.episodes
        .publish({
          tenantId,
          kind: "situation_closed",
          situationId,
          summary: `${close.state} by ${close.by}: ${close.resolution}`,
          evidenceEventIds: events.map((e) => e.id),
        })
        .catch(() => undefined);
    }
    return closed;
  }

  /** Cognitive Runtime port: "what happened overnight?" from durable rows only. */
  digest(
    tenantId: string,
    window: { since: Date; until: Date; clientScope?: string },
  ): Promise<SupervisorDigest> {
    return this.store.digest(tenantId, window);
  }

  evidence(tenantId: string, situationId: string): Promise<StoredEvent[]> {
    return this.store.listEvents(tenantId, situationId);
  }
}
