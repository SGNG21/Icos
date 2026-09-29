import {
  CognitiveUnavailableError,
  type CognitiveEvent,
  type CognitiveRuntimePort,
  type CommittedTurn,
  type SttEvent,
  type SttProvider,
  type TtsEvent,
  type TtsProvider,
} from "@/core/voice/contracts";

/**
 * SIMULATED providers — deterministic fakes for tests and local wiring.
 * They are not STT, TTS or a Cognitive Runtime; every one reports
 * `simulated: true` so no latency measured through them passes as real.
 */

/** "Transcribes" each audio frame as its UTF-8 text: partial per frame, one final on finish(). */
export class SimulatedStt implements SttProvider {
  readonly id = "simulated-stt";
  readonly simulated = true;
  failOnWrite = false;
  opened = 0;
  cancelled = 0;
  onEvent: ((event: SttEvent) => void) | null = null;

  open(_options: unknown, onEvent: (event: SttEvent) => void) {
    this.opened += 1;
    this.onEvent = onEvent;
    const words: string[] = [];
    return {
      write: (frame: Uint8Array) => {
        if (this.failOnWrite) return onEvent({ type: "error", message: "simulated STT outage" });
        words.push(Buffer.from(frame).toString("utf8"));
        onEvent({ type: "partial", text: words.join(" ") });
      },
      finish: () =>
        onEvent({ type: "final", text: words.join(" "), language: "fr", confidence: 0.9 }),
      cancel: () => {
        this.cancelled += 1;
      },
    };
  }
}

type SimulatedTtsStream = {
  pending: string[];
  finished: boolean;
  cancelled: boolean;
  /** Emits an event regardless of state — models a provider that misbehaves after cancel. */
  emitRaw: (event: TtsEvent) => void;
};

/** Queues text; `flush()` turns each chunk into one audio chunk ("say:<text>"). */
export class SimulatedTts implements TtsProvider {
  readonly id = "simulated-tts";
  readonly simulated = true;
  failOnText = false;
  readonly streams: SimulatedTtsStream[] = [];

  start(_options: unknown, onEvent: (event: TtsEvent) => void) {
    const stream: SimulatedTtsStream = {
      pending: [],
      finished: false,
      cancelled: false,
      emitRaw: onEvent,
    };
    this.streams.push(stream);
    return {
      text: (chunk: string) => {
        if (this.failOnText) return onEvent({ type: "error", message: "simulated TTS outage" });
        stream.pending.push(chunk);
      },
      finish: () => {
        stream.finished = true;
      },
      cancel: () => {
        stream.cancelled = true;
        stream.pending = [];
      },
    };
  }

  /** Plays everything queued on live streams, then "done" if finished. */
  flush(): void {
    for (const stream of this.streams) {
      if (stream.cancelled) continue;
      for (const chunk of stream.pending.splice(0)) {
        stream.emitRaw({ type: "audio", data: Buffer.from(`say:${chunk}`) });
      }
      if (stream.finished) {
        stream.emitRaw({ type: "done" });
        stream.cancelled = true; // done once
      }
    }
  }
}

/** Minimal push-driven async iterable. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.ended = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

/**
 * Stands in for the Cognitive Runtime: an idempotent turn store (the "durable
 * downstream") plus a scripted response stream per turn.
 */
export class SimulatedCognitiveRuntime implements CognitiveRuntimePort {
  readonly simulated = true;
  available = true;
  /** conversationId → accepted turns, in order. Survives any voice session. */
  readonly conversations = new Map<string, CommittedTurn[]>();
  readonly responses = new Map<string, EventQueue<CognitiveEvent>>();
  readonly aborts: { turnId: string; reason: unknown }[] = [];
  private nextConversation = 1;

  async submitTurn(turn: CommittedTurn, signal: AbortSignal) {
    if (!this.available) throw new CognitiveUnavailableError();
    const conversationId = turn.conversationId ?? `conv-${this.nextConversation++}`;
    const turns = this.conversations.get(conversationId) ?? [];
    if (!turns.some((t) => t.turnId === turn.turnId)) turns.push({ ...turn, conversationId });
    this.conversations.set(conversationId, turns);

    const queue = new EventQueue<CognitiveEvent>();
    this.responses.set(turn.turnId, queue);
    signal.addEventListener("abort", () => {
      this.aborts.push({ turnId: turn.turnId, reason: signal.reason });
      queue.end();
    });
    return { conversationId, events: queue };
  }
}
