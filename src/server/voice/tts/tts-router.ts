import type { TtsEvent, TtsProvider, TtsStream } from "@/core/voice/contracts";

import {
  CircuitBreaker,
  DEFAULT_CIRCUIT,
  type CircuitOptions,
  type CircuitSnapshot,
} from "./circuit-breaker";
import { DEFAULT_CHUNKING, SpeechChunker, type ChunkingOptions } from "./speech-text";
import {
  classifyError,
  TtsProviderError,
  type SpeechSynthesizer,
  type TtsFailureClass,
  type TtsProviderName,
} from "./synthesizer";
import type { TtsObserver, TtsTelemetryEvent, TtsUsage } from "./telemetry";

/**
 * The ICOS TTS router (decision 0074). It IS a `TtsProvider` — the canonical port the
 * voice session already speaks — so nothing above it knows a vendor exists:
 *
 *   answer deltas → SpeechChunker (speech rendering + natural boundaries)
 *     → per chunk: providers in configured order, each behind its circuit breaker
 *       → first provider that returns audio wins; its audio goes out in order.
 *
 * Fallback is by failure class: an abort never falls back (the user interrupted on
 * purpose), a refused request is not resent to every provider, a 5xx gets a bounded
 * retry. Once a fallback provider has spoken, the rest of THAT answer stays on it, so
 * one sentence never changes voice mid-answer; the next answer starts at the primary.
 *
 * OmniRoute is one adapter below this router (edge / gtts), not a second router: its
 * /v1/audio/speech serves one provider per request and has no TTS fallback.
 */

export type TtsHealthState =
  | "NOT_CONFIGURED"
  /** Configured, but nothing has proven it works yet: a key is not health. */
  | "UNVERIFIED"
  | "READY"
  | "DEGRADED"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "UNAVAILABLE"
  | "TIMEOUT";

export type TtsProviderHealth = {
  provider: string;
  state: TtsHealthState;
  model?: string;
  voice?: string | null;
  /** Why it is not configured, or what the last failure was. Never a secret. */
  detail?: string;
  circuit?: CircuitSnapshot;
  lastProbe?: { at: number; ok: boolean; failure?: TtsFailureClass };
};

export type TtsRouterOptions = {
  /** Configured providers, in routing order. */
  providers: SpeechSynthesizer[];
  /** Providers that are listed but not configured, for an honest status. */
  unconfigured?: { provider: string; reason: string }[];
  fallbackEnabled?: boolean;
  /** Extra attempts on the SAME provider for UPSTREAM / UNAVAILABLE, before falling back. */
  retries?: number;
  /** Whole attempt, request to last byte. */
  timeoutMs?: number;
  /** Request to first audio byte, for streaming providers. */
  firstAudioTimeoutMs?: number;
  chunking?: ChunkingOptions;
  circuit?: CircuitOptions;
  /** 2-letter language used when the session states none. */
  defaultLanguage?: string;
  observer?: TtsObserver;
  now?: () => number;
  newId?: () => string;
  probeTimeoutMs?: number;
  /** A probe result is reused this long: health never hammers a provider. */
  probeTtlMs?: number;
};

type Entry = {
  synth: SpeechSynthesizer;
  breaker: CircuitBreaker;
  usage: TtsUsage;
  probe?: { at: number; ok: boolean; failure?: TtsFailureClass };
  probing?: Promise<void>;
};

type Audio = { data: Uint8Array; mime: string; provider: TtsProviderName; ttfbMs: number };

type StreamContext = {
  streamId: string;
  turnId?: string;
  language: string;
  signal: AbortSignal;
  /** Index of the provider this answer currently starts from. */
  sticky: number;
  fallbackUsed: boolean;
  fallbacks: number;
  retries: number;
};

class Aborted extends Error {}

/** 2-letter language code, or null when the tag is not one. */
function languageCode(tag: string | undefined): string | null {
  const code = tag?.trim().slice(0, 2).toLowerCase();
  return code && /^[a-z]{2}$/.test(code) ? code : null;
}

function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => (signal.removeEventListener("abort", onAbort), resolve(value)),
      (error: unknown) => (signal.removeEventListener("abort", onAbort), reject(error)),
    );
  });
}

export class TtsRouter implements TtsProvider {
  readonly id: string;
  readonly simulated = false;
  private readonly entries: Entry[];
  private readonly o: Required<Omit<TtsRouterOptions, "providers" | "observer">> & {
    observer: TtsObserver;
  };

  constructor(options: TtsRouterOptions) {
    let next = 0;
    this.o = {
      unconfigured: [],
      fallbackEnabled: true,
      retries: 1,
      timeoutMs: 15_000,
      firstAudioTimeoutMs: 5_000,
      chunking: DEFAULT_CHUNKING,
      circuit: DEFAULT_CIRCUIT,
      defaultLanguage: "fr",
      observer: () => {},
      now: Date.now,
      newId: () => `tts-${++next}`,
      probeTimeoutMs: 5_000,
      probeTtlMs: 60_000,
      ...options,
    };
    this.entries = options.providers.map((synth) => ({
      synth,
      breaker: new CircuitBreaker(this.o.circuit, this.o.now),
      usage: {
        provider: synth.name,
        model: synth.model,
        requests: 0,
        succeeded: 0,
        failed: 0,
        retries: 0,
        fallbacksFrom: 0,
        characters: 0,
        bytes: 0,
      },
    }));
    this.id = `router:${options.providers.map((p) => p.name).join(">") || "none"}`;
  }

  get configured(): boolean {
    return this.entries.length > 0;
  }

  start(options: { language?: string; turnId?: string }, onEvent: (event: TtsEvent) => void) {
    const startedAt = this.o.now();
    const cancelled = new AbortController();
    const ctx: StreamContext = {
      streamId: this.o.newId(),
      ...(options.turnId ? { turnId: options.turnId } : {}),
      language: languageCode(options.language) ?? this.o.defaultLanguage,
      signal: cancelled.signal,
      sticky: 0,
      fallbackUsed: false,
      fallbacks: 0,
      retries: 0,
    };
    const chunker = new SpeechChunker(this.o.chunking);
    const queue: string[] = [];
    let running = false;
    let finished = false;
    let ended = false;
    let firstAudio: { firstAudioMs: number; providerTtfbMs: number } | null = null;
    let lastProvider: string | undefined;
    const totals = { chars: 0, bytes: 0, chunks: 0 };
    /** Chunks every provider failed on; the stream went on without them. */
    let lost = 0;
    let lastFailure: TtsProviderError | null = null;
    const tell = (event: Omit<TtsTelemetryEvent, "streamId" | "turnId">) =>
      this.observe({
        streamId: ctx.streamId,
        ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
        ...event,
      });
    tell({ event: "tts.requested" });

    const end = (event: TtsTelemetryEvent["event"], extra: Partial<TtsTelemetryEvent> = {}) => {
      ended = true;
      tell({
        event,
        totalMs: this.o.now() - startedAt,
        ...totals,
        fallbackUsed: ctx.fallbackUsed,
        fallbacks: ctx.fallbacks,
        retries: ctx.retries,
        ...(lastProvider ? { provider: lastProvider } : {}),
        ...(firstAudio ?? {}),
        ...extra,
      });
    };

    const pump = () => {
      if (running || ended) return;
      const next = queue.shift();
      if (next === undefined) {
        if (finished) {
          // Nothing spoken and something lost: the answer was mute, not completed.
          if (lost > 0 && totals.chunks === 0) {
            end("tts.failed", {
              reason: lastFailure ? "ALL_PROVIDERS_FAILED" : "INTERNAL",
              ...(lastFailure ? { failure: lastFailure.failure } : {}),
              lostChunks: lost,
            });
          } else {
            end("tts.completed", lost > 0 ? { lostChunks: lost } : {});
          }
          onEvent({ type: "done" });
        }
        return;
      }
      running = true;
      this.speakChunk(next, ctx)
        .then((audio) => {
          if (ended) return;
          lastProvider = audio.provider;
          totals.chars += next.length;
          totals.bytes += audio.data.length;
          totals.chunks += 1;
          if (!firstAudio) {
            firstAudio = {
              firstAudioMs: this.o.now() - startedAt,
              providerTtfbMs: audio.ttfbMs,
            };
            tell({
              event: "tts.first_audio",
              provider: audio.provider,
              ...firstAudio,
              fallbackUsed: ctx.fallbackUsed,
            });
          }
          onEvent({
            type: "audio",
            data: audio.data,
            mime: audio.mime,
            provider: audio.provider,
            fallback: ctx.fallbackUsed,
          });
        })
        .catch((error: unknown) => {
          if (ended || error instanceof Aborted) return;
          const failure = error instanceof TtsProviderError ? error : null;
          lost += 1;
          lastFailure = failure;
          tell({
            event: "tts.chunk_lost",
            reason: failure ? "ALL_PROVIDERS_FAILED" : "INTERNAL",
            ...(failure ? { failure: failure.failure } : {}),
          });
          /*
           * One lost chunk DEGRADES the answer; it does not end it. Ending the stream here
           * would let a single refused or rate-limited sentence silence every sentence
           * after it. The loss is reported non-fatally and the queue keeps going, in order;
           * the session decides at the end whether the answer was degraded or mute.
           */
          onEvent({
            type: "error",
            message: failure
              ? `speech synthesis failed (${failure.message})`
              : "speech synthesis failed",
            timeout: failure?.failure === "TIMEOUT",
            fatal: false,
          });
        })
        .finally(() => {
          running = false;
          pump();
        });
    };

    const stream: TtsStream = {
      text: (chunk: string) => {
        if (finished || ended) return;
        queue.push(...chunker.push(chunk));
        pump();
      },
      finish: () => {
        if (finished || ended) return;
        finished = true;
        queue.push(...chunker.flush());
        pump();
      },
      cancel: (reason) => {
        if (cancelled.signal.aborted) return;
        cancelled.abort(reason ?? "CANCELLED");
        queue.length = 0;
        if (!ended) end("tts.aborted", { reason: reason ?? "CANCELLED" });
      },
    };
    return stream;
  }

  /** One chunk through the provider chain. Rejects with Aborted, or the last provider error. */
  private async speakChunk(text: string, ctx: StreamContext): Promise<Audio> {
    const last = this.o.fallbackEnabled ? this.entries.length : Math.min(1, this.entries.length);
    let lastError: TtsProviderError | null = null;
    for (let index = ctx.sticky; index < last; index++) {
      const entry = this.entries[index];
      if (!entry.breaker.tryAcquire()) {
        lastError = new TtsProviderError(entry.synth.name, "UNAVAILABLE");
        continue; // circuit open: skip without a request
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const audio = await this.attempt(entry, text, ctx, attempt);
          entry.breaker.onSuccess();
          entry.usage.succeeded += 1;
          ctx.sticky = index;
          // Not the first provider = a fallback, whether it failed or its circuit was open.
          ctx.fallbackUsed ||= index > 0;
          return audio;
        } catch (error) {
          if (ctx.signal.aborted) {
            entry.breaker.onNeutral();
            throw new Aborted();
          }
          const failure = classifyError(entry.synth.name, error);
          entry.usage.failed += 1;
          entry.breaker.onFailure(failure.failure, failure.retryAfterS);
          lastError = failure;
          // The text itself was refused: another vendor would most likely refuse it too.
          if (failure.failure === "INVALID_REQUEST") throw failure;
          const transient = failure.failure === "UPSTREAM" || failure.failure === "UNAVAILABLE";
          if (transient && attempt < this.o.retries && entry.breaker.tryAcquire()) {
            entry.usage.retries += 1;
            ctx.retries += 1;
            continue;
          }
          break;
        }
      }
      if (index + 1 < last) {
        entry.usage.fallbacksFrom += 1;
        ctx.fallbacks += 1;
        ctx.fallbackUsed = true;
        this.observe({
          event: "tts.fallback",
          streamId: ctx.streamId,
          ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
          from: entry.synth.name,
          provider: this.entries[index + 1].synth.name,
          ...(lastError ? { failure: lastError.failure } : {}),
          ...(lastError?.status ? { status: lastError.status } : {}),
        });
      }
    }
    throw lastError ?? new TtsProviderError("router", "UNAVAILABLE");
  }

  private async attempt(
    entry: Entry,
    text: string,
    ctx: StreamContext,
    attempt: number,
  ): Promise<Audio> {
    const { synth } = entry;
    const firstAudio = new AbortController();
    const signal = AbortSignal.any([
      ctx.signal,
      firstAudio.signal,
      AbortSignal.timeout(this.o.timeoutMs),
    ]);
    entry.usage.requests += 1;
    entry.usage.characters += text.length;
    this.observe({
      event: "tts.provider.selected",
      streamId: ctx.streamId,
      ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
      provider: synth.name,
      model: synth.model,
      voice: synth.voice,
      attempt,
      circuitState: entry.breaker.current,
      fallbackUsed: ctx.fallbackUsed,
    });
    const requestedAt = this.o.now();
    // A buffered (non-streaming) provider's first byte IS its last: only the total applies.
    const timer = setTimeout(
      () => firstAudio.abort(new DOMException("no first audio in time", "TimeoutError")),
      synth.streaming ? this.o.firstAudioTimeoutMs : this.o.timeoutMs,
    );
    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
      const response = await raceAbort(
        synth.synthesize({ text, language: ctx.language, signal }),
        signal,
      );
      iterator = response.body[Symbol.asyncIterator]();
      const parts: Uint8Array[] = [];
      let bytes = 0;
      let ttfbMs = -1;
      for (;;) {
        const next = await raceAbort(iterator.next(), signal);
        if (next.done) break;
        if (ttfbMs < 0) {
          ttfbMs = this.o.now() - requestedAt;
          clearTimeout(timer);
        }
        parts.push(next.value);
        bytes += next.value.length;
      }
      iterator = undefined;
      if (bytes === 0) throw new TtsProviderError(synth.name, "UPSTREAM");
      entry.usage.bytes += bytes;
      return { data: concat(parts, bytes), mime: response.mime, provider: synth.name, ttfbMs };
    } catch (error) {
      if (ctx.signal.aborted) throw new Aborted();
      if (firstAudio.signal.aborted) throw new TtsProviderError(synth.name, "TIMEOUT");
      throw classifyError(synth.name, signal.aborted ? signal.reason : error);
    } finally {
      clearTimeout(timer);
      if (iterator) void Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }

  private observe(event: TtsTelemetryEvent): void {
    try {
      this.o.observer(event);
    } catch {
      // telemetry must never break speech
    }
  }

  /** Health from evidence already held (requests, probes). No network. */
  health(): TtsProviderHealth[] {
    const configured = this.entries.map((entry): TtsProviderHealth => {
      const circuit = entry.breaker.snapshot();
      return {
        provider: entry.synth.name,
        model: entry.synth.model,
        voice: entry.synth.voice,
        state: healthState(circuit, entry.probe),
        circuit,
        ...(circuit.lastFailureClass ? { detail: `last failure ${circuit.lastFailureClass}` } : {}),
        ...(entry.probe ? { lastProbe: entry.probe } : {}),
      };
    });
    return [
      ...configured,
      ...this.o.unconfigured.map((u): TtsProviderHealth => ({
        provider: u.provider,
        state: "NOT_CONFIGURED",
        detail: u.reason,
      })),
    ];
  }

  /**
   * Refresh evidence with each provider's cheap probe (no synthesis), at most once per
   * `probeTtlMs`. A probe never opens a circuit: only real requests route traffic away.
   */
  async probe(): Promise<TtsProviderHealth[]> {
    await Promise.all(
      this.entries.map((entry) => {
        const probe = entry.synth.probe?.bind(entry.synth);
        if (!probe) return undefined;
        if (entry.probing) return entry.probing;
        if (entry.probe && this.o.now() - entry.probe.at < this.o.probeTtlMs) return undefined;
        entry.probing = probe(AbortSignal.timeout(this.o.probeTimeoutMs))
          .then(
            () => {
              entry.probe = { at: this.o.now(), ok: true };
            },
            (error: unknown) => {
              const failure = classifyError(entry.synth.name, error).failure;
              entry.probe = { at: this.o.now(), ok: false, failure };
            },
          )
          .finally(() => {
            entry.probing = undefined;
          });
        return entry.probing;
      }),
    );
    return this.health();
  }

  /** Raw cumulative billing inputs per provider. Prices belong to the pricing registry. */
  usage(): TtsUsage[] {
    return this.entries.map((entry) => ({ ...entry.usage }));
  }
}

function failureHealth(failure: TtsFailureClass | null | undefined): TtsHealthState {
  if (failure === "AUTH_FAILED") return "AUTH_FAILED";
  if (failure === "RATE_LIMITED") return "RATE_LIMITED";
  if (failure === "TIMEOUT") return "TIMEOUT";
  return "UNAVAILABLE";
}

function healthState(circuit: CircuitSnapshot, probe: Entry["probe"]): TtsHealthState {
  if (circuit.state === "open") return failureHealth(circuit.lastFailureClass);
  if (circuit.state === "half_open" || circuit.consecutiveFailures > 0) return "DEGRADED";
  const requestAt = circuit.lastSuccessAt ?? -Infinity;
  if (probe && probe.at > requestAt) return probe.ok ? "READY" : failureHealth(probe.failure);
  return circuit.lastSuccessAt !== null ? "READY" : "UNVERIFIED";
}

function concat(parts: Uint8Array[], length: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
