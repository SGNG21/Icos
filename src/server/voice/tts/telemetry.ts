import type { CircuitState } from "./circuit-breaker";
import type { TtsFailureClass } from "./synthesizer";

/**
 * TTS observability (decision 0074). Events carry ids, provider identity, timings and
 * raw usage — never text, audio, keys, URLs or provider response bodies. The type is
 * the allowlist: a field that is not declared here cannot be logged.
 */
export type TtsTelemetryEvent = {
  event:
    | "tts.requested"
    | "tts.provider.selected"
    | "tts.first_audio"
    | "tts.completed"
    /** The answer ended with nothing spoken: every chunk was lost. */
    | "tts.failed"
    /** One chunk failed on every provider; the rest of the answer went on. */
    | "tts.chunk_lost"
    | "tts.fallback"
    | "tts.aborted";
  streamId: string;
  turnId?: string;
  provider?: string;
  model?: string;
  voice?: string | null;
  attempt?: number;
  circuitState?: CircuitState;
  fallbackUsed?: boolean;
  /** tts.fallback: the provider given up on, and why. */
  from?: string;
  failure?: TtsFailureClass;
  status?: number;
  reason?: string;
  /** Provider request start → first audio byte. */
  providerTtfbMs?: number;
  /** Stream start (first text) → first audio handed to the session. */
  firstAudioMs?: number;
  totalMs?: number;
  /** Billing inputs, raw: characters sent, audio bytes received. No price is computed here. */
  chars?: number;
  bytes?: number;
  chunks?: number;
  /** Chunks lost to synthesis failure while the stream continued. */
  lostChunks?: number;
  retries?: number;
  fallbacks?: number;
};

export type TtsObserver = (event: TtsTelemetryEvent) => void;

/**
 * The voice host's default sink: one line per answer (`tts.completed`, with first-audio
 * latency and provider TTFB) plus the events an operator acts on (`tts.fallback`,
 * `tts.failed`). Per-request events stay available to any injected observer, so the log
 * is not flooded with one line per chunk or per barge-in.
 */
export const logTtsEvent: TtsObserver = (event) => {
  if (
    event.event !== "tts.completed" &&
    event.event !== "tts.fallback" &&
    event.event !== "tts.failed"
  ) {
    return;
  }
  console.warn(`TTS_EVENT ${JSON.stringify(event)}`);
};

/** Raw, cumulative billing inputs per provider since the process started. */
export type TtsUsage = {
  provider: string;
  model: string;
  requests: number;
  succeeded: number;
  failed: number;
  retries: number;
  /** Times the router left this provider for the next one. */
  fallbacksFrom: number;
  characters: number;
  bytes: number;
};
