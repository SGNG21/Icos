import { describe, expect, it, vi } from "vitest";

import type { TtsEvent } from "@/core/voice/contracts";

import { SENTENCE_CHUNKING } from "./speech-text";
import { logTtsEvent, type TtsTelemetryEvent } from "./telemetry";
import { decode, FakeSynth, flush, sleep, type Plan } from "./tts-test-kit";
import { TtsRouter, type TtsRouterOptions } from "./tts-router";

/** SIMULATED providers throughout: these tests prove routing logic, not vendor latency. */

function setup(
  plans: { fish?: Plan[]; elevenlabs?: Plan[]; gtts?: Plan[] },
  options: Partial<TtsRouterOptions> = {},
) {
  let clock = 1_000;
  const fish = new FakeSynth("fish", plans.fish ?? [{ audio: "fish" }]);
  const elevenlabs = new FakeSynth("elevenlabs", plans.elevenlabs ?? [{ audio: "eleven" }]);
  const gtts = new FakeSynth("gtts", plans.gtts ?? [{ audio: "gtts" }], false, "gtts/fr", null);
  const telemetry: TtsTelemetryEvent[] = [];
  const router = new TtsRouter({
    providers: [fish, elevenlabs, gtts],
    chunking: SENTENCE_CHUNKING,
    observer: (e) => telemetry.push(e),
    now: () => clock,
    ...options,
  });
  const events: TtsEvent[] = [];
  const speak = (text: string, turnId = "turn-1") => {
    const stream = router.start({ language: "fr-FR", turnId }, (e) => events.push(e));
    stream.text(text);
    stream.finish();
    return stream;
  };
  const audio = () =>
    events.flatMap((e) =>
      e.type === "audio" ? [{ text: decode(e.data), provider: e.provider }] : [],
    );
  const of = (name: TtsTelemetryEvent["event"]) => telemetry.filter((t) => t.event === name);
  return {
    router,
    fish,
    elevenlabs,
    gtts,
    events,
    telemetry,
    speak,
    audio,
    of,
    advance: (ms: number) => void (clock += ms),
  };
}

describe("TtsRouter — provider selection and fallback", () => {
  it("Fish is selected first and speaks every chunk, in order, then done once", async () => {
    const s = setup({ fish: [{ audio: "un" }, { audio: "deux" }] });
    s.speak("Premier. Second.");
    await flush();
    expect(s.fish.calls.map((c) => c.text)).toEqual(["Premier.", "Second."]);
    expect(s.fish.calls[0].language).toBe("fr");
    expect(s.elevenlabs.calls).toHaveLength(0);
    expect(s.audio()).toEqual([
      { text: "un", provider: "fish" },
      { text: "deux", provider: "fish" },
    ]);
    expect(s.events.filter((e) => e.type === "done")).toHaveLength(1);
  });

  it("Fish failure → ElevenLabs speaks the same chunk; the user still hears it", async () => {
    const s = setup({ fish: [{ fail: "UNAVAILABLE" }] }, { retries: 0 });
    s.speak("Bonjour.");
    await flush();
    expect(s.elevenlabs.calls.map((c) => c.text)).toEqual(["Bonjour."]);
    expect(s.audio()).toEqual([{ text: "eleven", provider: "elevenlabs" }]);
    expect(s.events.find((e) => e.type === "audio")).toMatchObject({ fallback: true });
    expect(s.of("tts.fallback")).toEqual([
      expect.objectContaining({ from: "fish", provider: "elevenlabs", failure: "UNAVAILABLE" }),
    ]);
  });

  it("rate limit and timeout fall back at once, without retrying the same provider", async () => {
    for (const fail of ["RATE_LIMITED", "TIMEOUT"] as const) {
      const s = setup({ fish: [{ fail }] });
      s.speak("Bonjour.");
      await flush();
      expect(s.fish.calls).toHaveLength(1);
      expect(s.audio()).toEqual([{ text: "eleven", provider: "elevenlabs" }]);
    }
  });

  it("5xx: one bounded retry on the same provider, then fallback", async () => {
    const s = setup({ fish: [{ fail: "UPSTREAM", status: 503 }] }, { retries: 1 });
    s.speak("Bonjour.");
    await flush();
    expect(s.fish.calls).toHaveLength(2);
    expect(s.elevenlabs.calls).toHaveLength(1);
    const recovered = setup({ fish: [{ fail: "UPSTREAM", status: 502 }, { audio: "ok" }] });
    recovered.speak("Bonjour.");
    await flush();
    expect(recovered.audio()).toEqual([{ text: "ok", provider: "fish" }]);
    expect(recovered.elevenlabs.calls).toHaveLength(0);
  });

  it("auth failure: no retry, fallback, and the circuit opens at once", async () => {
    const s = setup({ fish: [{ fail: "AUTH_FAILED", status: 401 }] });
    s.speak("Bonjour.");
    await flush();
    expect(s.fish.calls).toHaveLength(1);
    expect(s.audio()).toEqual([{ text: "eleven", provider: "elevenlabs" }]);
    expect(s.router.health()[0]).toMatchObject({ provider: "fish", state: "AUTH_FAILED" });
    s.speak("Encore.", "turn-2");
    await flush();
    expect(s.fish.calls).toHaveLength(1); // not asked again
  });

  it("Fish circuit open → ElevenLabs directly, and Fish is retried after its cooldown", async () => {
    const s = setup(
      {
        fish: [
          { fail: "UNAVAILABLE" },
          { fail: "UNAVAILABLE" },
          { fail: "UNAVAILABLE" },
          { audio: "back" },
        ],
      },
      {
        retries: 0,
        circuit: {
          failureThreshold: 3,
          cooldownMs: 30_000,
          hardCooldownMs: 300_000,
          maxRetryAfterMs: 300_000,
        },
      },
    );
    for (let i = 0; i < 3; i++) {
      s.speak("Bonjour.", `turn-${i}`);
      await flush();
    }
    expect(s.fish.calls).toHaveLength(3);
    expect(s.router.health()[0].circuit?.state).toBe("open");
    s.speak("Direct.", "turn-3");
    await flush();
    expect(s.fish.calls).toHaveLength(3); // skipped without a request
    expect(s.elevenlabs.calls.at(-1)?.text).toBe("Direct.");
    // Skipping an open circuit is still a fallback, and the metrics say so.
    expect(s.events.filter((e) => e.type === "audio").at(-1)).toMatchObject({
      provider: "elevenlabs",
      fallback: true,
    });
    s.advance(30_000);
    s.speak("Retour.", "turn-4");
    await flush();
    expect(s.fish.calls).toHaveLength(4); // half-open trial
    expect(s.audio().at(-1)).toEqual({ text: "back", provider: "fish" });
    expect(s.router.health()[0]).toMatchObject({ state: "READY", circuit: { state: "closed" } });
  });

  it("ElevenLabs failure → the emergency fallback (gTTS) speaks", async () => {
    const s = setup({
      fish: [{ fail: "TIMEOUT" }],
      elevenlabs: [{ fail: "RATE_LIMITED", status: 429 }],
    });
    s.speak("Bonjour.");
    await flush();
    expect(s.audio()).toEqual([{ text: "gtts", provider: "gtts" }]);
    expect(s.of("tts.fallback").map((f) => `${f.from}>${f.provider}`)).toEqual([
      "fish>elevenlabs",
      "elevenlabs>gtts",
    ]);
  });

  it("all providers unavailable → each chunk is lost non-fatally, no audio, done once, tts.failed", async () => {
    const s = setup(
      {
        fish: [{ fail: "UNAVAILABLE" }],
        elevenlabs: [{ fail: "UPSTREAM" }],
        gtts: [{ fail: "UNAVAILABLE" }],
      },
      { retries: 0 },
    );
    s.speak("Un. Deux.");
    await flush();
    const lost = { type: "error", message: expect.any(String), timeout: false, fatal: false };
    expect(s.events).toEqual([lost, lost, { type: "done" }]);
    // A lost chunk does not end the answer: the second one is still attempted.
    expect(s.fish.calls.map((c) => c.text)).toEqual(["Un.", "Deux."]);
    expect(s.of("tts.chunk_lost")).toHaveLength(2);
    expect(s.of("tts.completed")).toEqual([]);
    expect(s.of("tts.failed")).toEqual([
      expect.objectContaining({
        reason: "ALL_PROVIDERS_FAILED",
        failure: "UNAVAILABLE",
        lostChunks: 2,
      }),
    ]);
  });

  it("one chunk lost everywhere does not silence the next: the answer degrades, in order", async () => {
    const s = setup(
      {
        fish: [{ fail: "UNAVAILABLE" }, { audio: "deux" }],
        elevenlabs: [{ fail: "UPSTREAM" }],
        gtts: [{ fail: "UNAVAILABLE" }],
      },
      { retries: 0 },
    );
    s.speak("Un. Deux.");
    await flush();
    expect(s.events.map((e) => e.type)).toEqual(["error", "audio", "done"]);
    expect(s.events[0]).toMatchObject({ fatal: false });
    expect(s.audio()).toEqual([{ text: "deux", provider: "fish" }]);
    expect(s.of("tts.failed")).toEqual([]);
    expect(s.of("tts.completed")).toEqual([expect.objectContaining({ chunks: 1, lostChunks: 1 })]);
  });

  it("a timeout everywhere is reported as a timeout", async () => {
    const s = setup({
      fish: [{ fail: "TIMEOUT" }],
      elevenlabs: [{ fail: "TIMEOUT" }],
      gtts: [{ fail: "TIMEOUT" }],
    });
    s.speak("Bonjour.");
    await flush();
    expect(s.events).toEqual([
      { type: "error", message: expect.any(String), timeout: true, fatal: false },
      { type: "done" },
    ]);
  });

  it("an invalid request is not resent to every provider", async () => {
    const s = setup({ fish: [{ fail: "INVALID_REQUEST", status: 422 }] });
    s.speak("Bonjour.");
    await flush();
    expect(s.elevenlabs.calls).toHaveLength(0);
    expect(s.gtts.calls).toHaveLength(0);
    expect(s.events.map((e) => e.type)).toEqual(["error", "done"]);
  });

  it("once a fallback has spoken, the rest of THIS answer keeps that voice; the next answer starts at Fish", async () => {
    const s = setup({ fish: [{ fail: "TIMEOUT" }, { audio: "f" }] });
    s.speak("Un. Deux.");
    await flush();
    expect(s.audio().map((a) => a.provider)).toEqual(["elevenlabs", "elevenlabs"]);
    expect(s.fish.calls).toHaveLength(1);
    s.speak("Trois.", "turn-2");
    await flush();
    expect(s.audio().at(-1)).toEqual({ text: "f", provider: "fish" });
  });

  it("fallback disabled: only the primary is used", async () => {
    const s = setup({ fish: [{ fail: "UNAVAILABLE" }] }, { fallbackEnabled: false, retries: 0 });
    s.speak("Bonjour.");
    await flush();
    expect(s.elevenlabs.calls).toHaveLength(0);
    expect(s.events.map((e) => e.type)).toEqual(["error", "done"]);
  });

  it("no first audio in time on a streaming provider → TIMEOUT → fallback", async () => {
    const s = setup({ fish: ["hang"] }, { firstAudioTimeoutMs: 20 });
    s.speak("Bonjour.");
    await sleep(60);
    await flush();
    expect(s.fish.calls[0].signal.aborted).toBe(true);
    expect(s.audio()).toEqual([{ text: "eleven", provider: "elevenlabs" }]);
    expect(s.of("tts.fallback")[0]).toMatchObject({ failure: "TIMEOUT" });
  });
});

describe("TtsRouter — abort, barge-in and stale audio", () => {
  it("cancel aborts the in-flight request and NEVER falls back", async () => {
    const s = setup({ fish: ["hang"] });
    const stream = s.speak("Bonjour. Encore.");
    await flush();
    stream.cancel("BARGE_IN");
    await flush();
    expect(s.fish.calls[0].signal.aborted).toBe(true);
    expect(s.elevenlabs.calls).toHaveLength(0);
    expect(s.events).toEqual([]);
    expect(s.of("tts.aborted")).toEqual([expect.objectContaining({ reason: "BARGE_IN" })]);
    expect(s.of("tts.fallback")).toEqual([]);
    // An abort is no evidence against Fish.
    expect(s.router.health()[0].circuit).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("audio that arrives after cancel is dropped: old audio never resumes", async () => {
    const s = setup({ fish: ["manual"] });
    const stream = s.speak("Bonjour.");
    await flush();
    const body = s.fish.calls[0].respond();
    stream.cancel("BARGE_IN");
    body.push("late");
    body.end();
    await flush();
    expect(s.events).toEqual([]);
  });

  it("hangup mid-stream aborts synthesis; a second turn on the same router works", async () => {
    const s = setup({ fish: ["hang", { audio: "deux" }] });
    const first = s.speak("Premier tour.");
    await flush();
    first.cancel("DETACHED");
    await flush();
    expect(s.fish.calls[0].signal.aborted).toBe(true);
    s.speak("Second tour.", "turn-2");
    await flush();
    expect(s.audio()).toEqual([{ text: "deux", provider: "fish" }]);
  });

  it("streams provider bytes into one decodable chunk per sentence", async () => {
    const s = setup({ fish: [{ audio: ["ID3", "frame1", "frame2"] }] });
    s.speak("Bonjour.");
    await flush();
    expect(s.audio()).toEqual([{ text: "ID3frame1frame2", provider: "fish" }]);
  });

  it("an empty audio body is a provider failure, not silence", async () => {
    const s = setup({ fish: [{ audio: [] }] });
    s.speak("Bonjour.");
    await flush();
    expect(s.audio()).toEqual([{ text: "eleven", provider: "elevenlabs" }]);
  });
});

describe("TtsRouter — metrics, usage, health", () => {
  it("records first-audio latency, provider TTFB, fallback and totals", async () => {
    const s = setup({ fish: ["manual"] });
    s.speak("Bonjour.");
    await flush();
    s.advance(120);
    const body = s.fish.calls[0].respond();
    body.push("a");
    await flush();
    s.advance(30);
    body.end();
    await flush();
    expect(s.of("tts.requested")).toHaveLength(1);
    expect(s.of("tts.provider.selected")[0]).toMatchObject({
      provider: "fish",
      model: "fish-model",
      voice: "fish-voice",
      attempt: 0,
      circuitState: "closed",
      fallbackUsed: false,
      turnId: "turn-1",
    });
    expect(s.of("tts.first_audio")).toEqual([
      expect.objectContaining({
        provider: "fish",
        providerTtfbMs: 120,
        firstAudioMs: 150,
        fallbackUsed: false,
      }),
    ]);
    expect(s.of("tts.completed")).toEqual([
      expect.objectContaining({ provider: "fish", chars: 8, bytes: 1, chunks: 1, totalMs: 150 }),
    ]);
  });

  it("the fallback provider is what the metrics name", async () => {
    const s = setup({ fish: [{ fail: "TIMEOUT" }] });
    s.speak("Bonjour.");
    await flush();
    expect(s.of("tts.first_audio")[0]).toMatchObject({
      provider: "elevenlabs",
      fallbackUsed: true,
    });
    expect(s.of("tts.completed")[0]).toMatchObject({ provider: "elevenlabs", fallbacks: 1 });
  });

  it("usage is raw billing input per provider — characters, bytes, retries, fallbacks — no price", async () => {
    const s = setup({ fish: [{ fail: "UPSTREAM" }] }, { retries: 1 });
    s.speak("Bonjour.");
    await flush();
    const [fish, eleven] = s.router.usage();
    expect(fish).toMatchObject({
      provider: "fish",
      requests: 2,
      failed: 2,
      retries: 1,
      fallbacksFrom: 1,
      characters: 16,
    });
    expect(eleven).toMatchObject({
      provider: "elevenlabs",
      requests: 1,
      succeeded: 1,
      characters: 8,
      bytes: 6,
    });
    expect(JSON.stringify(s.router.usage())).not.toMatch(/price|cost|eur|usd/i);
  });

  it("telemetry carries no text and no secret", async () => {
    const s = setup({ fish: [{ fail: "AUTH_FAILED", status: 401 }] });
    s.speak("Mon secret médical est XYZZY.");
    await flush();
    const dump = JSON.stringify(s.telemetry) + JSON.stringify(s.router.health());
    expect(dump).not.toContain("XYZZY");
    expect(dump).not.toMatch(/Bearer|xi-api-key|api_key|apiKey/i);
  });

  it("a configured key is not health: UNVERIFIED until a request or a probe proves it", async () => {
    const s = setup({});
    expect(s.router.health().map((h) => h.state)).toEqual([
      "UNVERIFIED",
      "UNVERIFIED",
      "UNVERIFIED",
    ]);
    s.elevenlabs.probeResult = "AUTH_FAILED";
    const probed = await s.router.probe();
    expect(probed.map((h) => `${h.provider}=${h.state}`)).toEqual([
      "fish=READY",
      "elevenlabs=AUTH_FAILED",
      "gtts=READY",
    ]);
    // A failed probe informs health but never routes traffic away by itself.
    expect(probed[1].circuit?.state).toBe("closed");
  });

  it("probes are bounded: reused within their TTL", async () => {
    const s = setup({}, { probeTtlMs: 60_000 });
    await s.router.probe();
    await s.router.probe();
    expect(s.fish.probes).toBe(1);
    s.advance(60_000);
    await s.router.probe();
    expect(s.fish.probes).toBe(2);
  });

  it("lists unconfigured providers as NOT_CONFIGURED with the reason, never a value", () => {
    const router = new TtsRouter({
      providers: [new FakeSynth("gtts")],
      unconfigured: [{ provider: "fish", reason: "FISH_AUDIO_API_KEY unset" }],
    });
    expect(router.health()).toEqual([
      expect.objectContaining({ provider: "gtts", state: "UNVERIFIED" }),
      { provider: "fish", state: "NOT_CONFIGURED", detail: "FISH_AUDIO_API_KEY unset" },
    ]);
  });

  it("a throwing observer never breaks speech", async () => {
    const s = setup(
      {},
      {
        observer: () => {
          throw new Error("log sink down");
        },
      },
    );
    s.speak("Bonjour.");
    await flush();
    expect(s.audio()).toEqual([{ text: "fish", provider: "fish" }]);
  });

  it("the default log sink: one completion line per answer plus fallback/failure — no chunk spam, no text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = setup({ fish: [{ fail: "TIMEOUT" }] }, { observer: logTtsEvent });
      s.speak("Phrase confidentielle XYZZY. Deuxième phrase.");
      await flush();
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.map((l) => /"event":"([^"]+)"/.exec(l)?.[1])).toEqual([
        "tts.fallback",
        "tts.completed",
      ]);
      expect(lines.every((l) => l.startsWith("TTS_EVENT "))).toBe(true);
      expect(lines.join("\n")).not.toContain("XYZZY");
      expect(JSON.parse(lines[1].slice("TTS_EVENT ".length))).toMatchObject({
        provider: "elevenlabs",
        fallbackUsed: true,
        firstAudioMs: expect.any(Number),
        providerTtfbMs: expect.any(Number),
        chunks: 2,
      });
    } finally {
      warn.mockRestore();
    }
  });
});
