import type { SttEvent, SttProvider, TtsEvent, TtsProvider } from "@/core/voice/contracts";

import { renderSpeech, SENTENCE_CHUNKING } from "./tts/speech-text";
import {
  audioMime,
  bytesOf,
  classifyError,
  classifyStatus,
  TtsProviderError,
  type SpeechSynthesizer,
  type SynthesisRequest,
  type SynthesisResponse,
} from "./tts/synthesizer";
import { TtsRouter } from "./tts/tts-router";

/**
 * Real STT/TTS through OmniRoute, the AI gateway ICOS already uses
 * (OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech`).
 * Models are configuration: ICOS_VOICE_STT_MODEL / ICOS_VOICE_TTS_MODEL.
 * Absent = NOT_CONFIGURED; nothing is faked.
 *
 * ponytail: the gateway's STT is request/response, not streaming. Partials are
 * re-transcriptions of the growing utterance (one in flight at a time); the
 * final is one request after end of speech. A streaming provider can replace
 * this class without touching the session engine.
 */

type Fetch = typeof fetch;

export type OmniRouteVoiceConfig = {
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  /** Per HTTP request; a timeout is reported as such, not as an outage. */
  requestTimeoutMs?: number;
};

export type VoiceProviderStatus = "CONFIGURED" | "NOT_CONFIGURED";

/**
 * Language the providers use when the voice session states none (the client normally
 * sends `navigator.language`). Configured, not hardcoded: the session locale still
 * wins, so multilingual use keeps working — this only decides the fallback.
 */
export const DEFAULT_VOICE_LANGUAGE = "fr";

/**
 * A gateway voice id from a session language. This is the FALLBACK only, for backends
 * that have no voice concept: gTTS reads the OpenAI `voice` field as a language code
 * and accepts "fr" but answers 502 to "fr-FR", so this narrows to the 2-letter code —
 * the same normalization STT does. Returns null for anything that is not a language
 * tag, so the caller can fall back.
 *
 * A real voice is NOT a language. Set ICOS_VOICE_TTS_VOICE and it is sent verbatim
 * instead (see `ttsVoiceId`): narrowing it here is what made every premium backend
 * unreachable — a Fish Audio `reference_id` or an ElevenLabs voice id arrived at the
 * gateway sliced to its first two characters.
 */
export function ttsVoice(language: string | undefined): string | null {
  const code = language?.trim().slice(0, 2).toLowerCase();
  return code && /^[a-z]{2}$/.test(code) ? code : null;
}

/**
 * The provider-specific voice id from configuration, or null. Passed through
 * UNTOUCHED: the gateway maps it per backend (Fish Audio `reference_id`, ElevenLabs
 * voice id in the URL path, EdgeTTS `fr-FR-…Neural`, OpenAI `onyx`, gTTS language),
 * so one opaque string covers every backend and ICOS needs no per-vendor branch.
 * Bounded and charset-checked because it reaches an upstream URL path on some
 * backends; a value that is not a plausible voice id is dropped, not sent.
 */
export function ttsVoiceId(raw: string | undefined): string | null {
  const value = raw?.trim();
  return value && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
}

/** The gateway, when both its URL and key are configured. */
export function omniRouteGatewayFromEnv(
  env: Record<string, string | undefined> = process.env,
): OmniRouteVoiceConfig | null {
  const baseUrl = env.OMNIROUTE_BASE_URL;
  const apiKey = env.OMNIROUTE_API_KEY;
  return baseUrl && apiKey ? { baseUrl, apiKey } : null;
}

export function omniRouteVoiceFromEnv(env: Record<string, string | undefined> = process.env): {
  stt: SttProvider | null;
  tts: TtsProvider | null;
  status: {
    stt: VoiceProviderStatus;
    tts: VoiceProviderStatus;
    language: string;
    /** The configured voice, or "language" when the language-code fallback is in use. */
    voice: string;
  };
} {
  const gateway = omniRouteGatewayFromEnv(env);
  const language = ttsVoice(env.ICOS_VOICE_LANGUAGE) ?? DEFAULT_VOICE_LANGUAGE;
  const stt =
    gateway && env.ICOS_VOICE_STT_MODEL
      ? new OmniRouteStt(gateway, env.ICOS_VOICE_STT_MODEL, 1.5, language)
      : null;
  const voiceId = ttsVoiceId(env.ICOS_VOICE_TTS_VOICE);
  const tts =
    gateway && env.ICOS_VOICE_TTS_MODEL
      ? new OmniRouteTts(gateway, env.ICOS_VOICE_TTS_MODEL, language, voiceId)
      : null;
  return {
    stt,
    tts,
    status: {
      stt: stt ? "CONFIGURED" : "NOT_CONFIGURED",
      tts: tts ? "CONFIGURED" : "NOT_CONFIGURED",
      language,
      voice: voiceId ?? "language",
    },
  };
}

class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Beyond this, the utterance only gets its final transcript (partial cost is quadratic). */
const MAX_PARTIAL_SECONDS = 15;

async function post(
  config: OmniRouteVoiceConfig,
  path: string,
  body: BodyInit,
  signal: AbortSignal,
  json = false,
): Promise<Response> {
  const response = await (config.fetch ?? fetch)(
    `${config.baseUrl.replace(/\/+$/, "")}/v1${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(json ? { "Content-Type": "application/json" } : {}),
      },
      body,
      cache: "no-store",
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs ?? 20_000)]),
    },
  );
  // Status only: gateway error bodies can echo request details.
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new ProviderHttpError(`${path} HTTP ${response.status}`, response.status);
  }
  return response;
}

const isTimeout = (error: unknown) => error instanceof Error && error.name === "TimeoutError";
const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

/** 44-byte RIFF header for mono 16-bit PCM. */
export function wav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) =>
    [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

export class OmniRouteStt implements SttProvider {
  readonly id: string;
  readonly simulated = false;

  constructor(
    private readonly config: OmniRouteVoiceConfig,
    private readonly model: string,
    /** Seconds of new audio between two interim transcriptions; 0 disables partials. */
    private readonly partialEverySeconds = 1.5,
    /** Used when the session states no language, so Whisper never has to guess. */
    private readonly defaultLanguage = DEFAULT_VOICE_LANGUAGE,
  ) {
    this.id = `omniroute:${model}`;
  }

  open(
    options: { encoding: "pcm16" | "opus"; sampleRate: number; language?: string },
    onEvent: (event: SttEvent) => void,
  ) {
    if (options.encoding !== "pcm16") throw new Error(`unsupported encoding ${options.encoding}`);
    const language = ttsVoice(options.language) ?? this.defaultLanguage;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let partialAt = 0;
    let finished = false;
    const closed = new AbortController();
    let interim: AbortController | null = null;

    const transcribe = async (signal: AbortSignal): Promise<string> => {
      const form = new FormData();
      const audio = wav(Buffer.concat(chunks, bytes), options.sampleRate);
      form.append(
        "file",
        new Blob([audio as Uint8Array<ArrayBuffer>], { type: "audio/wav" }),
        "speech.wav",
      );
      form.append("model", this.model);
      if (language) form.append("language", language);
      const response = await post(this.config, "/audio/transcriptions", form, signal);
      const payload = (await response.json()) as { text?: unknown };
      return typeof payload.text === "string" ? payload.text.trim() : "";
    };

    const partialBytes = this.partialEverySeconds * options.sampleRate * 2;
    // Each partial re-sends the whole utterance: stop partials past this length.
    const partialLimitBytes = MAX_PARTIAL_SECONDS * options.sampleRate * 2;
    return {
      write: (frame: Uint8Array) => {
        if (finished || closed.signal.aborted) return;
        chunks.push(frame);
        bytes += frame.length;
        if (
          !partialBytes ||
          interim ||
          bytes > partialLimitBytes ||
          bytes - partialAt < partialBytes
        ) {
          return;
        }
        partialAt = bytes;
        const controller = (interim = new AbortController());
        transcribe(AbortSignal.any([controller.signal, closed.signal]))
          .then((text) => {
            if (text && !finished && !closed.signal.aborted)
              onEvent({ type: "partial", text, language });
          })
          .catch(() => {}) // an interim miss is not an outage; the final decides
          .finally(() => {
            if (interim === controller) interim = null;
          });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        interim?.abort();
        transcribe(closed.signal).then(
          (text) => onEvent({ type: "final", text, language }),
          (error: unknown) => {
            if (isAbort(error)) return; // cancelled by us
            onEvent({ type: "error", message: String(error), timeout: isTimeout(error) });
          },
        );
      },
      cancel: () => closed.abort(),
    };
  }
}

/** Markdown and links read aloud badly. Kept for callers; the rules live in speech-text. */
export const speakable = renderSpeech;

/**
 * OmniRoute's `/v1/audio/speech` as one synthesizer below the TTS router (decision 0074):
 * the `gtts` last resort and the free `edge` voice both go through the gateway ICOS already
 * uses. The gateway serves exactly one provider per request — routing stays in the router.
 */
export class OmniRouteSpeech implements SpeechSynthesizer {
  readonly streaming = false;

  constructor(
    private readonly config: OmniRouteVoiceConfig,
    readonly model: string,
    readonly name: "gtts" | "edge" = "gtts",
    /**
     * Gateway `voice` field. Null = the session language, which MUST be sent: the gateway
     * ignores the model id for gTTS ("gtts/fr" and "gtts/en" return byte-identical audio)
     * and otherwise GUESSES the language from the text — one English token in a French
     * reply ("(NOT_CONNECTED)") flipped the whole answer to an English voice reading
     * French. Observed on a real phone; see omniroute-voice.test.ts.
     *
     * A configured voice id (ICOS_VOICE_TTS_VOICE, see `ttsVoiceId`) is a VOICE and
     * wins, untouched: narrowed to a language code, every premium backend behind the
     * gateway was unreachable by construction, not by configuration.
     */
    readonly voice: string | null = null,
  ) {}

  async synthesize(request: SynthesisRequest): Promise<SynthesisResponse> {
    let response: Response;
    try {
      response = await post(
        this.config,
        "/audio/speech",
        JSON.stringify({
          model: this.model,
          input: request.text,
          response_format: "mp3",
          voice: this.voice ?? request.language,
        }),
        request.signal,
        true,
      );
    } catch (error) {
      if (error instanceof ProviderHttpError && error.status) {
        throw new TtsProviderError(this.name, classifyStatus(error.status), error.status);
      }
      throw classifyError(this.name, error);
    }
    return { mime: audioMime(this.name, response, "audio/mpeg"), body: bytesOf(response) };
  }
}

/**
 * Sentence-chunked streaming through the gateway alone: each sentence is synthesized as
 * it completes, in order — the pre-router behaviour, now a one-provider TtsRouter.
 */
export class OmniRouteTts implements TtsProvider {
  readonly id: string;
  readonly simulated = false;
  private readonly router: TtsRouter;

  constructor(
    config: OmniRouteVoiceConfig,
    model: string,
    /** Used when the session states no language. */
    defaultLanguage = DEFAULT_VOICE_LANGUAGE,
    /** Provider-specific voice id; when set it wins over any language code. */
    voiceId: string | null = null,
  ) {
    this.id = `omniroute:${model}${voiceId ? `:${voiceId}` : ""}`;
    this.router = new TtsRouter({
      providers: [new OmniRouteSpeech(config, model, "gtts", voiceId)],
      chunking: SENTENCE_CHUNKING,
      retries: 0,
      defaultLanguage,
      timeoutMs: config.requestTimeoutMs ?? 20_000,
      firstAudioTimeoutMs: config.requestTimeoutMs ?? 20_000,
    });
  }

  start(options: { language?: string; turnId?: string }, onEvent: (event: TtsEvent) => void) {
    return this.router.start(options, onEvent);
  }
}
