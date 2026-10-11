/**
 * The per-utterance synthesis port the TTS router drives (decision 0074).
 *
 * `TtsProvider` (core/voice/contracts) stays THE canonical TTS port the voice session
 * sees: one incremental stream per response. Below it, the router splits text into
 * speakable chunks and asks a `SpeechSynthesizer` for each one. A synthesizer is one
 * vendor behind one allowlisted base URL; its vendor-specific knobs (reference id,
 * voice settings, latency mode…) live in its own config and never leak upward.
 */

/** The provider allowlist. Configuration naming anything else is refused. */
export const TTS_PROVIDER_NAMES = ["fish", "elevenlabs", "edge", "gtts"] as const;
export type TtsProviderName = (typeof TTS_PROVIDER_NAMES)[number];

/**
 * Why an attempt failed — decides retry, fallback and circuit behaviour.
 * ABORTED is never a provider failure: the user interrupted on purpose.
 */
export type TtsFailureClass =
  | "AUTH_FAILED" // 401/403, or 402 (credit exhausted): this credential cannot be used now
  | "CONFIG_INVALID" // 404: voice/model id unknown to the provider
  | "RATE_LIMITED" // 429
  | "TIMEOUT" // no first audio in time, total timeout, 408/504
  | "UPSTREAM" // other 5xx, or a 200 that is not audio
  | "UNAVAILABLE" // network failure before any response
  | "INVALID_REQUEST" // 400/422: the request itself was refused
  | "ABORTED"; // cancelled by ICOS (barge-in, stale turn, hangup)

export class TtsProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly failure: TtsFailureClass,
    /** HTTP status when there was one. Never a response body: bodies can echo the request. */
    readonly status?: number,
    /** Seconds, from a 429's Retry-After. */
    readonly retryAfterS?: number,
  ) {
    super(`${provider} ${failure}${status ? ` HTTP ${status}` : ""}`);
    this.name = "TtsProviderError";
  }
}

export type SynthesisRequest = {
  /** Already speech-rendered text (no markdown, no URLs). */
  text: string;
  /** 2-letter language of the session. */
  language: string;
  signal: AbortSignal;
};

export type SynthesisResponse = {
  mime: string;
  /** Audio bytes as the provider streams them; the first chunk is the provider TTFB. */
  body: AsyncIterable<Uint8Array>;
};

export interface SpeechSynthesizer {
  readonly name: TtsProviderName;
  readonly model: string;
  /** Configured voice / reference id, or null when the provider derives it (language). */
  readonly voice: string | null;
  /** True when the provider streams audio bytes as it generates them. */
  readonly streaming: boolean;
  /** Resolves when the provider has answered with audio headers; rejects with TtsProviderError. */
  synthesize(request: SynthesisRequest): Promise<SynthesisResponse>;
  /**
   * A cheap authenticated check that does NOT synthesize (no billed characters).
   * Absent = health comes from real requests only.
   */
  probe?(signal: AbortSignal): Promise<void>;
}

/** Status → failure class. One table for every HTTP provider. */
export function classifyStatus(status: number): TtsFailureClass {
  if (status === 401 || status === 402 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "CONFIG_INVALID";
  if (status === 429) return "RATE_LIMITED";
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 400 || status === 422) return "INVALID_REQUEST";
  return "UPSTREAM";
}

/** Any thrown value → a classified provider error. */
export function classifyError(provider: string, error: unknown): TtsProviderError {
  if (error instanceof TtsProviderError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return new TtsProviderError(provider, "TIMEOUT");
  if (name === "AbortError") return new TtsProviderError(provider, "ABORTED");
  return new TtsProviderError(provider, "UNAVAILABLE");
}

/** A non-2xx HTTP response → error. The body is discarded unread. */
export function httpError(provider: string, response: Response): TtsProviderError {
  void response.body?.cancel().catch(() => {});
  const retryAfter = Number(response.headers.get("retry-after"));
  return new TtsProviderError(
    provider,
    classifyStatus(response.status),
    response.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
  );
}

/** Response body as an async iterable of bytes (fetch bodies are web streams). */
export async function* bytesOf(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return;
      }
      if (value?.length) yield value;
    }
  } finally {
    // The consumer stopped early (abort, timeout): stop downloading audio nobody will play.
    if (!complete) await reader.cancel().catch(() => {});
  }
}

/** Only audio a browser `decodeAudioData` can play is accepted from a provider. */
export function audioMime(provider: string, response: Response, fallback: string): string {
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() || fallback;
  if (!mime.startsWith("audio/")) {
    void response.body?.cancel().catch(() => {});
    throw new TtsProviderError(provider, "UPSTREAM", response.status);
  }
  return mime;
}
