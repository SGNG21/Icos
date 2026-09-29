import {
  CognitiveUnavailableError,
  type CognitiveEvent,
  type CognitiveRuntimePort,
  type CommittedTurn,
} from "@/core/voice/contracts";
import type { CeoBrain } from "@/server/services/ceo-service";
import type { ConversationService } from "@/server/services/conversation-service";

/**
 * TEMPORARY bridge (decision 0056) until the Cognitive Runtime exposes a
 * committed API. It is NOT the Cognitive Runtime. It reuses what ICOS already
 * runs for "Ask ICOS": the conversation store (durable under PERSISTENCE=postgres)
 * and the OmniRoute CEO brain.
 *
 * What it honestly provides:
 * - acceptance = the user message is written to the conversation store;
 * - the answer is produced and stored server-side whatever happens to the
 *   voice connection (a phone that hangs up does not cancel it);
 * - one FINAL_RESPONSE event (the brain is not streaming).
 *
 * Its limits, stated rather than hidden:
 * - turn-id idempotency lives in this process (bounded map): a server restart
 *   forgets it — the store has no turn-id column;
 * - there is no conversation ownership in the store: like POST /api/conversation
 *   it uses the single CEO conversation, gated by `tasks.write`. A client
 *   `conversationId` is ignored, never trusted;
 * - interrupt stops the voice, not the brain: the answer is still stored.
 */
export class ConversationCognitiveAdapter implements CognitiveRuntimePort {
  readonly simulated = false;
  private readonly accepted = new Map<string, Promise<Accepted>>();

  constructor(
    private readonly conversations: ConversationService,
    private readonly brain: () => CeoBrain,
    private readonly maxRemembered = 1_000,
  ) {}

  async submitTurn(
    turn: CommittedTurn,
    signal: AbortSignal,
  ): Promise<{ conversationId: string; events: AsyncIterable<CognitiveEvent> }> {
    let entry = this.accepted.get(turn.turnId);
    if (!entry) {
      entry = this.accept(turn.text);
      this.accepted.set(turn.turnId, entry);
      entry.catch(() => this.accepted.delete(turn.turnId)); // not accepted: a resend may retry
      for (const id of this.accepted.keys()) {
        if (this.accepted.size <= this.maxRemembered) break;
        this.accepted.delete(id);
      }
    }
    const { conversationId, answer } = await entry;
    return { conversationId, events: respond(answer, signal) };
  }

  private async accept(text: string): Promise<Accepted> {
    let conversationId: string;
    try {
      // Same rule as the existing Ask ICOS route: the single CEO conversation.
      const [current] = await this.conversations.listConversations();
      conversationId =
        current?.id ?? (await this.conversations.startConversation("Conversation CEO")).id;
      await this.conversations.addMessage(conversationId, "user", text);
    } catch {
      throw new CognitiveUnavailableError("the conversation store did not accept the turn");
    }
    // Not bound to any voice signal: accepted work finishes server-side.
    return { conversationId, answer: this.answer(conversationId) };
  }

  private async answer(conversationId: string): Promise<Outcome> {
    try {
      const history = await this.conversations.getMessages(conversationId);
      const text = await this.brain().answer(history);
      await this.conversations.addMessage(conversationId, "assistant", text);
      return { ok: true, text };
    } catch {
      return { ok: false };
    }
  }
}

type Outcome = { ok: true; text: string } | { ok: false };
type Accepted = { conversationId: string; answer: Promise<Outcome> };

async function* respond(
  answer: Promise<Outcome>,
  signal: AbortSignal,
): AsyncIterable<CognitiveEvent> {
  const outcome = await answer;
  if (signal.aborted) return;
  yield outcome.ok
    ? { type: "FINAL_RESPONSE", text: outcome.text }
    : { type: "ERROR", message: "the ICOS brain did not answer" };
}
