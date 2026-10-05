import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";

import type {
  ContextSnapshot,
  Conversation,
  ConversationEvent,
  ConversationEventType,
  CreateConversationInput,
  GoalProposal,
  Participant,
  RefStatus,
  SubmitTurnInput,
  Turn,
  TurnOutcome,
  TurnReference,
} from "@/core/cognitive/contracts";
import { launchPolicy, type GovernedOutcome } from "@/core/cognitive/turn-policy";
import type { Database } from "@/server/database/client";
import { uniqueConstraintName } from "@/server/database/errors";

import {
  cognitiveContextSnapshots,
  cognitiveConversations,
  cognitiveEvents,
  cognitiveParticipants,
  cognitiveTurnRefs,
  cognitiveTurns,
} from "./schema";

export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface Clock {
  now: () => Date;
  newId: (prefix: string) => string;
}
export const systemClock: Clock = {
  now: () => new Date(),
  newId: (prefix) => `${prefix}-${randomUUID()}`,
};

export class TurnInProgressError extends Error {
  readonly code = "turn_in_progress" as const;
  constructor() {
    super("Un tour est déjà en cours pour cette conversation");
    this.name = "TurnInProgressError";
  }
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

type ConvRow = typeof cognitiveConversations.$inferSelect;
type TurnRow = typeof cognitiveTurns.$inferSelect;
type RefRow = typeof cognitiveTurnRefs.$inferSelect;

const toConversation = (r: ConvRow): Conversation => ({
  id: r.id,
  tenantId: r.tenantId,
  ownerUserId: r.ownerUserId,
  title: r.title,
  clientId: r.clientId,
  projectId: r.projectId,
  previousClientId: r.previousClientId,
  previousProjectId: r.previousProjectId,
  status: r.status as Conversation["status"],
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

const toTurn = (r: TurnRow): Turn => ({
  id: r.id,
  conversationId: r.conversationId,
  clientId: r.clientId,
  projectId: r.projectId,
  seq: r.seq,
  role: r.role as Turn["role"],
  authorKind: r.authorKind as Turn["authorKind"],
  authorId: r.authorId,
  content: r.content as Turn["content"],
  status: r.status as Turn["status"],
  outcome: r.outcome as TurnOutcome | null,
  replyToTurnId: r.replyToTurnId,
  idempotencyKey: r.idempotencyKey,
  contextSnapshotId: r.contextSnapshotId,
  failureReason: r.failureReason,
  createdAt: r.createdAt.toISOString(),
  completedAt: iso(r.completedAt),
});

const toRef = (r: RefRow): TurnReference => ({
  id: r.id,
  conversationId: r.conversationId,
  turnId: r.turnId,
  clientId: r.clientId,
  projectId: r.projectId,
  kind: r.kind as TurnReference["kind"],
  status: r.status as RefStatus,
  payload: r.payload as TurnReference["payload"],
  policyReason: r.policyReason,
  decidedBy: r.decidedBy,
  decidedAt: iso(r.decidedAt),
  goalId: r.goalId,
  missionId: r.missionId,
  launchJobId: r.launchJobId,
  failureReason: r.failureReason,
  createdAt: r.createdAt.toISOString(),
});

/** Owner of a conversation, within a tenant. Every read/write is keyed by both. */
export interface ConversationOwner {
  readonly tenantId: string;
  readonly userId: string;
}

/**
 * Durable conversation store (decision 0056). PostgreSQL is the only authority:
 * no model/session id, every turn and event is ordered by a per-conversation sequence,
 * and a conversation resumes from these rows after any restart.
 */
export class PostgresConversationStore {
  constructor(
    readonly db: Database,
    private readonly clock: Clock = systemClock,
  ) {}

  now(): Date {
    return this.clock.now();
  }

  async create(owner: ConversationOwner, input: CreateConversationInput): Promise<Conversation> {
    const now = this.clock.now();
    const id = this.clock.newId("conv");
    return await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(cognitiveConversations)
        .values({
          id,
          tenantId: owner.tenantId,
          ownerUserId: owner.userId,
          title: input.title ?? null,
          clientId: input.clientId ?? null,
          projectId: input.projectId ?? null,
          previousClientId: null,
          previousProjectId: null,
          status: "active",
          nextTurnSeq: 1,
          nextEventSeq: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx.insert(cognitiveParticipants).values([
        {
          conversationId: id,
          kind: "human",
          subjectId: owner.userId,
          role: "owner",
          joinedAt: now,
        },
        { conversationId: id, kind: "icos", subjectId: "icos", role: "assistant", joinedAt: now },
      ]);
      await this.appendEvent(tx, id, owner.tenantId, "conversation.created", null, {
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
      });
      return toConversation(row);
    });
  }

  async get(owner: ConversationOwner, id: string): Promise<Conversation | null> {
    const [row] = await this.db
      .select()
      .from(cognitiveConversations)
      .where(this.ownedBy(owner, id));
    return row ? toConversation(row) : null;
  }

  async list(owner: ConversationOwner, limit = 50): Promise<Conversation[]> {
    const rows = await this.db
      .select()
      .from(cognitiveConversations)
      .where(
        and(
          eq(cognitiveConversations.tenantId, owner.tenantId),
          eq(cognitiveConversations.ownerUserId, owner.userId),
        ),
      )
      .orderBy(desc(cognitiveConversations.updatedAt), asc(cognitiveConversations.id))
      .limit(limit);
    return rows.map(toConversation);
  }

  /**
   * Moves the conversation's context pointer (decision 0063). The scope being left becomes
   * `previous_*`, which is what « reviens à LDS » reads — so the pointer survives a restart
   * without any in-memory stack. The in-flight turn is restamped so it is read and written
   * under the scope that was actually resolved for it; a terminal turn's scope is immutable
   * (database trigger), so history can never be moved into another client.
   *
   * Idempotent: setting the scope it already has leaves `previous_*` untouched.
   */
  async setScope(
    tenantId: string,
    conversationId: string,
    turnId: string | null,
    next: { clientId: string | null; projectId: string | null },
    resolution: { source: string; entityKey: string | null },
  ): Promise<Conversation> {
    const now = this.clock.now();
    return await this.db.transaction(async (tx) => {
      const conv = await this.lockConversation(tx, conversationId);
      if (conv.clientId === next.clientId && conv.projectId === next.projectId) {
        if (turnId) await this.stampTurnScope(tx, turnId, next);
        return toConversation(conv);
      }
      const [row] = await tx
        .update(cognitiveConversations)
        .set({
          clientId: next.clientId,
          projectId: next.projectId,
          // Only a real scope is worth returning to: never record "no scope" as previous.
          previousClientId: conv.clientId ?? conv.previousClientId,
          previousProjectId: conv.clientId ? conv.projectId : conv.previousProjectId,
          updatedAt: now,
        })
        .where(eq(cognitiveConversations.id, conversationId))
        .returning();
      if (turnId) await this.stampTurnScope(tx, turnId, next);
      await this.appendEvent(tx, conversationId, tenantId, "context.resolved", turnId, {
        clientId: next.clientId,
        projectId: next.projectId,
        previousClientId: row.previousClientId,
        previousProjectId: row.previousProjectId,
        source: resolution.source,
        entityKey: resolution.entityKey,
      });
      return toConversation(row);
    });
  }

  private async stampTurnScope(
    tx: Executor,
    turnId: string,
    scope: { clientId: string | null; projectId: string | null },
  ): Promise<void> {
    await tx
      .update(cognitiveTurns)
      .set({ clientId: scope.clientId, projectId: scope.projectId })
      .where(
        and(
          eq(cognitiveTurns.id, turnId),
          inArray(cognitiveTurns.status, ["received", "processing"]),
        ),
      );
  }

  /**
   * Most recent durable client scope of this owner, outside `exceptConversationId`.
   * Backs « continue ce qu'on faisait » when the current conversation has no pointer yet.
   */
  async recentScope(
    owner: ConversationOwner,
    exceptConversationId: string,
  ): Promise<{ clientId: string | null; projectId: string | null }> {
    const [row] = await this.db
      .select({
        clientId: cognitiveConversations.clientId,
        projectId: cognitiveConversations.projectId,
      })
      .from(cognitiveConversations)
      .where(
        and(
          eq(cognitiveConversations.tenantId, owner.tenantId),
          eq(cognitiveConversations.ownerUserId, owner.userId),
          ne(cognitiveConversations.id, exceptConversationId),
          sql`${cognitiveConversations.clientId} is not null`,
        ),
      )
      .orderBy(desc(cognitiveConversations.updatedAt), desc(cognitiveConversations.id))
      .limit(1);
    return row ?? { clientId: null, projectId: null };
  }

  /** Proposals of a client, newest first — the launch/mission state ICOS durably knows. */
  /**
   * `clientId: null` lit les refs SANS client de ce tenant — et non celles de tous les clients.
   * Un objectif interne (SELF_IMPROVEMENT) n'a par nature pas de client : sans ce cas, son état
   * était illisible. Élargir à tous les clients serait une fuite inter-clients ; on reste donc
   * sur l'égalité stricte « pas de client ».
   */
  async refsForClient(
    tenantId: string,
    clientId: string | null,
    statuses: readonly RefStatus[],
    limit = 20,
  ): Promise<TurnReference[]> {
    const rows = await this.db
      .select()
      .from(cognitiveTurnRefs)
      .where(
        and(
          eq(cognitiveTurnRefs.tenantId, tenantId),
          clientId === null
            ? isNull(cognitiveTurnRefs.clientId)
            : eq(cognitiveTurnRefs.clientId, clientId),
          inArray(cognitiveTurnRefs.status, [...statuses]),
        ),
      )
      .orderBy(desc(cognitiveTurnRefs.createdAt), asc(cognitiveTurnRefs.id))
      .limit(limit);
    return rows.map(toRef);
  }

  async participants(conversationId: string): Promise<Participant[]> {
    const rows = await this.db
      .select()
      .from(cognitiveParticipants)
      .where(eq(cognitiveParticipants.conversationId, conversationId))
      .orderBy(asc(cognitiveParticipants.joinedAt), asc(cognitiveParticipants.subjectId));
    return rows.map((r) => ({
      kind: r.kind as Participant["kind"],
      subjectId: r.subjectId,
      role: r.role as Participant["role"],
      joinedAt: r.joinedAt.toISOString(),
    }));
  }

  /**
   * Records a user turn. Idempotent on (conversation, idempotencyKey): a replay returns
   * the original turn with `created: false`. A second in-flight turn is refused by the
   * `cognitive_turns_one_inflight` unique index (TurnInProgressError).
   */
  async beginUserTurn(
    owner: ConversationOwner,
    conversationId: string,
    input: SubmitTurnInput,
  ): Promise<{ turn: Turn; created: boolean } | null> {
    try {
      return await this.db.transaction(async (tx) => {
        const [conv] = await tx
          .select()
          .from(cognitiveConversations)
          .where(this.ownedBy(owner, conversationId))
          .for("update");
        if (!conv) return null;
        const [existing] = await tx
          .select()
          .from(cognitiveTurns)
          .where(
            and(
              eq(cognitiveTurns.conversationId, conversationId),
              eq(cognitiveTurns.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return { turn: toTurn(existing), created: false };

        const turn = await this.insertTurn(tx, conv, {
          role: "user",
          authorKind: "human",
          authorId: owner.userId,
          text: input.text,
          status: "received",
          idempotencyKey: input.idempotencyKey,
        });
        await this.appendEvent(tx, conversationId, conv.tenantId, "turn.received", turn.id, {
          seq: turn.seq,
        });
        return { turn, created: true };
      });
    } catch (error) {
      if (uniqueConstraintName(error) === "cognitive_turns_one_inflight")
        throw new TurnInProgressError();
      throw error;
    }
  }

  /** received → processing. False if the turn was cancelled/recovered meanwhile. */
  async markProcessing(tenantId: string, turn: Turn): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      await this.lockConversation(tx, turn.conversationId);
      const rows = await tx
        .update(cognitiveTurns)
        .set({ status: "processing", processingStartedAt: this.clock.now() })
        .where(and(eq(cognitiveTurns.id, turn.id), eq(cognitiveTurns.status, "received")))
        .returning({ id: cognitiveTurns.id });
      if (!rows.length) return false;
      await this.appendEvent(tx, turn.conversationId, tenantId, "turn.processing", turn.id, {});
      return true;
    });
  }

  async saveSnapshot(snapshot: ContextSnapshot): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockConversation(tx, snapshot.conversationId);
      await tx.insert(cognitiveContextSnapshots).values({
        id: snapshot.id,
        tenantId: snapshot.tenantId,
        conversationId: snapshot.conversationId,
        turnId: snapshot.turnId,
        policyVersion: snapshot.policyVersion,
        scope: snapshot.scope,
        items: snapshot.items,
        excluded: snapshot.excluded,
        tokenBudget: snapshot.tokenBudget,
        tokensUsed: snapshot.tokensUsed,
        contentHash: snapshot.contentHash,
        createdAt: new Date(snapshot.createdAt),
      });
      await tx
        .update(cognitiveTurns)
        .set({ contextSnapshotId: snapshot.id })
        .where(eq(cognitiveTurns.id, snapshot.turnId));
      await this.appendEvent(
        tx,
        snapshot.conversationId,
        snapshot.tenantId,
        "context.assembled",
        snapshot.turnId,
        {
          snapshotId: snapshot.id,
          items: snapshot.items.length,
          excluded: snapshot.excluded.length,
          contentHash: snapshot.contentHash,
        },
      );
    });
  }

  async getSnapshot(
    owner: ConversationOwner,
    conversationId: string,
    turnId: string,
  ): Promise<ContextSnapshot | null> {
    const [row] = await this.db
      .select({ s: cognitiveContextSnapshots })
      .from(cognitiveContextSnapshots)
      .innerJoin(
        cognitiveConversations,
        eq(cognitiveConversations.id, cognitiveContextSnapshots.conversationId),
      )
      .where(
        and(this.ownedBy(owner, conversationId), eq(cognitiveContextSnapshots.turnId, turnId)),
      );
    if (!row) return null;
    const s = row.s;
    return {
      id: s.id,
      tenantId: s.tenantId,
      conversationId: s.conversationId,
      turnId: s.turnId,
      policyVersion: s.policyVersion,
      scope: s.scope as ContextSnapshot["scope"],
      items: s.items as ContextSnapshot["items"],
      excluded: s.excluded as ContextSnapshot["excluded"],
      tokenBudget: s.tokenBudget,
      tokensUsed: s.tokensUsed,
      contentHash: s.contentHash,
      createdAt: s.createdAt.toISOString(),
    };
  }

  /**
   * processing → completed, atomically with the assistant turn and any proposal.
   * Returns null when the turn is no longer processing (cancelled/recovered): the
   * result is then discarded, never half-written.
   */
  async completeTurn(
    tenantId: string,
    turn: Turn,
    result: {
      outcome: TurnOutcome;
      reply: string;
      intent?: string;
      proposal?: GovernedOutcome["proposal"];
    },
  ): Promise<{ assistant: Turn; ref: TurnReference | null } | null> {
    const now = this.clock.now();
    return await this.db.transaction(async (tx) => {
      const conv = await this.lockConversation(tx, turn.conversationId);
      const updated = await tx
        .update(cognitiveTurns)
        .set({
          status: "completed",
          outcome: result.outcome,
          intent: result.intent ?? null,
          completedAt: now,
        })
        .where(and(eq(cognitiveTurns.id, turn.id), eq(cognitiveTurns.status, "processing")))
        .returning({ id: cognitiveTurns.id });
      if (!updated.length) return null;
      const scope = { clientId: turn.clientId, projectId: turn.projectId };
      const assistant = await this.insertTurn(tx, conv, {
        role: "assistant",
        authorKind: "icos",
        authorId: "icos",
        text: result.reply,
        status: "completed",
        outcome: result.outcome,
        replyToTurnId: turn.id,
        contextSnapshotId: turn.contextSnapshotId,
        completedAt: now,
        scope,
      });
      let ref: TurnReference | null = null;
      if (result.proposal) {
        const policy = launchPolicy(
          result.proposal.kind,
          result.proposal.kind === "goal_proposal"
            ? (result.proposal.payload as GoalProposal)
            : undefined,
        );
        const [row] = await tx
          .insert(cognitiveTurnRefs)
          .values({
            id: this.clock.newId("tref"),
            tenantId,
            conversationId: turn.conversationId,
            turnId: turn.id,
            clientId: scope.clientId,
            projectId: scope.projectId,
            kind: result.proposal.kind,
            status: policy.status,
            policyReason: policy.reason,
            // Policy-approved: signed by the policy and dated now, so `beginLaunch` (which
            // needs `approved`) and the audit row read exactly as a human approval does.
            ...(policy.status === "approved"
              ? { decidedBy: policy.decidedBy, decidedAt: now }
              : {}),
            payload: result.proposal.payload,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        ref = toRef(row);
        await this.appendEvent(tx, turn.conversationId, tenantId, "proposal.created", turn.id, {
          refId: ref.id,
          kind: ref.kind,
          status: ref.status,
          policyReason: ref.policyReason,
        });
      }
      await this.appendEvent(tx, turn.conversationId, tenantId, "turn.completed", turn.id, {
        outcome: result.outcome,
        assistantTurnId: assistant.id,
      });
      return { assistant, ref };
    });
  }

  async failTurn(
    tenantId: string,
    turn: Pick<Turn, "id" | "conversationId">,
    reason: string,
  ): Promise<boolean> {
    return await this.endInFlight(tenantId, turn.conversationId, [turn.id], "failed", reason);
  }

  async cancelTurn(
    owner: ConversationOwner,
    conversationId: string,
    turnId: string,
  ): Promise<boolean> {
    const conv = await this.get(owner, conversationId);
    if (!conv) return false;
    return await this.endInFlight(
      conv.tenantId,
      conversationId,
      [turnId],
      "cancelled",
      "cancelled_by_user",
    );
  }

  /**
   * Restart recovery: an in-flight turn older than `staleMs` belongs to a process that
   * died. It is closed as failed ("interrupted") — never silently re-run, because the
   * user may already have resubmitted. Returns the recovered turn ids.
   */
  async recoverInterrupted(conversationId: string, staleMs: number): Promise<string[]> {
    const cutoff = new Date(this.clock.now().getTime() - staleMs);
    const rows = await this.db
      .select({ id: cognitiveTurns.id, tenantId: cognitiveTurns.tenantId })
      .from(cognitiveTurns)
      .where(
        and(
          eq(cognitiveTurns.conversationId, conversationId),
          inArray(cognitiveTurns.status, ["received", "processing"]),
          sql`coalesce(${cognitiveTurns.processingStartedAt}, ${cognitiveTurns.createdAt}) < ${cutoff.toISOString()}::timestamptz`,
        ),
      );
    const done: string[] = [];
    for (const r of rows) {
      if (await this.endInFlight(r.tenantId, conversationId, [r.id], "failed", "interrupted"))
        done.push(r.id);
    }
    return done;
  }

  async listTurns(conversationId: string): Promise<Turn[]> {
    const rows = await this.db
      .select()
      .from(cognitiveTurns)
      .where(eq(cognitiveTurns.conversationId, conversationId))
      .orderBy(asc(cognitiveTurns.seq));
    return rows.map(toTurn);
  }

  /**
   * Recent completed turns of this conversation, restricted to `scope` (decision 0063).
   *
   * A turn spoken under another client NEVER re-enters this context: that is the only thing
   * standing between « Et le Mécène ? » and three turns of LDS detail in the prompt. An
   * unscoped turn (pre-0054, or spoken before any client was resolved) carries no client
   * knowledge and stays visible.
   */
  async recentTurns(
    conversationId: string,
    beforeSeq: number,
    limit: number,
    scope: { clientId: string | null; projectId: string | null } = {
      clientId: null,
      projectId: null,
    },
  ): Promise<Turn[]> {
    const rows = await this.db
      .select()
      .from(cognitiveTurns)
      .where(
        and(
          eq(cognitiveTurns.conversationId, conversationId),
          lt(cognitiveTurns.seq, beforeSeq),
          eq(cognitiveTurns.status, "completed"),
          scope.clientId === null
            ? isNull(cognitiveTurns.clientId)
            : or(isNull(cognitiveTurns.clientId), eq(cognitiveTurns.clientId, scope.clientId)),
          scope.projectId === null
            ? isNull(cognitiveTurns.projectId)
            : or(isNull(cognitiveTurns.projectId), eq(cognitiveTurns.projectId, scope.projectId)),
        ),
      )
      .orderBy(desc(cognitiveTurns.seq))
      .limit(limit);
    return rows.map(toTurn);
  }

  async getTurn(conversationId: string, turnId: string): Promise<Turn | null> {
    const [row] = await this.db
      .select()
      .from(cognitiveTurns)
      .where(and(eq(cognitiveTurns.conversationId, conversationId), eq(cognitiveTurns.id, turnId)));
    return row ? toTurn(row) : null;
  }

  async listEvents(
    conversationId: string,
    afterSeq: number,
    limit = 200,
  ): Promise<ConversationEvent[]> {
    const rows = await this.db
      .select()
      .from(cognitiveEvents)
      .where(
        and(eq(cognitiveEvents.conversationId, conversationId), gt(cognitiveEvents.seq, afterSeq)),
      )
      .orderBy(asc(cognitiveEvents.seq))
      .limit(limit);
    return rows.map((r) => ({
      conversationId: r.conversationId,
      seq: r.seq,
      type: r.type as ConversationEventType,
      turnId: r.turnId,
      payload: r.payload as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async listRefs(conversationId: string): Promise<TurnReference[]> {
    const rows = await this.db
      .select()
      .from(cognitiveTurnRefs)
      .where(eq(cognitiveTurnRefs.conversationId, conversationId))
      .orderBy(asc(cognitiveTurnRefs.createdAt), asc(cognitiveTurnRefs.id));
    return rows.map(toRef);
  }

  /**
   * approval_required → approved | rejected. Exactly one decision wins (conditional
   * update); a second decision returns `already_decided`.
   */
  async decideRef(
    owner: ConversationOwner,
    conversationId: string,
    refId: string,
    decision: "approve" | "reject",
  ): Promise<
    { ok: true; ref: TurnReference } | { ok: false; reason: "not_found" | "already_decided" }
  > {
    const conv = await this.get(owner, conversationId);
    if (!conv) return { ok: false, reason: "not_found" };
    const now = this.clock.now();
    return await this.db.transaction(async (tx) => {
      await this.lockConversation(tx, conversationId);
      const rows = await tx
        .update(cognitiveTurnRefs)
        .set({
          status: decision === "approve" ? "approved" : "rejected",
          decidedBy: owner.userId,
          decidedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(cognitiveTurnRefs.id, refId),
            eq(cognitiveTurnRefs.conversationId, conversationId),
            eq(cognitiveTurnRefs.status, "approval_required"),
          ),
        )
        .returning();
      if (!rows.length) {
        const [exists] = await tx
          .select({ id: cognitiveTurnRefs.id })
          .from(cognitiveTurnRefs)
          .where(
            and(
              eq(cognitiveTurnRefs.id, refId),
              eq(cognitiveTurnRefs.conversationId, conversationId),
            ),
          );
        return {
          ok: false as const,
          reason: exists ? ("already_decided" as const) : ("not_found" as const),
        };
      }
      const ref = toRef(rows[0]);
      await this.appendEvent(tx, conversationId, conv.tenantId, "proposal.decided", ref.turnId, {
        refId,
        decision,
        decidedBy: owner.userId,
      });
      return { ok: true as const, ref };
    });
  }

  /**
   * approved → launching (or already launching: a recovery re-entry). Returns null for
   * any other state, so a rejected/launched/failed proposal is never launched again.
   */
  async beginLaunch(tenantId: string, ref: TurnReference): Promise<TurnReference | null> {
    return await this.db.transaction(async (tx) => {
      await this.lockConversation(tx, ref.conversationId);
      const [row] = await tx
        .select()
        .from(cognitiveTurnRefs)
        .where(eq(cognitiveTurnRefs.id, ref.id));
      if (!row || (row.status !== "approved" && row.status !== "launching")) return null;
      if (row.status === "launching") return toRef(row);
      const [updated] = await tx
        .update(cognitiveTurnRefs)
        .set({ status: "launching", updatedAt: this.clock.now() })
        .where(and(eq(cognitiveTurnRefs.id, ref.id), eq(cognitiveTurnRefs.status, "approved")))
        .returning();
      await this.appendEvent(tx, ref.conversationId, tenantId, "proposal.launching", ref.turnId, {
        refId: ref.id,
      });
      return toRef(updated);
    });
  }

  /**
   * launching → launched | failed | not_connected, exactly once (conditional update).
   * A concurrent finisher gets the already-settled row back and appends no event.
   */
  async finishLaunch(
    tenantId: string,
    ref: TurnReference,
    outcome:
      | { status: "launched"; goalId: string; missionId: string; launchJobId: string }
      | { status: "failed" | "not_connected"; reason: string },
  ): Promise<TurnReference> {
    return await this.db.transaction(async (tx) => {
      await this.lockConversation(tx, ref.conversationId);
      const [row] = await tx
        .update(cognitiveTurnRefs)
        .set(
          outcome.status === "launched"
            ? {
                status: "launched",
                goalId: outcome.goalId,
                missionId: outcome.missionId,
                launchJobId: outcome.launchJobId,
                updatedAt: this.clock.now(),
              }
            : {
                status: outcome.status,
                failureReason: outcome.reason.slice(0, 500),
                updatedAt: this.clock.now(),
              },
        )
        .where(and(eq(cognitiveTurnRefs.id, ref.id), eq(cognitiveTurnRefs.status, "launching")))
        .returning();
      if (!row) {
        const [current] = await tx
          .select()
          .from(cognitiveTurnRefs)
          .where(eq(cognitiveTurnRefs.id, ref.id));
        return toRef(current);
      }
      await this.appendEvent(
        tx,
        ref.conversationId,
        tenantId,
        outcome.status === "launched" ? "proposal.launched" : "proposal.failed",
        ref.turnId,
        outcome.status === "launched"
          ? {
              refId: ref.id,
              goalId: outcome.goalId,
              missionId: outcome.missionId,
              launchJobId: outcome.launchJobId,
            }
          : { refId: ref.id, status: outcome.status, reason: outcome.reason.slice(0, 500) },
      );
      return toRef(row);
    });
  }

  /** Approved-but-not-launched proposals of a tenant (restart recovery of launches). */
  async pendingLaunches(tenantId: string, limit = 100): Promise<TurnReference[]> {
    const rows = await this.db
      .select()
      .from(cognitiveTurnRefs)
      .where(
        and(
          eq(cognitiveTurnRefs.tenantId, tenantId),
          inArray(cognitiveTurnRefs.status, ["approved", "launching"]),
        ),
      )
      .orderBy(asc(cognitiveTurnRefs.updatedAt), asc(cognitiveTurnRefs.id))
      .limit(limit);
    return rows.map(toRef);
  }

  /** The conversation a ref belongs to (for recovery, which has no HTTP caller). */
  async conversationOf(conversationId: string): Promise<Conversation | null> {
    const [row] = await this.db
      .select()
      .from(cognitiveConversations)
      .where(eq(cognitiveConversations.id, conversationId));
    return row ? toConversation(row) : null;
  }

  async recordEvent(
    tenantId: string,
    conversationId: string,
    type: ConversationEventType,
    turnId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.db.transaction((tx) =>
      this.appendEvent(tx, conversationId, tenantId, type, turnId, payload),
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────
  /**
   * Lock order is ALWAYS conversation row → turn/ref rows. Every transaction that writes
   * a turn, a ref or an event takes this lock first, so writers cannot deadlock.
   */
  private async lockConversation(tx: Executor, id: string): Promise<ConvRow> {
    const [conv] = await tx
      .select()
      .from(cognitiveConversations)
      .where(eq(cognitiveConversations.id, id))
      .for("update");
    return conv;
  }

  private ownedBy(owner: ConversationOwner, id: string) {
    return and(
      eq(cognitiveConversations.id, id),
      eq(cognitiveConversations.tenantId, owner.tenantId),
      eq(cognitiveConversations.ownerUserId, owner.userId),
    );
  }

  private async endInFlight(
    tenantId: string,
    conversationId: string,
    turnIds: string[],
    status: "failed" | "cancelled",
    reason: string,
  ): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      await this.lockConversation(tx, conversationId);
      const rows = await tx
        .update(cognitiveTurns)
        .set({ status, failureReason: reason.slice(0, 500), completedAt: this.clock.now() })
        .where(
          and(
            eq(cognitiveTurns.conversationId, conversationId),
            inArray(cognitiveTurns.id, turnIds),
            inArray(cognitiveTurns.status, ["received", "processing"]),
          ),
        )
        .returning({ id: cognitiveTurns.id });
      for (const r of rows) {
        await this.appendEvent(
          tx,
          conversationId,
          tenantId,
          status === "failed" ? "turn.failed" : "turn.cancelled",
          r.id,
          {
            reason: reason.slice(0, 500),
          },
        );
      }
      return rows.length > 0;
    });
  }

  private async insertTurn(
    tx: Executor,
    conv: ConvRow,
    t: {
      role: "user" | "assistant";
      authorKind: "human" | "icos";
      authorId: string;
      text: string;
      status: "received" | "completed";
      idempotencyKey?: string;
      outcome?: TurnOutcome;
      replyToTurnId?: string;
      contextSnapshotId?: string | null;
      completedAt?: Date;
      /**
       * Scope to stamp. Defaults to the conversation's current pointer (a fresh user turn).
       * A REPLY must pass the scope its own user turn was resolved under: the conversation's
       * pointer is a moving target, and an assistant turn carrying client A's knowledge must
       * never be stamped with client B.
       */
      scope?: { clientId: string | null; projectId: string | null };
    },
  ): Promise<Turn> {
    const now = this.clock.now();
    const [{ seq }] = await tx
      .update(cognitiveConversations)
      .set({ nextTurnSeq: sql`${cognitiveConversations.nextTurnSeq} + 1`, updatedAt: now })
      .where(eq(cognitiveConversations.id, conv.id))
      .returning({ seq: sql<number>`${cognitiveConversations.nextTurnSeq} - 1` });
    const [row] = await tx
      .insert(cognitiveTurns)
      .values({
        id: this.clock.newId("turn"),
        tenantId: conv.tenantId,
        conversationId: conv.id,
        clientId: t.scope ? t.scope.clientId : conv.clientId,
        projectId: t.scope ? t.scope.projectId : conv.projectId,
        seq,
        role: t.role,
        authorKind: t.authorKind,
        authorId: t.authorId,
        content: { parts: [{ kind: "text", text: t.text }] },
        status: t.status,
        outcome: t.outcome ?? null,
        replyToTurnId: t.replyToTurnId ?? null,
        idempotencyKey: t.idempotencyKey ?? null,
        contextSnapshotId: t.contextSnapshotId ?? null,
        createdAt: now,
        completedAt: t.completedAt ?? null,
      })
      .returning();
    return toTurn(row);
  }

  private async appendEvent(
    tx: Executor,
    conversationId: string,
    tenantId: string,
    type: ConversationEventType,
    turnId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const [{ seq }] = await tx
      .update(cognitiveConversations)
      .set({ nextEventSeq: sql`${cognitiveConversations.nextEventSeq} + 1` })
      .where(eq(cognitiveConversations.id, conversationId))
      .returning({ seq: sql<number>`${cognitiveConversations.nextEventSeq} - 1` });
    await tx.insert(cognitiveEvents).values({
      conversationId,
      seq,
      tenantId,
      type,
      turnId,
      payload,
      createdAt: this.clock.now(),
    });
  }
}
