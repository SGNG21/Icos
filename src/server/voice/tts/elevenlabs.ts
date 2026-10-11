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
 * ElevenLabs (premium fallback, decision 0074). Server-side only. Uses the streaming
 * endpoint so the first audio bytes arrive while the rest is generated. Voice settings
 * are ElevenLabs vocabulary and stay inside this adapter.
 */

/** Fixed: no configuration or client can point the key at another host. */
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io";

/** A voice id goes into the URL path: only plain ids, never a path or a query. */
export const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{8,64}$/;
/** MP3 only: each chunk must be decodable by the browser on its own. */
export const ELEVENLABS_FORMAT = /^mp3_\d{5}_\d{2,3}$/;

export type ElevenLabsVoiceSettings = {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
};

export type ElevenLabsConfig = {
  apiKey: string;
  /** e.g. "eleven_multilingual_v2". */
  model: string;
  voice: string;
  /** e.g. "mp3_44100_128". */
  format: string;
  voiceSettings?: ElevenLabsVoiceSettings;
  /** Send the session language as `language_code` (only some models accept it). */
  sendLanguage?: boolean;
  fetch?: typeof fetch;
};

export class ElevenLabsSynthesizer implements SpeechSynthesizer {
  readonly name = "elevenlabs" as const;
  readonly streaming = true;
  readonly model: string;
  readonly voice: string;

  constructor(private readonly config: ElevenLabsConfig) {
    if (!ELEVENLABS_VOICE_ID.test(config.voice)) throw new Error("invalid ElevenLabs voice id");
    if (!ELEVENLABS_FORMAT.test(config.format)) throw new Error("unsupported ElevenLabs format");
    this.model = config.model;
    this.voice = config.voice;
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResponse> {
    const { config } = this;
    const settings = config.voiceSettings;
    let response: Response;
    try {
      response = await (config.fetch ?? fetch)(
        `${ELEVENLABS_BASE_URL}/v1/text-to-speech/${config.voice}/stream?output_format=${config.format}`,
        {
          method: "POST",
          headers: {
            "xi-api-key": config.apiKey,
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          },
          body: JSON.stringify({
            text: request.text,
            model_id: config.model,
            ...(config.sendLanguage ? { language_code: request.language } : {}),
            ...(settings && Object.keys(settings).length ? { voice_settings: settings } : {}),
          }),
          cache: "no-store",
          signal: request.signal,
        },
      );
    } catch (error) {
      throw classifyError(this.name, error);
    }
    if (!response.ok) throw httpError(this.name, response);
    return { mime: audioMime(this.name, response, "audio/mpeg"), body: bytesOf(response) };
  }

  /** GET the configured voice: proves key AND voice id without billing characters. */
  async probe(signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await (this.config.fetch ?? fetch)(
        `${ELEVENLABS_BASE_URL}/v1/voices/${this.voice}`,
        { headers: { "xi-api-key": this.config.apiKey }, cache: "no-store", signal },
      );
    } catch (error) {
      throw classifyError(this.name, error);
    }
    if (!response.ok) throw httpError(this.name, response);
    void response.body?.cancel().catch(() => {});
  }
}
