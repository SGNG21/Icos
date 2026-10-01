import type {
  CognitiveScope,
  ContextSnapshot,
  Conversation,
  ConversationEvent,
  CreateConversationInput,
  GoalProposal,
  MemoryRecord,
  Participant,
  SubmitTurnInput,
  Turn,
  TurnReference,
  WritebackOutcome,
} from "@/core/cognitive/contracts";
import { rememberSchema } from "@/core/cognitive/contracts";
import { isScopeChange, type ContextResolution } from "@/core/cognitive/client-resolution";
import { maxSensitivityFor } from "@/core/cognitive/context-selection";
import { governOutcome } from "@/core/cognitive/turn-policy";
import type { z } from "zod";

import type { CognitionEngine } from "./cognition";
import type { ContextAssembler } from "./context-assembler";
import { renderContext } from "./context-assembler";
import type { ContextResolver } from "./context-resolver";
import type { ConversationOwner, PostgresConversationStore } from "./conversation-store";
import type { MissionGateway } from "./mission-gateway";
import type { PostgresCognitiveMemoryStore } from "./memory-store";

/** Authenticated human acting on the runtime. Tenant is mandatory (no tenant, no operation). */
export interface CognitiveActor {
  readonly tenantId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

export class ConversationNotFoundError extends Error {
  readonly code = "not_found" as const;
  constructor() {
    super("Conversation introuvable");
    this.name = "ConversationNotFoundError";
  }
}

export interface TurnResult {
  readonly turn: Turn;
  readonly reply: Turn | null;
  readonly proposal: TurnReference | null;
  /** True when this call replayed an already-submitted idempotency key. */
  readonly replayed: boolean;
}

export interface ConversationState {
  readonly conversation: Conversation;
  readonly participants: readonly Participant[];
  readonly turns: readonly Turn[];
  readonly proposals: readonly TurnReference[];
  readonly recoveredTurnIds: readonly string[];
}

const owner = (a: CognitiveActor): ConversationOwner => {
  if (!a.tenantId?.trim()) throw new Error("tenant requis");
  return { tenantId: a.tenantId, userId: a.userId };
};
const scopeOf = (
  a: CognitiveActor,
  c: Pick<Conversation, "clientId" | "projectId">,
): CognitiveScope => ({
  tenantId: a.tenantId,
  userId: a.userId,
  clientId: c.clientId,
  projectId: c.projectId,
});
const textOf = (t: Turn) => t.content.parts.map((p) => p.text).join("\n");

/**
 * Cognitive turn engine (decision 0056):
 * USER TURN → DURABLE CONVERSATION → CONTEXT ASSEMBLY → COGNITION → POLICY
 * → RESPONSE / PROPOSAL → RESULT → MEMORY WRITEBACK.
 *
 * Every step is persisted before the next one runs; a process restart loses at most the
 * in-flight model call, which `resume` closes as `interrupted`.
 */
export class CognitiveRuntime {
  private readonly inflight = new Map<string, AbortController>();
  private readonly background = new Map<string, Promise<unknown>>();

  constructor(
    private readonly deps: {
      conversations: PostgresConversationStore;
      memory: PostgresCognitiveMemoryStore;
      assembler: ContextAssembler;
      /** Resolves « LDS » / « ça » / « reviens » to a scope. Absent ⇒ the pointer never moves. */
      resolver?: ContextResolver;
      engine: CognitionEngine;
      missions: MissionGateway | null;
      tokenBudget?: number;
      staleTurnMs?: number;
    },
  ) {}

  get engineLabel(): string {
    return this.deps.engine.label;
  }

  createConversation(actor: CognitiveActor, input: CreateConversationInput): Promise<Conversation> {
    return this.deps.conversations.create(owner(actor), input);
  }

  listConversations(actor: CognitiveActor): Promise<Conversation[]> {
    return this.deps.conversations.list(owner(actor));
  }

  /** Resume after restart: close interrupted turns, finish approved-but-unlaunched proposals. */
  async resume(actor: CognitiveActor, conversationId: string): Promise<ConversationState> {
    const conversation = await this.requireConversation(actor, conversationId);
    const { conversations } = this.deps;
    const recoveredTurnIds = await conversations.recoverInterrupted(
      conversationId,
      this.deps.staleTurnMs ?? 5 * 60_000,
    );
    for (const ref of await conversations.listRefs(conversationId)) {
      if (ref.status === "approved" || ref.status === "launching")
        await this.launch(conversation, ref);
    }
    return {
      conversation,
      participants: await conversations.participants(conversationId),
      turns: await conversations.listTurns(conversationId),
      proposals: await conversations.listRefs(conversationId),
      recoveredTurnIds,
    };
  }

  /**
   * Blocking submit: resolves when the turn is terminal (completed/failed/cancelled).
   * Idempotent on `idempotencyKey`; a replay returns the original outcome.
   */
  async submitTurn(
    actor: CognitiveActor,
    conversationId: string,
    input: SubmitTurnInput,
  ): Promise<TurnResult> {
    const accepted = await this.begin(actor, conversationId, input);
    if (accepted.replayed) {
      return { ...(await this.turnOutcome(conversationId, accepted.turn)), replayed: true };
    }
    return {
      ...(await this.process(actor, accepted.conversation, accepted.turn)),
      replayed: false,
    };
  }

  /**
   * Acceptance semantics (Voice / phone): resolves as soon as the user turn is DURABLY
   * recorded, with its identity; processing continues in the background and is observed
   * through the event log (`events` / SSE). Idempotent on `idempotencyKey`. A dropped HTTP
   * connection does not cancel an accepted turn; only `cancelTurn` does. A process crash
   * leaves it in-flight, and `resume` closes it as `interrupted`.
   */
  async acceptTurn(
    actor: CognitiveActor,
    conversationId: string,
    input: SubmitTurnInput,
  ): Promise<{ turn: Turn; replayed: boolean }> {
    const accepted = await this.begin(actor, conversationId, input);
    if (!accepted.replayed) {
      const id = accepted.turn.id;
      this.background.set(
        id,
        this.process(actor, accepted.conversation, accepted.turn)
          .catch(() => undefined) // failures are durable (turn.failed), never thrown here
          .finally(() => this.background.delete(id)),
      );
    }
    return { turn: accepted.turn, replayed: accepted.replayed };
  }

  /** Resolves when every background turn of this process has finished (tests, shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.background.values()]);
  }

  private async begin(
    actor: CognitiveActor,
    conversationId: string,
    input: SubmitTurnInput,
  ): Promise<{ conversation: Conversation; turn: Turn; replayed: boolean }> {
    const { conversations } = this.deps;
    const begun = await conversations.beginUserTurn(owner(actor), conversationId, input);
    if (!begun) throw new ConversationNotFoundError();
    const conversation = (await conversations.get(owner(actor), conversationId))!;
    return { conversation, turn: begun.turn, replayed: !begun.created };
  }

  private async process(
    actor: CognitiveActor,
    conversation: Conversation,
    begun: Turn,
  ): Promise<Omit<TurnResult, "replayed">> {
    const { conversations } = this.deps;
    const conversationId = conversation.id;
    let turn = begun;
    if (!(await conversations.markProcessing(actor.tenantId, turn))) {
      return this.turnOutcome(conversationId, turn);
    }
    const abort = new AbortController();
    this.inflight.set(turn.id, abort);
    try {
      // CONTEXT RESOLUTION comes first: everything after it — assembly, cognition, writeback,
      // and any mission launched from this turn — happens under the resolved scope.
      const resolution = await this.resolveScope(actor, conversation, turn);
      if (resolution.kind === "ambiguous") {
        return await this.clarify(actor, conversation, turn, resolution);
      }
      if (
        resolution.kind === "resolved" &&
        this.deps.resolver &&
        isScopeChange(resolution, conversation)
      ) {
        // `setScope` appends `context.resolved` inside the same transaction as the pointer move.
        conversation = await conversations.setScope(
          actor.tenantId,
          conversationId,
          turn.id,
          { clientId: resolution.clientId, projectId: resolution.projectId },
          { source: resolution.source, entityKey: resolution.entityKey },
        );
        // The in-memory turn must carry the scope it was resolved under: its reply and any
        // proposal it produces are stamped from here, never from the conversation's pointer.
        turn = { ...turn, clientId: resolution.clientId, projectId: resolution.projectId };
      } else if (this.deps.resolver) {
        // The scope did not move, but the resolution still has to be observable: a turn whose
        // source is `alias` on the client it is already on must be distinguishable from a turn
        // that referred to nothing at all.
        await conversations
          .recordEvent(actor.tenantId, conversationId, "context.resolved", turn.id, {
            clientId: resolution.clientId,
            projectId: resolution.projectId,
            source: resolution.kind === "resolved" ? resolution.source : "none",
            entityKey: resolution.kind === "resolved" ? resolution.entityKey : null,
            changed: false,
          })
          .catch(() => {});
      }
      const scope = scopeOf(actor, conversation);
      const recent = (
        await conversations.recentTurns(conversationId, turn.seq, 6, scope)
      ).reverse();
      const snapshot = await this.deps.assembler.assemble({
        scope,
        conversationId,
        turn,
        recentTurns: recent,
        maxSensitivity: maxSensitivityFor(actor.roles),
        tokenBudget: this.deps.tokenBudget ?? 2_000,
      });
      await conversations.saveSnapshot(snapshot);
      turn = { ...turn, contextSnapshotId: snapshot.id };

      const thought = await this.deps.engine.think(
        {
          userText: textOf(turn),
          context: renderContext(snapshot),
          conversationTitle: conversation.title,
        },
        abort.signal,
      );
      const governed = governOutcome(thought.result);
      const done = await conversations.completeTurn(actor.tenantId, turn, {
        outcome: governed.outcome,
        reply: governed.reply,
        intent: thought.intent,
        proposal: governed.proposal,
      });
      if (!done) return this.turnOutcome(conversationId, turn);

      await this.writeback(
        scope,
        conversationId,
        turn,
        governed.outcome,
        thought.memorySuggestions,
      );
      return {
        turn: (await conversations.getTurn(conversationId, turn.id))!,
        reply: done.assistant,
        proposal: done.ref,
      };
    } catch (error) {
      const reason = abort.signal.aborted
        ? "cancelled_by_user"
        : `${error instanceof Error ? error.name : "Error"}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
      await conversations.failTurn(actor.tenantId, turn, reason);
      return this.turnOutcome(conversationId, turn);
    } finally {
      this.inflight.delete(turn.id);
    }
  }

  /** Cancels an in-flight turn: durable status first, then aborts the local model call. */
  async cancelTurn(
    actor: CognitiveActor,
    conversationId: string,
    turnId: string,
  ): Promise<boolean> {
    const cancelled = await this.deps.conversations.cancelTurn(
      owner(actor),
      conversationId,
      turnId,
    );
    if (cancelled) this.inflight.get(turnId)?.abort();
    return cancelled;
  }

  async decideProposal(
    actor: CognitiveActor,
    conversationId: string,
    refId: string,
    decision: "approve" | "reject",
  ): Promise<
    { ok: true; proposal: TurnReference } | { ok: false; reason: "not_found" | "already_decided" }
  > {
    const conversation = await this.requireConversation(actor, conversationId);
    // The decision is committed first: from here on the launch is durable work that a
    // dropped connection or a crash cannot lose (resume / recoverLaunches finish it).
    const decided = await this.deps.conversations.decideRef(
      owner(actor),
      conversationId,
      refId,
      decision,
    );
    if (!decided.ok) return decided;
    if (decision === "reject") return { ok: true, proposal: decided.ref };
    return { ok: true, proposal: await this.launch(conversation, decided.ref) };
  }

  async getContext(
    actor: CognitiveActor,
    conversationId: string,
    turnId: string,
  ): Promise<{ snapshot: ContextSnapshot; memories: MemoryRecord[] } | null> {
    await this.requireConversation(actor, conversationId);
    const snapshot = await this.deps.conversations.getSnapshot(
      owner(actor),
      conversationId,
      turnId,
    );
    if (!snapshot) return null;
    // The scope THIS turn was assembled under: after a client switch, the conversation's
    // current pointer would hide the memories the turn actually used.
    const scope: CognitiveScope = {
      tenantId: actor.tenantId,
      userId: actor.userId,
      clientId: snapshot.scope.clientId,
      projectId: snapshot.scope.projectId,
    };
    const memories: MemoryRecord[] = [];
    for (const item of snapshot.items) {
      if (!item.ref.startsWith("memory:")) continue;
      const r = await this.deps.memory.get(scope, item.ref.slice("memory:".length));
      if (r) memories.push(r);
    }
    return { snapshot, memories };
  }

  async events(
    actor: CognitiveActor,
    conversationId: string,
    afterSeq: number,
  ): Promise<ConversationEvent[]> {
    await this.requireConversation(actor, conversationId);
    return this.deps.conversations.listEvents(conversationId, afterSeq);
  }

  /** Explicit human "remember this": the only path to USER_ASSERTED memory. */
  remember(
    actor: CognitiveActor,
    input: z.output<typeof rememberSchema>,
  ): Promise<WritebackOutcome> {
    const scope: CognitiveScope = {
      tenantId: owner(actor).tenantId,
      userId: actor.userId,
      clientId: input.clientId ?? null,
      projectId: input.projectId ?? null,
    };
    return this.deps.memory.write(scope, {
      type: input.type,
      subjectKey: input.subjectKey,
      content: input.content,
      epistemic: "USER_ASSERTED",
      statementKind: input.statementKind,
      confidence: 1,
      originTrust: "trusted",
      provenance: {
        sourceType: "api",
        sourceId: `user:${actor.userId}`,
        conversationId: null,
        turnId: null,
        engine: null,
      },
      entityKey: input.entityKey,
      personal: input.personal,
      sensitivity: input.sensitivity,
      tags: input.tags,
    });
  }

  memoryHistory(
    actor: CognitiveActor,
    scope: Omit<CognitiveScope, "tenantId" | "userId">,
    id: string,
  ): Promise<MemoryRecord[]> {
    return this.deps.memory.history(
      { tenantId: owner(actor).tenantId, userId: actor.userId, ...scope },
      id,
    );
  }

  /** Memory candidates awaiting a human decision in this scope. */
  memoryCandidates(
    actor: CognitiveActor,
    scope: Omit<CognitiveScope, "tenantId" | "userId">,
  ): Promise<MemoryRecord[]> {
    return this.deps.memory.candidates({
      tenantId: owner(actor).tenantId,
      userId: actor.userId,
      ...scope,
    });
  }

  /**
   * MODEL_INFERRED → candidate → HUMAN REVIEW → active. The reviewer is the authenticated
   * human; the record keeps its epistemic status and gains `reviewedBy`.
   */
  reviewMemory(
    actor: CognitiveActor,
    scope: Omit<CognitiveScope, "tenantId" | "userId">,
    id: string,
    decision: "accept" | "reject",
  ): Promise<MemoryRecord | null> {
    return this.deps.memory.review(
      { tenantId: owner(actor).tenantId, userId: actor.userId, ...scope },
      id,
      decision,
    );
  }

  /** Right to erasure: tombstone (content erased, provenance kept). */
  forgetMemory(
    actor: CognitiveActor,
    scope: Omit<CognitiveScope, "tenantId" | "userId">,
    id: string,
  ): Promise<boolean> {
    return this.deps.memory.forget(
      { tenantId: owner(actor).tenantId, userId: actor.userId, ...scope },
      id,
    );
  }

  // ── internals ──────────────────────────────────────────────────────────────
  /**
   * Which client/project this turn is about. With no resolver wired the pointer never moves
   * and the conversation keeps the scope it was created with (previous behaviour).
   */
  private async resolveScope(
    actor: CognitiveActor,
    conversation: Conversation,
    turn: Turn,
  ): Promise<ContextResolution> {
    if (!this.deps.resolver) {
      return {
        kind: "unchanged",
        clientId: conversation.clientId,
        projectId: conversation.projectId,
      };
    }
    return await this.deps.resolver.resolve({
      owner: owner(actor),
      conversation,
      text: textOf(turn),
      maxSensitivity: maxSensitivityFor(actor.roles),
    });
  }

  /**
   * Two plausible clients, or a reference to a context that does not exist: ICOS asks instead
   * of choosing. The model is NOT consulted, no proposal is created and NOTHING is written to
   * memory — a guessed entity link is exactly the kind of durable mistake this lane must not
   * make. The question and the ambiguity state are recorded on the event log.
   */
  private async clarify(
    actor: CognitiveActor,
    conversation: Conversation,
    turn: Turn,
    resolution: Extract<ContextResolution, { kind: "ambiguous" }>,
  ): Promise<Omit<TurnResult, "replayed">> {
    const { conversations } = this.deps;
    await conversations
      .recordEvent(actor.tenantId, conversation.id, "context.resolved", turn.id, {
        ambiguity: resolution.reason,
        candidates: resolution.candidates,
        clientId: null,
        projectId: null,
        source: "none",
      })
      .catch(() => {});
    const done = await conversations.completeTurn(actor.tenantId, turn, {
      outcome: "CLARIFICATION",
      reply: resolution.question,
      intent: `context.${resolution.reason}`,
    });
    if (!done) return this.turnOutcome(conversation.id, turn);
    return {
      turn: (await conversations.getTurn(conversation.id, turn.id))!,
      reply: done.assistant,
      proposal: null,
    };
  }

  private async requireConversation(actor: CognitiveActor, id: string): Promise<Conversation> {
    const c = await this.deps.conversations.get(owner(actor), id);
    if (!c) throw new ConversationNotFoundError();
    return c;
  }

  private async turnOutcome(
    conversationId: string,
    turn: Turn,
  ): Promise<Omit<TurnResult, "replayed">> {
    const { conversations } = this.deps;
    const turns = await conversations.listTurns(conversationId);
    const current = turns.find((t) => t.id === turn.id) ?? turn;
    const reply = turns.find((t) => t.replyToTurnId === turn.id) ?? null;
    const proposal =
      (await conversations.listRefs(conversationId)).find((r) => r.turnId === turn.id) ?? null;
    return { turn: current, reply, proposal };
  }

  /**
   * APPROVED → LAUNCHING → LAUNCHED | FAILED through the canonical gateway. Safe to call
   * again at any point (recovery): the store only moves forward, and the gateway is
   * idempotent on the proposal, so a relaunch returns the same goal/job/mission.
   */
  private async launch(conversation: Conversation, ref: TurnReference): Promise<TurnReference> {
    const { conversations, missions } = this.deps;
    const tenantId = conversation.tenantId;
    const launching = await conversations.beginLaunch(tenantId, ref);
    if (!launching)
      return (await conversations.listRefs(conversation.id)).find((r) => r.id === ref.id) ?? ref;
    if (launching.kind !== "goal_proposal" || !missions) {
      return conversations.finishLaunch(tenantId, launching, {
        status: "not_connected",
        reason: `${launching.kind}: no canonical backend connected`,
      });
    }
    try {
      const result = await missions.launch(launching.payload as GoalProposal, {
        refId: launching.id,
        conversationId: conversation.id,
        turnId: launching.turnId,
        approvedBy: launching.decidedBy ?? conversation.ownerUserId,
        // The scope the proposal was MADE under: approving an LDS mission after the
        // conversation has switched to another client must still launch under LDS.
        clientId: launching.clientId,
        projectId: launching.projectId,
      });
      return conversations.finishLaunch(tenantId, launching, result);
    } catch (error) {
      // Left LAUNCHING on purpose when the failure may be transient (e.g. database down):
      // recovery retries idempotently. Only a deterministic refusal is recorded as FAILED.
      if (error instanceof Error && error.name === "ZodError") {
        return conversations.finishLaunch(tenantId, launching, {
          status: "failed",
          reason: "invalid_goal",
        });
      }
      throw error;
    }
  }

  /**
   * Restart recovery for launches (no HTTP caller needed): every APPROVED or LAUNCHING
   * proposal of the tenant is launched idempotently. Called when the runtime is composed.
   */
  async recoverLaunches(tenantId: string): Promise<{ recovered: number; failed: number }> {
    let recovered = 0;
    let failed = 0;
    for (const ref of await this.deps.conversations.pendingLaunches(tenantId)) {
      const conversation = await this.deps.conversations.conversationOf(ref.conversationId);
      if (!conversation) continue;
      try {
        const settled = await this.launch(conversation, ref);
        if (settled.status === "launched") recovered++;
      } catch {
        failed++;
      }
    }
    return { recovered, failed };
  }

  /**
   * Memory writeback after the result is durable. The exchange itself is a
   * SYSTEM_OBSERVED episodic observation; model suggestions are MODEL_INFERRED
   * candidates (never active facts). A writeback failure never un-completes the turn.
   */
  private async writeback(
    scope: CognitiveScope,
    conversationId: string,
    turn: Turn,
    outcome: string,
    suggestions: readonly {
      type: MemoryRecord["type"];
      subjectKey: string;
      content: string;
      entityKey?: string;
    }[],
  ): Promise<void> {
    const provenance = {
      sourceType: "turn" as const,
      sourceId: turn.id,
      conversationId,
      turnId: turn.id,
    };
    const results: {
      subjectKey: string;
      outcome: string;
      memoryId: string | null;
      clientId: string | null;
      projectId: string | null;
    }[] = [];
    const write = async (subjectKey: string, run: () => Promise<WritebackOutcome>) => {
      try {
        const r = await run();
        results.push({
          subjectKey,
          outcome: r.kind,
          memoryId: "record" in r ? r.record.id : "existingId" in r ? r.existingId : null,
          clientId: scope.clientId,
          projectId: scope.projectId,
        });
      } catch (error) {
        results.push({
          subjectKey,
          outcome: `error:${error instanceof Error ? error.name : "unknown"}`,
          memoryId: null,
          clientId: scope.clientId,
          projectId: scope.projectId,
        });
      }
    };
    await write(`turn.${turn.seq}`, () =>
      this.deps.memory.write(scope, {
        type: "episodic",
        subjectKey: `conversation.${conversationId}.turn.${turn.seq}`,
        content: `Demande utilisateur (${outcome}) : ${textOf(turn).slice(0, 1_500)}`,
        epistemic: "SYSTEM_OBSERVED",
        statementKind: "observation",
        confidence: 1,
        originTrust: "trusted",
        provenance: { ...provenance, engine: null },
      }),
    );
    for (const s of suggestions) {
      await write(s.subjectKey, () =>
        this.deps.memory.write(scope, {
          type: s.type,
          subjectKey: s.subjectKey,
          content: s.content,
          entityKey: s.entityKey,
          epistemic: "MODEL_INFERRED",
          statementKind: "inference",
          confidence: 0.5,
          originTrust: "trusted",
          provenance: { ...provenance, engine: this.deps.engine.label },
        }),
      );
    }
    await this.deps.conversations
      .recordEvent(scope.tenantId, conversationId, "memory.written", turn.id, { results })
      .catch(() => {});
  }
}
