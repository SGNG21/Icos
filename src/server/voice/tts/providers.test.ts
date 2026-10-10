import { describe, expect, it } from "vitest";

import { ElevenLabsSynthesizer } from "./elevenlabs";
import { FishAudioSynthesizer } from "./fish-audio";
import { SENTENCE_CHUNKING } from "./speech-text";
import { TtsProviderError, type SpeechSynthesizer } from "./synthesizer";
import { flush, readAll, scriptedFetch, sleep } from "./tts-test-kit";
import { TtsRouter } from "./tts-router";

/** SIMULATED HTTP: request shapes and error mapping, not a live vendor. */

const KEY = "sk-TEST-SECRET-0123456789";

const fish = (fetch: typeof globalThis.fetch) =>
  new FishAudioSynthesizer({
    apiKey: KEY,
    model: "s1",
    voice: "ref-icos-voice",
    format: "mp3",
    latency: "balanced",
    speed: 1.05,
    fetch,
  });

const eleven = (fetch: typeof globalThis.fetch, sendLanguage = false) =>
  new ElevenLabsSynthesizer({
    apiKey: KEY,
    model: "eleven_multilingual_v2",
    voice: "VoiceId1234567890",
    format: "mp3_44100_128",
    voiceSettings: { stability: 0.5, similarity_boost: 0.8 },
    sendLanguage,
    fetch,
  });

const request = (signal = new AbortController().signal) => ({
  text: "Bonjour.",
  language: "fr",
  signal,
});

async function failureOf(work: Promise<unknown>): Promise<TtsProviderError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(TtsProviderError);
    return error as TtsProviderError;
  }
  throw new Error("expected a failure");
}

const adapters: [string, (f: typeof globalThis.fetch) => SpeechSynthesizer][] = [
  ["fish", fish],
  ["elevenlabs", eleven],
];

describe("Fish Audio adapter", () => {
  it("posts to the fixed Fish endpoint with model header, reference id, format and prosody", async () => {
    const f = scriptedFetch();
    const pending = fish(f.fetch).synthesize(request());
    const call = f.calls[0];
    expect(call.url).toBe("https://api.fish.audio/v1/tts");
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(call.headers.get("model")).toBe("s1");
    expect(call.json).toEqual({
      text: "Bonjour.",
      reference_id: "ref-icos-voice",
      format: "mp3",
      mp3_bitrate: 128,
      latency: "balanced",
      normalize: true,
      prosody: { speed: 1.05 },
    });
    const body = call.stream("audio/mpeg");
    body.push("a");
    body.push("b");
    body.end();
    const response = await pending;
    expect(response.mime).toBe("audio/mpeg");
    expect(await readAll(response)).toBe("ab");
  });

  it("streams: the first bytes are readable before the provider has finished", async () => {
    const f = scriptedFetch();
    const pending = fish(f.fetch).synthesize(request());
    const body = f.calls[0].stream();
    const iterator = (await pending).body[Symbol.asyncIterator]();
    body.push("first");
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("first");
    body.push("second");
    body.end();
    expect(new TextDecoder().decode((await iterator.next()).value)).toBe("second");
  });

  it("probes the voice model with a GET — no synthesis, no billed characters", async () => {
    const f = scriptedFetch();
    const probe = fish(f.fetch).probe(new AbortController().signal);
    expect(f.calls[0]).toMatchObject({
      url: "https://api.fish.audio/model/ref-icos-voice",
      method: "GET",
    });
    f.calls[0].stream("application/json").end();
    await expect(probe).resolves.toBeUndefined();
  });
});

describe("ElevenLabs adapter", () => {
  it("posts to the streaming endpoint with voice id, model, format and voice settings", async () => {
    const f = scriptedFetch();
    const pending = eleven(f.fetch).synthesize(request());
    const call = f.calls[0];
    expect(call.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/VoiceId1234567890/stream?output_format=mp3_44100_128",
    );
    expect(call.headers.get("xi-api-key")).toBe(KEY);
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.json).toEqual({
      text: "Bonjour.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    });
    const body = call.stream();
    body.push("mp3");
    body.end();
    expect(await readAll(await pending)).toBe("mp3");
  });

  it("sends language_code only when configured to", () => {
    const f = scriptedFetch();
    void eleven(f.fetch, true)
      .synthesize(request())
      .catch(() => {});
    expect(f.calls[0].json).toMatchObject({ language_code: "fr" });
  });

  it("refuses a voice id that could change the URL path, and a non-MP3 format", () => {
    const base = { apiKey: KEY, model: "m", format: "mp3_44100_128" };
    expect(() => new ElevenLabsSynthesizer({ ...base, voice: "../../v1/user" })).toThrow(
      /voice id/,
    );
    expect(() => new ElevenLabsSynthesizer({ ...base, voice: "abc?x=1" })).toThrow(/voice id/);
    expect(
      () => new ElevenLabsSynthesizer({ ...base, voice: "VoiceId1234567890", format: "pcm_16000" }),
    ).toThrow(/format/);
  });

  it("probes the configured voice with a GET", async () => {
    const f = scriptedFetch();
    const probe = eleven(f.fetch).probe(new AbortController().signal);
    expect(f.calls[0]).toMatchObject({
      url: "https://api.elevenlabs.io/v1/voices/VoiceId1234567890",
      method: "GET",
    });
    f.calls[0].status(401);
    expect((await failureOf(probe)).failure).toBe("AUTH_FAILED");
  });
});

describe.each(adapters)("%s adapter — error mapping", (name, make) => {
  it.each([
    [401, "AUTH_FAILED"],
    [403, "AUTH_FAILED"],
    [402, "AUTH_FAILED"],
    [404, "CONFIG_INVALID"],
    [429, "RATE_LIMITED"],
    [400, "INVALID_REQUEST"],
    [422, "INVALID_REQUEST"],
    [504, "TIMEOUT"],
    [500, "UPSTREAM"],
    [503, "UPSTREAM"],
  ] as const)(
    "HTTP %i → %s, and the body (which may echo secrets) is never read",
    async (status, failure) => {
      const f = scriptedFetch();
      const pending = make(f.fetch).synthesize(request());
      f.calls[0].status(status, status === 429 ? { "retry-after": "7" } : {});
      const error = await failureOf(pending);
      expect(error.provider).toBe(name);
      expect(error.failure).toBe(failure);
      expect(error.status).toBe(status);
      if (status === 429) expect(error.retryAfterS).toBe(7);
      expect(error.message).not.toContain("SECRET-IN-BODY");
      expect(error.message).not.toContain(KEY);
    },
  );

  it("a 200 that is not audio is an upstream failure", async () => {
    const f = scriptedFetch();
    const pending = make(f.fetch).synthesize(request());
    f.calls[0].stream("application/json").end();
    expect((await failureOf(pending)).failure).toBe("UPSTREAM");
  });

  it("a network failure is UNAVAILABLE; a timeout is TIMEOUT; an abort is ABORTED", async () => {
    for (const [thrown, failure] of [
      [new TypeError("fetch failed"), "UNAVAILABLE"],
      [new DOMException("t", "TimeoutError"), "TIMEOUT"],
      [new DOMException("a", "AbortError"), "ABORTED"],
    ] as const) {
      const f = scriptedFetch();
      const pending = make(f.fetch).synthesize(request());
      f.calls[0].reject(thrown);
      expect((await failureOf(pending)).failure).toBe(failure);
    }
  });

  it("abort cancels the request in flight", async () => {
    const f = scriptedFetch();
    const controller = new AbortController();
    const pending = make(f.fetch).synthesize(request(controller.signal));
    controller.abort("BARGE_IN");
    expect(f.calls[0].signal.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
  });
});

describe("adapters under the router", () => {
  const route = (fetch: typeof globalThis.fetch, options = {}) => {
    const events: { type: string; provider?: string; timeout?: boolean }[] = [];
    const router = new TtsRouter({
      providers: [fish(fetch), eleven(fetch)],
      chunking: SENTENCE_CHUNKING,
      retries: 0,
      ...options,
    });
    const stream = router.start({ language: "fr" }, (e) => events.push(e));
    stream.text("Bonjour.");
    stream.finish();
    return { events, stream };
  };

  it("Fish auth failure → ElevenLabs is called and speaks", async () => {
    const f = scriptedFetch();
    const r = route(f.fetch);
    f.calls[0].status(401);
    await flush();
    expect(f.calls[1].url).toContain("api.elevenlabs.io");
    f.calls[1].stream().end();
    await flush();
    // An empty body is a failure, not silence: with Fish refused, TTS reports unavailable.
    expect(r.events).toEqual([
      { type: "error", message: expect.any(String), timeout: false, fatal: false },
      { type: "done" },
    ]);
    const g = scriptedFetch();
    const ok = route(g.fetch);
    g.calls[0].status(401);
    await flush();
    const body = g.calls[1].stream();
    body.push("x");
    body.end();
    await flush();
    expect(ok.events.map((e) => [e.type, e.provider])).toEqual([
      ["audio", "elevenlabs"],
      ["done", undefined],
    ]);
  });

  it("Fish rate limit → ElevenLabs", async () => {
    const f = scriptedFetch();
    route(f.fetch);
    f.calls[0].status(429);
    await flush();
    expect(f.calls[1]?.url).toContain("api.elevenlabs.io");
  });

  it("Fish never sends a first byte → TIMEOUT → ElevenLabs; ElevenLabs timing out too → timeout error", async () => {
    const f = scriptedFetch();
    const r = route(f.fetch, { firstAudioTimeoutMs: 20 });
    f.calls[0].stream(); // headers, then nothing
    await sleep(50);
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.calls[1].url).toContain("api.elevenlabs.io");
    await sleep(50);
    await flush();
    expect(r.events).toEqual([
      { type: "error", message: expect.any(String), timeout: true, fatal: false },
      { type: "done" },
    ]);
  });

  it("barge-in mid-stream aborts Fish and does not call ElevenLabs", async () => {
    const f = scriptedFetch();
    const r = route(f.fetch);
    const body = f.calls[0].stream();
    body.push("half");
    await flush();
    r.stream.cancel("BARGE_IN");
    await flush();
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.calls).toHaveLength(1);
    expect(r.events).toEqual([]);
  });

  it("ElevenLabs abort: same guarantee when it is the provider speaking", async () => {
    const f = scriptedFetch();
    const r = route(f.fetch);
    f.calls[0].status(503);
    await flush();
    f.calls[1].stream().push("half");
    r.stream.cancel("USER_CANCEL");
    await flush();
    expect(f.calls[1].signal.aborted).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(r.events).toEqual([]);
  });
});
