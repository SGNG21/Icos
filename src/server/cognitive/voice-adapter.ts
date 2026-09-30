import type { ConversationEvent } from "@/core/cognitive/contracts";

import type { CognitiveActor, CognitiveRuntime } from "./cognitive-runtime";

/** A committed utterance from a transport (voice, phone, SMS). */
export interface CommittedTextTurn {
  readonly conversationId: string;
  /** Client-generated turn id: the end-to-end idempotency key (min 8 chars, [A-Za-z0-9._:-]). */
  readonly clientTurnId: string;
  readonly text: string;
}

export interface AcceptedTurn {
  readonly conversationId: string;
  /** Durable server turn id. */
  readonly turnId: string;
  readonly replayed: boolean;
  /** This turn's events from the durable log, ending with its terminal event. */
  readonly events: AsyncIterable<ConversationEvent>;
}

const TERMINAL = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);

/** The stream gave up waiting; the turn itself is untouched (still accepted, not cancelled). */
export class TurnStreamTimeoutError extends Error {
  constructor(readonly turnId: string) {
    super("turn event stream timed out");
    this.name = "TurnStreamTimeoutError";
  }
}

/**
 * Transport adapter with ACCEPTANCE semantics (decision 0057), shaped for the Voice lane's
 * `CognitiveRuntimePort` (feat/voice-realtime): `submitCommittedTurn` resolves once the
 * turn is durable (fast), progress is read from the durable event log (so a reconnect can
 * resume from any seq), and aborting `signal` calls the canonical `cancelTurn` — it never
 * un-accepts the turn. The Voice-side binding (its CommittedTurn/CognitiveEvent types) is
 * NOT_CONNECTED here: it lives in the voice lane.
 */
export class CognitiveTurnStream {
  constructor(
    private readonly runtime: CognitiveRuntime,
    private readonly actor: CognitiveActor,
    private readonly pollMs = 250,
    /** Upper bound on following one turn (the engine call itself is capped at 90 s). */
    private readonly maxWaitMs = 5 * 60_000,
  ) {}

  async submitCommittedTurn(turn: CommittedTextTurn, signal: AbortSignal): Promise<AcceptedTurn> {
    const accepted = await this.runtime.acceptTurn(this.actor, turn.conversationId, {
      text: turn.text,
      idempotencyKey: turn.clientTurnId,
    });
    const turnId = accepted.turn.id;
    const onAbort = () => {
      void this.runtime.cancelTurn(this.actor, turn.conversationId, turnId).catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    return {
      conversationId: turn.conversationId,
      turnId,
      replayed: accepted.replayed,
      events: this.follow(turn.conversationId, turnId, () =>
        signal.removeEventListener("abort", onAbort),
      ),
    };
  }

  private async *follow(
    conversationId: string,
    turnId: string,
    done: () => void,
  ): AsyncGenerator<ConversationEvent> {
    let cursor = 0;
    const deadline = Date.now() + this.maxWaitMs;
    try {
      for (;;) {
        if (Date.now() > deadline) throw new TurnStreamTimeoutError(turnId);
        const batch = await this.runtime.events(this.actor, conversationId, cursor);
        for (const e of batch) {
          cursor = e.seq;
          if (e.turnId !== turnId) continue;
          yield e;
          if (TERMINAL.has(e.type)) return;
        }
        if (batch.length === 0) await new Promise((r) => setTimeout(r, this.pollMs));
      }
    } finally {
      done();
    }
  }
}
