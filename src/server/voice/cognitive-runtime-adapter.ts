import { CURRENT_SINGLE_TENANT_ID } from "@/core/identity/tenant";
import {
  CognitiveUnavailableError,
  type CognitiveEvent,
  type CognitiveRuntimePort,
  type CommittedTurn,
} from "@/core/voice/contracts";
import type { CognitiveActor, CognitiveRuntime } from "@/server/cognitive/cognitive-runtime";
import { CognitiveTurnStream } from "@/server/cognitive/voice-adapter";

/**
 * THE canonical binding of the voice transport onto the Cognitive Runtime (central integration,
 * wave I6; decisions 0056 + 0061). It replaces `ConversationCognitiveAdapter`, the lane's
 * temporary bridge onto the legacy CEO conversation.
 *
 * Acceptance semantics, resolved here rather than papered over:
 * - `submitTurn` resolves when the turn is DURABLE (`acceptTurn`), idempotent on the voice
 *   `turnId` — a replayed frame after a reconnect returns the same durable turn;
 * - progress is read from the durable event log (`CognitiveTurnStream`), so a reconnect resumes
 *   from rows, not from process memory; a dropped socket never cancels the accepted turn;
 * - aborting `signal` (barge-in, user cancel) calls the canonical `cancelTurn`; it never
 *   un-accepts, and a mission the turn launched is untouched (only POST …/decision starts one);
 * - a turn without a conversation gets one owned by the authenticated user; a client-supplied
 *   `conversationId` is a claim the runtime verifies against ownership (`resume` refuses).
 * The runtime does not stream tokens: the reply arrives as one FINAL_RESPONSE.
 */
export class CognitiveRuntimeVoiceAdapter implements CognitiveRuntimePort {
  readonly simulated = false;

  constructor(
    private readonly runtime: CognitiveRuntime,
    /** Roles of the authenticated user, captured at the WebSocket upgrade (never from the client). */
    private readonly rolesOf: (userId: string) => readonly string[],
    private readonly streamFor: (
      runtime: CognitiveRuntime,
      actor: CognitiveActor,
    ) => CognitiveTurnStream = (rt, actor) => new CognitiveTurnStream(rt, actor),
  ) {}

  async submitTurn(
    turn: CommittedTurn,
    signal: AbortSignal,
  ): Promise<{ conversationId: string; events: AsyncIterable<CognitiveEvent> }> {
    const actor: CognitiveActor = {
      tenantId: CURRENT_SINGLE_TENANT_ID,
      userId: turn.userId,
      roles: this.rolesOf(turn.userId),
    };
    let conversationId: string;
    try {
      conversationId = turn.conversationId
        ? (await this.runtime.resume(actor, turn.conversationId)).conversation.id
        : (await this.runtime.createConversation(actor, { title: "Voice" })).id;
    } catch (error) {
      throw new CognitiveUnavailableError(error instanceof Error ? error.message : String(error));
    }

    let accepted: Awaited<ReturnType<CognitiveTurnStream["submitCommittedTurn"]>>;
    try {
      accepted = await this.streamFor(this.runtime, actor).submitCommittedTurn(
        { conversationId, clientTurnId: turn.turnId, text: turn.text },
        signal,
      );
    } catch (error) {
      throw new CognitiveUnavailableError(error instanceof Error ? error.message : String(error));
    }

    const runtime = this.runtime;
    const turnId = accepted.turnId;
    async function* events(): AsyncGenerator<CognitiveEvent> {
      for await (const e of accepted.events) {
        switch (e.type) {
          case "proposal.created": {
            const kind = e.payload.kind;
            yield {
              type: kind === "goal_proposal" ? "MISSION_EVENT" : "APPROVAL_EVENT",
              payload: e.payload,
            };
            break;
          }
          case "turn.completed": {
            // The reply is durable; read it back rather than trusting the event payload alone.
            const state = await runtime.resume(actor, conversationId);
            const reply = state.turns.find(
              (t) => t.replyToTurnId === turnId && t.role === "assistant",
            );
            const text = reply?.content.parts.map((p) => p.text).join("\n") ?? "";
            yield { type: "FINAL_RESPONSE", text };
            return;
          }
          case "turn.failed":
          case "turn.cancelled": {
            const reason = e.payload.reason;
            yield { type: "ERROR", message: typeof reason === "string" ? reason : e.type };
            return;
          }
          default:
            break; // received / processing / context.assembled / memory.written: not spoken.
        }
      }
    }
    return { conversationId, events: events() };
  }
}
