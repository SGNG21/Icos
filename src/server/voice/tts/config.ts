import { OmniRouteSpeech, ttsVoiceId, type OmniRouteVoiceConfig } from "../omniroute-voice";

import { DEFAULT_CIRCUIT } from "./circuit-breaker";
import { ElevenLabsSynthesizer, ELEVENLABS_FORMAT, ELEVENLABS_VOICE_ID } from "./elevenlabs";
import { FISH_FORMATS, FishAudioSynthesizer, type FishFormat } from "./fish-audio";
import { DEFAULT_CHUNKING } from "./speech-text";
import { TTS_PROVIDER_NAMES, type SpeechSynthesizer, type TtsProviderName } from "./synthesizer";
import type { TtsObserver } from "./telemetry";
import { TtsRouter } from "./tts-router";

/**
 * TTS router from configuration (decision 0074). Every provider is opt-in: without
 * Fish/ElevenLabs keys the router is exactly the OmniRoute path ICOS already had.
 * Secrets are read here and handed to adapters; they are never part of a status.
 *
 *   ICOS_TTS_PROVIDER_ORDER   fish,elevenlabs,edge,gtts (default)
 *   ICOS_VOICE_TTS_PROVIDER   primary — moved to the head of the order
 *   ICOS_TTS_FALLBACK_ENABLED true (default) | false: primary only
 */

export const DEFAULT_TTS_ORDER: readonly TtsProviderName[] = ["fish", "elevenlabs", "edge", "gtts"];

export type TtsProviderStatus = {
  provider: TtsProviderName;
  configured: boolean;
  /** Why not configured. Names variables, never their values. */
  reason?: string;
};

export type TtsConfigStatus = {
  order: TtsProviderName[];
  providers: TtsProviderStatus[];
  /** Configuration refused (unknown provider, invalid value). */
  errors: string[];
};

type Env = Record<string, string | undefined>;

const int = (value: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(value);
  return value?.trim() && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};
const num = (value: string | undefined, min: number, max: number) => {
  const n = Number(value);
  return value?.trim() && Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const bool = (value: string | undefined) => {
  const v = value?.trim().toLowerCase();
  return v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined;
};

/** Order from configuration: allowlisted names only, primary first, no duplicates. */
export function ttsOrder(env: Env): { order: TtsProviderName[]; errors: string[] } {
  const errors: string[] = [];
  const known = (name: string): TtsProviderName | null => {
    const n = name.trim().toLowerCase();
    if (!n) return null;
    const resolved = n === "omniroute" ? "gtts" : n;
    if ((TTS_PROVIDER_NAMES as readonly string[]).includes(resolved)) {
      return resolved as TtsProviderName;
    }
    errors.push(`unknown TTS provider "${name.trim().slice(0, 32)}" ignored`);
    return null;
  };
  const listed = env.ICOS_TTS_PROVIDER_ORDER?.trim()
    ? env.ICOS_TTS_PROVIDER_ORDER.split(",").map(known)
    : [...DEFAULT_TTS_ORDER];
  const primaryRaw = env.ICOS_VOICE_TTS_PROVIDER ?? env.ICOS_TTS_PRIMARY;
  const primary = primaryRaw?.trim() ? known(primaryRaw) : null;
  const order = [...new Set([primary, ...listed].filter((p): p is TtsProviderName => !!p))];
  return { order, errors };
}

export function ttsRouterFromEnv(
  env: Env = process.env,
  deps: {
    gateway: OmniRouteVoiceConfig | null;
    defaultLanguage: string;
    observer?: TtsObserver;
    fetch?: typeof fetch;
  },
): { tts: TtsRouter | null; status: TtsConfigStatus } {
  const { order, errors } = ttsOrder(env);
  const providers: TtsProviderStatus[] = [];
  const synths: SpeechSynthesizer[] = [];

  const build = (name: TtsProviderName): SpeechSynthesizer | string => {
    switch (name) {
      case "fish": {
        if (!env.FISH_AUDIO_API_KEY) return "FISH_AUDIO_API_KEY unset";
        if (!env.ICOS_FISH_TTS_VOICE?.trim()) return "ICOS_FISH_TTS_VOICE unset";
        const format = (env.ICOS_FISH_TTS_FORMAT?.trim() || "mp3") as FishFormat;
        if (!(format in FISH_FORMATS)) return "ICOS_FISH_TTS_FORMAT must be mp3 or wav";
        const latency = env.ICOS_FISH_TTS_LATENCY?.trim() === "normal" ? "normal" : "balanced";
        const speed = num(env.ICOS_FISH_TTS_SPEED, 0.5, 2);
        return new FishAudioSynthesizer({
          apiKey: env.FISH_AUDIO_API_KEY,
          model: env.ICOS_FISH_TTS_MODEL?.trim() || "s1",
          voice: env.ICOS_FISH_TTS_VOICE.trim(),
          format,
          latency,
          ...(speed ? { speed } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
      }
      case "elevenlabs": {
        if (!env.ELEVENLABS_API_KEY) return "ELEVENLABS_API_KEY unset";
        const voice = env.ICOS_ELEVENLABS_TTS_VOICE?.trim();
        if (!voice) return "ICOS_ELEVENLABS_TTS_VOICE unset";
        if (!ELEVENLABS_VOICE_ID.test(voice)) return "ICOS_ELEVENLABS_TTS_VOICE is not a voice id";
        const format = env.ICOS_ELEVENLABS_TTS_FORMAT?.trim() || "mp3_44100_128";
        if (!ELEVENLABS_FORMAT.test(format)) return "ICOS_ELEVENLABS_TTS_FORMAT must be mp3_*";
        const settings = {
          stability: num(env.ICOS_ELEVENLABS_TTS_STABILITY, 0, 1),
          similarity_boost: num(env.ICOS_ELEVENLABS_TTS_SIMILARITY, 0, 1),
          style: num(env.ICOS_ELEVENLABS_TTS_STYLE, 0, 1),
          speed: num(env.ICOS_ELEVENLABS_TTS_SPEED, 0.7, 1.2),
          use_speaker_boost: bool(env.ICOS_ELEVENLABS_TTS_SPEAKER_BOOST),
        };
        const voiceSettings = Object.fromEntries(
          Object.entries(settings).filter(([, v]) => v !== undefined),
        );
        return new ElevenLabsSynthesizer({
          apiKey: env.ELEVENLABS_API_KEY,
          model: env.ICOS_ELEVENLABS_TTS_MODEL?.trim() || "eleven_multilingual_v2",
          voice,
          format,
          voiceSettings,
          sendLanguage: bool(env.ICOS_ELEVENLABS_TTS_LANGUAGE_CODE) ?? false,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
      }
      case "edge": {
        if (!deps.gateway) return "OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY unset";
        if (!env.ICOS_EDGE_TTS_MODEL?.trim()) return "ICOS_EDGE_TTS_MODEL unset";
        return new OmniRouteSpeech(
          deps.gateway,
          env.ICOS_EDGE_TTS_MODEL.trim(),
          "edge",
          env.ICOS_EDGE_TTS_VOICE?.trim() || null,
        );
      }
      case "gtts": {
        if (!deps.gateway) return "OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY unset";
        if (!env.ICOS_VOICE_TTS_MODEL?.trim()) return "ICOS_VOICE_TTS_MODEL unset";
        return new OmniRouteSpeech(
          deps.gateway,
          env.ICOS_VOICE_TTS_MODEL.trim(),
          "gtts",
          // Verbatim, but bounded and charset-checked: it can reach an upstream URL path.
          ttsVoiceId(env.ICOS_VOICE_TTS_VOICE),
        );
      }
    }
  };

  for (const name of order) {
    const built = build(name);
    if (typeof built === "string") {
      providers.push({ provider: name, configured: false, reason: built });
    } else {
      providers.push({ provider: name, configured: true });
      synths.push(built);
    }
  }
  const status = { order, providers, errors };
  if (!synths.length) return { tts: null, status };

  const chunkMin = int(env.ICOS_TTS_CHUNK_MIN_CHARS, DEFAULT_CHUNKING.minChars, 0, 400);
  const tts = new TtsRouter({
    providers: synths,
    unconfigured: providers
      .filter((p) => !p.configured)
      .map((p) => ({ provider: p.provider, reason: p.reason ?? "not configured" })),
    fallbackEnabled: bool(env.ICOS_TTS_FALLBACK_ENABLED) ?? true,
    retries: int(env.ICOS_TTS_RETRIES, 1, 0, 3),
    timeoutMs: int(env.ICOS_TTS_TIMEOUT_MS, 15_000, 1_000, 120_000),
    firstAudioTimeoutMs: int(env.ICOS_TTS_FIRST_AUDIO_TIMEOUT_MS, 5_000, 500, 60_000),
    chunking: {
      minChars: chunkMin,
      firstMinChars: int(
        env.ICOS_TTS_CHUNK_FIRST_MIN_CHARS,
        DEFAULT_CHUNKING.firstMinChars,
        0,
        400,
      ),
      maxChars: Math.max(
        chunkMin,
        int(env.ICOS_TTS_CHUNK_MAX_CHARS, DEFAULT_CHUNKING.maxChars, 40, 1_000),
      ),
    },
    circuit: {
      ...DEFAULT_CIRCUIT,
      failureThreshold: int(env.ICOS_TTS_CIRCUIT_FAILURES, DEFAULT_CIRCUIT.failureThreshold, 1, 20),
      cooldownMs: int(
        env.ICOS_TTS_CIRCUIT_COOLDOWN_MS,
        DEFAULT_CIRCUIT.cooldownMs,
        1_000,
        3_600_000,
      ),
    },
    defaultLanguage: deps.defaultLanguage,
    ...(deps.observer ? { observer: deps.observer } : {}),
  });
  return { tts, status };
}

/** One status line for the voice host: names and states only, never values. */
export function describeTtsStatus(status: TtsConfigStatus): string {
  const chain = status.providers
    .map((p) => `${p.provider}:${p.configured ? "on" : "off"}`)
    .join(">");
  return chain || "none";
}
