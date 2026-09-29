import type { SttEvent, SttProvider, TtsEvent, TtsProvider } from "@/core/voice/contracts";

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

export function omniRouteVoiceFromEnv(env: Record<string, string | undefined> = process.env): {
  stt: SttProvider | null;
  tts: TtsProvider | null;
  status: { stt: VoiceProviderStatus; tts: VoiceProviderStatus };
} {
  const baseUrl = env.OMNIROUTE_BASE_URL;
  const apiKey = env.OMNIROUTE_API_KEY;
  const gateway = baseUrl && apiKey ? { baseUrl, apiKey } : null;
  const stt =
    gateway && env.ICOS_VOICE_STT_MODEL
      ? new OmniRouteStt(gateway, env.ICOS_VOICE_STT_MODEL)
      : null;
  const tts =
    gateway && env.ICOS_VOICE_TTS_MODEL
      ? new OmniRouteTts(gateway, env.ICOS_VOICE_TTS_MODEL)
      : null;
  return {
    stt,
    tts,
    status: {
      stt: stt ? "CONFIGURED" : "NOT_CONFIGURED",
      tts: tts ? "CONFIGURED" : "NOT_CONFIGURED",
    },
  };
}

class ProviderHttpError extends Error {}

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
  if (!response.ok) throw new ProviderHttpError(`${path} HTTP ${response.status}`);
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
  ) {
    this.id = `omniroute:${model}`;
  }

  open(
    options: { encoding: "pcm16" | "opus"; sampleRate: number; language?: string },
    onEvent: (event: SttEvent) => void,
  ) {
    if (options.encoding !== "pcm16") throw new Error(`unsupported encoding ${options.encoding}`);
    const language = options.language?.slice(0, 2).toLowerCase();
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
    return {
      write: (frame: Uint8Array) => {
        if (finished || closed.signal.aborted) return;
        chunks.push(frame);
        bytes += frame.length;
        if (!partialBytes || interim || bytes - partialAt < partialBytes) return;
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

/** Markdown and links read aloud badly. */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>`|~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Complete sentences at the head of `buffer`, and the rest. */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  // A terminator ends a sentence only before whitespace: "3.14" and URLs stay whole.
  const pattern = /[\s\S]*?(?:[.!?…]+(?=\s)|\n)/y;
  let rest = buffer;
  for (let match = pattern.exec(rest); match; match = pattern.exec(rest)) {
    if (match[0].trim()) sentences.push(match[0].trim());
    rest = rest.slice(match[0].length);
    pattern.lastIndex = 0;
  }
  return { sentences, rest };
}

/** Sentence-chunked streaming: each sentence is synthesized as it completes, in order. */
export class OmniRouteTts implements TtsProvider {
  readonly id: string;
  readonly simulated = false;

  constructor(
    private readonly config: OmniRouteVoiceConfig,
    private readonly model: string,
  ) {
    this.id = `omniroute:${model}`;
  }

  start(_options: { language?: string }, onEvent: (event: TtsEvent) => void) {
    const queue: string[] = [];
    const cancelled = new AbortController();
    let buffer = "";
    let running = false;
    let finished = false;
    let done = false;

    const synthesize = async (input: string) => {
      const response = await post(
        this.config,
        "/audio/speech",
        JSON.stringify({ model: this.model, input, response_format: "mp3" }),
        cancelled.signal,
        true,
      );
      const mime = response.headers.get("content-type") ?? "audio/mpeg";
      if (!mime.startsWith("audio/")) throw new ProviderHttpError(`/audio/speech returned ${mime}`);
      return { data: new Uint8Array(await response.arrayBuffer()), mime };
    };

    const pump = () => {
      if (running || cancelled.signal.aborted) return;
      const next = queue.shift();
      if (next === undefined) {
        if (finished && !done) {
          done = true;
          onEvent({ type: "done" });
        }
        return;
      }
      running = true;
      synthesize(next)
        .then((audio) => {
          if (!cancelled.signal.aborted) onEvent({ type: "audio", ...audio });
        })
        .catch((error: unknown) => {
          if (cancelled.signal.aborted) return;
          cancelled.abort(); // one failed sentence ends this stream; the text still reaches the user
          onEvent({ type: "error", message: String(error), timeout: isTimeout(error) });
        })
        .finally(() => {
          running = false;
          pump();
        });
    };

    const enqueue = (sentence: string) => {
      const clean = speakable(sentence);
      if (clean) queue.push(clean);
    };

    return {
      text: (chunk: string) => {
        if (finished || cancelled.signal.aborted) return;
        const { sentences, rest } = takeSentences(buffer + chunk);
        buffer = rest;
        sentences.forEach(enqueue);
        pump();
      },
      finish: () => {
        if (finished) return;
        finished = true;
        enqueue(buffer);
        buffer = "";
        pump();
      },
      cancel: () => {
        cancelled.abort();
        queue.length = 0;
      },
    };
  }
}
