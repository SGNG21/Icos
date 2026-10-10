import { describe, expect, it } from "vitest";

import type { TtsEvent } from "@/core/voice/contracts";

import { describeTtsStatus, ttsOrder, ttsRouterFromEnv } from "./config";
import { flush, scriptedFetch } from "./tts-test-kit";

const gateway = (fetch?: typeof globalThis.fetch) => ({
  baseUrl: "http://gw",
  apiKey: "GATEWAY-SECRET",
  ...(fetch ? { fetch } : {}),
});

const premium = {
  FISH_AUDIO_API_KEY: "FISH-SECRET",
  ICOS_FISH_TTS_VOICE: "ref-123",
  ELEVENLABS_API_KEY: "ELEVEN-SECRET",
  ICOS_ELEVENLABS_TTS_VOICE: "VoiceId1234567890",
};

describe("TTS configuration", () => {
  it("default order is fish, elevenlabs, edge, gtts; the primary moves to the head", () => {
    expect(ttsOrder({}).order).toEqual(["fish", "elevenlabs", "edge", "gtts"]);
    expect(ttsOrder({ ICOS_VOICE_TTS_PROVIDER: "elevenlabs" }).order).toEqual([
      "elevenlabs",
      "fish",
      "edge",
      "gtts",
    ]);
    expect(
      ttsOrder({ ICOS_TTS_PROVIDER_ORDER: "gtts, Fish ,gtts", ICOS_TTS_PRIMARY: "fish" }).order,
    ).toEqual(["fish", "gtts"]);
    expect(ttsOrder({ ICOS_TTS_PROVIDER_ORDER: "omniroute" }).order).toEqual(["gtts"]);
  });

  it("the provider list is an allowlist: anything else is refused and reported", () => {
    const { order, errors } = ttsOrder({
      ICOS_TTS_PROVIDER_ORDER: "fish,https://evil.example,gtts",
    });
    expect(order).toEqual(["fish", "gtts"]);
    expect(errors).toEqual([expect.stringContaining("unknown TTS provider")]);
  });

  it("COMPATIBILITY: without premium keys, the router is the OmniRoute path voice already had", async () => {
    const f = scriptedFetch();
    const { tts, status } = ttsRouterFromEnv(
      { ICOS_VOICE_TTS_MODEL: "gtts/fr" },
      { gateway: gateway(f.fetch), defaultLanguage: "fr" },
    );
    expect(tts?.id).toBe("router:gtts");
    expect(status.providers).toEqual([
      { provider: "fish", configured: false, reason: "FISH_AUDIO_API_KEY unset" },
      { provider: "elevenlabs", configured: false, reason: "ELEVENLABS_API_KEY unset" },
      { provider: "edge", configured: false, reason: "ICOS_EDGE_TTS_MODEL unset" },
      { provider: "gtts", configured: true },
    ]);
    const events: TtsEvent[] = [];
    const stream = tts!.start({ language: "fr-FR" }, (e) => events.push(e));
    stream.text("Bonjour Geoffrey, comment allez-vous ?");
    stream.finish();
    expect(f.calls[0].url).toBe("http://gw/v1/audio/speech");
    expect(f.calls[0].json).toEqual({
      model: "gtts/fr",
      input: "Bonjour Geoffrey, comment allez-vous ?",
      response_format: "mp3",
      voice: "fr",
    });
    const body = f.calls[0].stream();
    body.push("mp3");
    body.end();
    await flush();
    expect(events.map((e) => e.type)).toEqual(["audio", "done"]);
  });

  it("nothing configured at all → no router (text-only answers, as before)", () => {
    expect(ttsRouterFromEnv({}, { gateway: null, defaultLanguage: "fr" }).tts).toBeNull();
  });

  it("premium providers need a key AND a voice: a key alone configures nothing", () => {
    const { status } = ttsRouterFromEnv(
      { FISH_AUDIO_API_KEY: "k", ELEVENLABS_API_KEY: "k" },
      { gateway: null, defaultLanguage: "fr" },
    );
    expect(status.providers.slice(0, 2)).toEqual([
      { provider: "fish", configured: false, reason: "ICOS_FISH_TTS_VOICE unset" },
      { provider: "elevenlabs", configured: false, reason: "ICOS_ELEVENLABS_TTS_VOICE unset" },
    ]);
  });

  it("invalid values are refused, not passed to a vendor", () => {
    const { status } = ttsRouterFromEnv(
      {
        ...premium,
        ICOS_FISH_TTS_FORMAT: "pcm",
        ICOS_ELEVENLABS_TTS_VOICE: "../v1/user",
      },
      { gateway: null, defaultLanguage: "fr" },
    );
    expect(status.providers.slice(0, 2).map((p) => p.reason)).toEqual([
      "ICOS_FISH_TTS_FORMAT must be mp3 or wav",
      "ICOS_ELEVENLABS_TTS_VOICE is not a voice id",
    ]);
  });

  it("full chain: Fish → ElevenLabs → Edge (gateway) → gTTS (gateway)", () => {
    const { tts, status } = ttsRouterFromEnv(
      {
        ...premium,
        ICOS_EDGE_TTS_MODEL: "edgetts/fr-FR-HenriNeural",
        ICOS_VOICE_TTS_MODEL: "gtts/fr",
      },
      { gateway: gateway(), defaultLanguage: "fr" },
    );
    expect(tts?.id).toBe("router:fish>elevenlabs>edge>gtts");
    expect(describeTtsStatus(status)).toBe("fish:on>elevenlabs:on>edge:on>gtts:on");
    expect(tts?.health().map((h) => [h.provider, h.model])).toEqual([
      ["fish", "s1"],
      ["elevenlabs", "eleven_multilingual_v2"],
      ["edge", "edgetts/fr-FR-HenriNeural"],
      ["gtts", "gtts/fr"],
    ]);
  });

  it("fishaudio/<model> + ICOS_VOICE_TTS_VOICE: the voice id reaches Fish directly, once", async () => {
    const f = scriptedFetch();
    const env = {
      FISH_AUDIO_API_KEY: "FISH-SECRET",
      ICOS_VOICE_TTS_MODEL: "fishaudio/s1",
      ICOS_VOICE_TTS_VOICE: "3bce5f0710f949888abe982ded1ef731",
    };
    const { tts, status } = ttsRouterFromEnv(env, {
      gateway: gateway(f.fetch),
      defaultLanguage: "fr",
      fetch: f.fetch,
    });
    expect(tts?.id).toBe("router:fish");
    expect(status.providers.at(-1)).toEqual({
      provider: "gtts",
      configured: false,
      reason: "ICOS_VOICE_TTS_MODEL served directly by fish",
    });
    expect(tts?.health()[0]).toMatchObject({
      provider: "fish",
      model: "s1",
      voice: "3bce5f0710f949888abe982ded1ef731",
    });

    const events: TtsEvent[] = [];
    const stream = tts!.start({ language: "fr-FR" }, (e) => events.push(e));
    stream.text("Bonjour Geoffrey, comment allez-vous ?");
    stream.finish();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("https://api.fish.audio/v1/tts");
    expect(f.calls[0].headers.get("model")).toBe("s1");
    expect(f.calls[0].json).toMatchObject({ reference_id: "3bce5f0710f949888abe982ded1ef731" });
    const body = f.calls[0].stream();
    body.push("mp3");
    body.end();
    await flush();
    expect(events.map((e) => e.type)).toEqual(["audio", "done"]);
    expect(JSON.stringify(status) + JSON.stringify(tts?.health())).not.toContain("FISH-SECRET");

    // Without the key, the same variables stay the OmniRoute path they always were.
    const { tts: gatewayOnly } = ttsRouterFromEnv(
      { ...env, FISH_AUDIO_API_KEY: undefined },
      { gateway: gateway(), defaultLanguage: "fr" },
    );
    expect(gatewayOnly?.id).toBe("router:gtts");
    // Explicit ICOS_FISH_TTS_* win over the shorthand.
    const { tts: explicit } = ttsRouterFromEnv(
      { ...env, ICOS_FISH_TTS_VOICE: "ref-123", ICOS_FISH_TTS_MODEL: "speech-1.6" },
      { gateway: null, defaultLanguage: "fr" },
    );
    expect(explicit?.health()[0]).toMatchObject({ model: "speech-1.6", voice: "ref-123" });
  });

  it("status and health never contain a secret", () => {
    const { tts, status } = ttsRouterFromEnv(
      { ...premium, ICOS_VOICE_TTS_MODEL: "gtts/fr" },
      { gateway: gateway(), defaultLanguage: "fr" },
    );
    const dump = JSON.stringify(status) + describeTtsStatus(status) + JSON.stringify(tts?.health());
    for (const secret of ["FISH-SECRET", "ELEVEN-SECRET", "GATEWAY-SECRET"]) {
      expect(dump).not.toContain(secret);
    }
  });
});
