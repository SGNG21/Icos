import {
  audioMime,
  bytesOf,
  classifyError,
  httpError,
  type SpeechSynthesizer,
  type SynthesisRequest,
  type SynthesisResponse,
} from "./synthesizer";

/**
 * Fish Audio (primary premium voice, decision 0074). Server-side only: the key never
 * leaves this process. POST /v1/tts streams audio bytes as they are generated; the
 * model goes in the `model` header and the voice is a `reference_id`. Same request
 * shape as the gateway's own fishaudio adapter (OmniRoute 3.8.49), plus the latency
 * and prosody knobs the gateway does not forward.
 */

/** Fixed: no configuration or client can point the key at another host. */
const FISH_BASE_URL = "https://api.fish.audio";

/** Formats a browser can decode chunk by chunk. */
export const FISH_FORMATS = { mp3: "audio/mpeg", wav: "audio/wav" } as const;
export type FishFormat = keyof typeof FISH_FORMATS;

export type FishAudioConfig = {
  apiKey: string;
  /** e.g. "s1". */
  model: string;
  /** reference_id of the ICOS voice: configuration, never source. */
  voice: string;
  format: FishFormat;
  /** "balanced" trades a little quality for a faster first byte. */
  latency: "normal" | "balanced";
  speed?: number;
  fetch?: typeof fetch;
};

export class FishAudioSynthesizer implements SpeechSynthesizer {
  readonly name = "fish" as const;
  readonly streaming = true;
  readonly model: string;
  readonly voice: string;

  constructor(private readonly config: FishAudioConfig) {
    this.model = config.model;
    this.voice = config.voice;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResponse> {
    const { config } = this;
    let response: Response;
    try {
      response = await (config.fetch ?? fetch)(`${FISH_BASE_URL}/v1/tts`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          model: config.model,
        },
        body: JSON.stringify({
          text: request.text,
          reference_id: config.voice,
          format: config.format,
          ...(config.format === "mp3" ? { mp3_bitrate: 128 } : {}),
          latency: config.latency,
          normalize: true,
          ...(config.speed ? { prosody: { speed: config.speed } } : {}),
        }),
        cache: "no-store",
        signal: request.signal,
      });
    } catch (error) {
      throw classifyError(this.name, error);
    }
    if (!response.ok) throw httpError(this.name, response);
    return {
      mime: audioMime(this.name, response, FISH_FORMATS[config.format]),
      body: bytesOf(response),
    };
  }

  /** GET the voice model: proves key AND reference id without synthesizing anything. */
  async probe(signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(
        `${FISH_BASE_URL}/model/${encodeURIComponent(this.voice)}`,
        {
          headers: { Authorization: `Bearer ${this.config.apiKey}` },
          cache: "no-store",
          signal,
        },
      );
    } catch (error) {
      throw classifyError(this.name, error);
    }
    if (!response.ok) throw httpError(this.name, response);
    void response.body?.cancel().catch(() => {});
  }
}
