import { describe, expect, it } from "vitest";

import type { SttEvent, TtsEvent } from "@/core/voice/contracts";

import {
  DEFAULT_VOICE_LANGUAGE,
  OmniRouteStt,
  OmniRouteTts,
  omniRouteVoiceFromEnv,
  speakable,
  ttsVoice,
  ttsVoiceId,
  wav,
} from "./omniroute-voice";
import { SENTENCE_CHUNKING, SpeechChunker } from "./tts/speech-text";

const flush = () => new Promise((r) => setImmediate(r));

type Call = { url: string; body: BodyInit | null | undefined; signal: AbortSignal };

/** Scripted fetch: each call waits for the test to resolve or reject it. */
function fakeFetch() {
  const calls: (Call & { resolve: (r: Response) => void; reject: (e: unknown) => void })[] = [];
  const fetch = ((url: string, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({ url, body: init.body, signal: init.signal!, resolve, reject });
      init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const config = (fetch: typeof globalThis.fetch) => ({ baseUrl: "http://gw/", apiKey: "k", fetch });
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const mp3 = (text: string) => new Response(text, { headers: { "content-type": "audio/mpeg" } });
const frame = (n: number) => new Uint8Array(n).fill(1);

describe("OmniRouteStt", () => {
  it("refuses non-PCM input", () => {
    const stt = new OmniRouteStt(config(fakeFetch().fetch), "m");
    expect(() => stt.open({ encoding: "opus", sampleRate: 16000 }, () => {})).toThrow(
      /unsupported/,
    );
  });

  it("posts the whole utterance as WAV once on finish and emits one final", async () => {
    const f = fakeFetch();
    const events: SttEvent[] = [];
    const stream = new OmniRouteStt(config(f.fetch), "groq/whisper", 0).open(
      { encoding: "pcm16", sampleRate: 16000, language: "fr-FR" },
      (e) => events.push(e),
    );
    stream.write(frame(3200));
    stream.write(frame(3200));
    expect(f.calls).toHaveLength(0); // partials disabled
    stream.finish();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("http://gw/v1/audio/transcriptions");
    const form = f.calls[0].body as FormData;
    expect(form.get("model")).toBe("groq/whisper");
    expect(form.get("language")).toBe("fr");
    const file = new Uint8Array(await (form.get("file") as Blob).arrayBuffer());
    expect(new TextDecoder().decode(file.subarray(0, 4))).toBe("RIFF");
    expect(file.length).toBe(44 + 6400);
    f.calls[0].resolve(json({ text: " bonjour " }));
    await flush();
    expect(events).toEqual([{ type: "final", text: "bonjour", language: "fr" }]);
  });

  it("re-transcribes for partials, one request in flight, none after finish", async () => {
    const f = fakeFetch();
    const events: SttEvent[] = [];
    const stream = new OmniRouteStt(config(f.fetch), "m", 0.1).open(
      { encoding: "pcm16", sampleRate: 16000 },
      (e) => events.push(e),
    );
    stream.write(frame(3200)); // 0.1 s -> interim
    stream.write(frame(3200)); // interim still in flight: no second request
    expect(f.calls).toHaveLength(1);
    f.calls[0].resolve(json({ text: "bon" }));
    await flush();
    // The language is the one STT actually asked for (configured fallback), not undefined.
    expect(events).toEqual([{ type: "partial", text: "bon", language: "fr" }]);
    stream.write(frame(3200)); // new interim
    expect(f.calls).toHaveLength(2);
    stream.finish(); // aborts the interim, sends the final
    await flush();
    expect(f.calls[1].signal.aborted).toBe(true);
    f.calls[2].resolve(json({ text: "bonjour" }));
    await flush();
    expect(events.map((e) => e.type)).toEqual(["partial", "final"]);
  });

  it("an interim failure emits nothing", async () => {
    const f = fakeFetch();
    const events: SttEvent[] = [];
    const stream = new OmniRouteStt(config(f.fetch), "m", 0.1).open(
      { encoding: "pcm16", sampleRate: 16000 },
      (e) => events.push(e),
    );
    stream.write(frame(3200));
    f.calls[0].resolve(json({ error: "x" }, 500));
    await flush();
    expect(events).toEqual([]);
  });

  it("classifies final failures: HTTP error, timeout, and silence on cancel", async () => {
    const run = async (
      settle: (c: ReturnType<typeof fakeFetch>["calls"][number]) => void,
      cancel = false,
    ) => {
      const f = fakeFetch();
      const events: SttEvent[] = [];
      const stream = new OmniRouteStt(config(f.fetch), "m", 0).open(
        { encoding: "pcm16", sampleRate: 16000 },
        (e) => events.push(e),
      );
      stream.write(frame(10));
      stream.finish();
      if (cancel) stream.cancel();
      settle(f.calls[0]);
      await flush();
      return events;
    };
    const http = await run((c) => c.resolve(json({}, 500)));
    expect(http).toEqual([
      { type: "error", message: expect.stringContaining("HTTP 500"), timeout: false },
    ]);
    const timeout = await run((c) =>
      c.reject(Object.assign(new Error("t"), { name: "TimeoutError" })),
    );
    expect(timeout).toEqual([{ type: "error", message: expect.any(String), timeout: true }]);
    const cancelled = await run(() => {}, true);
    expect(cancelled).toEqual([]);
  });
});

describe("OmniRouteTts", () => {
  const start = () => {
    const f = fakeFetch();
    const events: TtsEvent[] = [];
    const stream = new OmniRouteTts(config(f.fetch), "gtts/fr").start({}, (e) => events.push(e));
    const input = (i: number) => JSON.parse(String(f.calls[i].body)).input as string;
    return { f, events, stream, input };
  };

  it("synthesizes complete sentences in order, then done once", async () => {
    const t = start();
    t.stream.text("Bonjour. Comment");
    t.stream.text(" allez-vous ?");
    t.stream.finish();
    expect(t.f.calls).toHaveLength(1); // one request at a time
    expect(t.f.calls[0].url).toBe("http://gw/v1/audio/speech");
    expect(t.input(0)).toBe("Bonjour.");
    t.f.calls[0].resolve(mp3("a"));
    await flush();
    expect(t.input(1)).toBe("Comment allez-vous ?");
    t.f.calls[1].resolve(mp3("b"));
    await flush();
    expect(t.events.map((e) => e.type)).toEqual(["audio", "audio", "done"]);
    expect(t.events[0]).toMatchObject({ mime: "audio/mpeg" });
    expect(new TextDecoder().decode((t.events[1] as { data: Uint8Array }).data)).toBe("b");
  });

  it("cancel mid-queue: no more audio and no done", async () => {
    const t = start();
    t.stream.text("Un. Deux. Trois.");
    t.stream.finish();
    t.stream.cancel();
    expect(t.f.calls[0].signal.aborted).toBe(true);
    await flush();
    expect(t.events).toEqual([]);
    expect(t.f.calls).toHaveLength(1);
  });

  it("an HTTP error or a non-audio 200 loses that sentence and moves to the next", async () => {
    for (const response of [json({}, 502), json({ ok: true })]) {
      const t = start();
      t.stream.text("Un. Deux.");
      t.stream.finish();
      t.f.calls[0].resolve(response);
      await flush();
      /*
       * One error for the lost sentence, `fatal: false`, and NO done yet — the queue
       * moved on to "Deux." instead of being abandoned. This used to assert a single
       * request, because the first failure aborted the whole stream; that is what made
       * one rate-limited sentence silence every sentence after it. The SESSION decides
       * whether the result was a degraded answer or a mute voice (voice-session.ts).
       */
      expect(t.events).toEqual([
        { type: "error", message: expect.any(String), timeout: false, fatal: false },
      ]);
      expect(t.f.calls).toHaveLength(2);
      expect(t.input(1)).toBe("Deux.");
    }
  });

  it("one lost sentence does not cancel the sentences after it", async () => {
    const t = start();
    t.stream.text("Une. Deux. Trois.");
    t.stream.finish();
    // Sentence 1 fails (the gateway rate-limits); 2 and 3 must still be synthesized.
    t.f.calls[0].resolve(json({ error: "rate limited" }, 429));
    await flush();
    expect(t.events).toEqual([
      { type: "error", message: expect.stringContaining("429"), timeout: false, fatal: false },
    ]);
    expect(t.input(1)).toBe("Deux.");
    t.f.calls[1].resolve(mp3("b"));
    await flush();
    expect(t.input(2)).toBe("Trois.");
    t.f.calls[2].resolve(mp3("c"));
    await flush();
    // The answer completed: two sentences of audio, one non-fatal loss, one done.
    expect(t.events.map((e) => e.type)).toEqual(["error", "audio", "audio", "done"]);
    expect(t.events.filter((e) => e.type === "error")).toHaveLength(1);
  });

  it("an explicit cancel still stops everything, unlike a lost sentence", async () => {
    const t = start();
    t.stream.text("Une. Deux.");
    t.stream.finish();
    t.f.calls[0].resolve(json({ error: "nope" }, 500));
    await flush();
    t.stream.cancel();
    await flush();
    expect(t.events.map((e) => e.type)).toEqual(["error"]);
    expect(t.f.calls).toHaveLength(2); // the second was in flight when cancelled
  });

  it("strips markdown before speaking", async () => {
    const t = start();
    t.stream.text("**Statut** : voir [le cockpit](https://x.y/z). ");
    expect(t.input(0)).toBe("Statut : voir le cockpit.");
  });
});

/**
 * REGRESSION — the French voice defect observed on a real Xiaomi 13T.
 *
 * The gateway IGNORES the model id for /v1/audio/speech ("gtts/fr" and "gtts/en"
 * return byte-identical audio) and instead guesses the language from the text. The
 * reply "Le moteur cognitif d'ICOS n'est pas connecté (NOT_CONNECTED) : ..." contains
 * an English token, so the guess flipped to English and the phone spoke French with an
 * English voice. Measured round-trip at the time: detected language "English", transcript
 * "Le motor cognitive dicos nespas connecte, not underscore connected, ...". Sending the
 * `voice` field fixed it (detected "French"); `language`/`lang` are ignored by the gateway
 * and "fr-FR" is refused with 502, hence the 2-letter narrowing in ttsVoice.
 */
describe("TTS language is sent, never guessed from the text", () => {
  const voiceOf = (options: { language?: string }, fallback?: string) => {
    const f = fakeFetch();
    const tts = fallback
      ? new OmniRouteTts(config(f.fetch), "gtts/fr", fallback)
      : new OmniRouteTts(config(f.fetch), "gtts/fr");
    tts.start(options, () => {}).text("Bonjour. ");
    return JSON.parse(String(f.calls[0].body)) as { voice?: string; model: string; input: string };
  };

  it("sends the session language as the gateway `voice` field", () => {
    expect(voiceOf({ language: "fr-FR" }).voice).toBe("fr");
    expect(voiceOf({ language: "en-GB" }).voice).toBe("en");
  });

  it("falls back to the configured language when the session states none", () => {
    expect(voiceOf({}).voice).toBe(DEFAULT_VOICE_LANGUAGE);
    expect(voiceOf({}).voice).toBe("fr");
    expect(voiceOf({}, "es").voice).toBe("es");
    expect(voiceOf({ language: "!!" }, "es").voice).toBe("es");
  });

  it("never omits the voice, whatever the session sends", () => {
    for (const language of [undefined, "", "   ", "x", "fr", "FR-fr", "zzzz"]) {
      expect(voiceOf({ ...(language === undefined ? {} : { language }) }).voice).toMatch(
        /^[a-z]{2}$/,
      );
    }
  });

  it("ttsVoice narrows to the 2-letter code the gateway accepts (fr-FR is a 502)", () => {
    expect(ttsVoice("fr-FR")).toBe("fr");
    expect(ttsVoice("FR")).toBe("fr");
    expect(ttsVoice(" en-US ")).toBe("en");
    expect(ttsVoice("f")).toBeNull();
    expect(ttsVoice("")).toBeNull();
    expect(ttsVoice(undefined)).toBeNull();
    expect(ttsVoice("12")).toBeNull();
  });

  it("STT asks for the configured language instead of letting Whisper guess", () => {
    const f = fakeFetch();
    new OmniRouteStt(config(f.fetch), "whisper", 0, "fr")
      .open({ encoding: "pcm16", sampleRate: 16_000 }, () => {})
      .finish();
    expect((f.calls[0].body as FormData).get("language")).toBe("fr");
  });
});

describe("a premium voice is a VOICE, not a language code", () => {
  const sent = (voiceId: string | null, options: { language?: string } = {}) => {
    const f = fakeFetch();
    new OmniRouteTts(config(f.fetch), "fishaudio/s1", DEFAULT_VOICE_LANGUAGE, voiceId)
      .start(options, () => {})
      .text("Bonsoir Geoffrey. ");
    return JSON.parse(String(f.calls[0].body)) as { voice?: string; model: string };
  };

  it("sends a configured voice id VERBATIM, never narrowed to two letters", () => {
    // Fish Audio reference_id: the gateway maps `voice` -> reference_id.
    expect(sent("7f3a2b91c4de4f0a8b6d5e2c1a9f8e7d").voice).toBe("7f3a2b91c4de4f0a8b6d5e2c1a9f8e7d");
    // ElevenLabs voice id: the gateway puts `voice` in the URL path.
    expect(sent("21m00Tcm4TlvDq8ikWAM").voice).toBe("21m00Tcm4TlvDq8ikWAM");
    // EdgeTTS neural voice name, and an OpenAI voice name.
    expect(sent("fr-FR-RemyMultilingualNeural").voice).toBe("fr-FR-RemyMultilingualNeural");
    expect(sent("onyx").voice).toBe("onyx");
  });

  it("the configured voice wins over the session language, which must not truncate it", () => {
    // Before this, `voice` could only be /^[a-z]{2}$/ — so "fr-FR-HenriNeural" left
    // ICOS as "fr" and every premium backend was unreachable by construction.
    expect(sent("fr-FR-HenriNeural", { language: "fr-FR" }).voice).toBe("fr-FR-HenriNeural");
    expect(sent("onyx", { language: "en-GB" }).voice).toBe("onyx");
  });

  it("without a configured voice the language-code fallback is unchanged", () => {
    expect(sent(null, { language: "fr-FR" }).voice).toBe("fr");
    expect(sent(null).voice).toBe(DEFAULT_VOICE_LANGUAGE);
  });

  it("ttsVoiceId drops anything that is not a plausible voice id, rather than sending it", () => {
    for (const ok of [
      "onyx",
      "fr-FR-RemyMultilingualNeural",
      "a.b_c:d-1",
      "21m00Tcm4TlvDq8ikWAM",
    ]) {
      expect(ttsVoiceId(ok)).toBe(ok);
    }
    expect(ttsVoiceId("  onyx  ")).toBe("onyx");
    for (const bad of [undefined, "", "   ", "a/b", "../etc/passwd", "a b", "x".repeat(129)]) {
      expect(ttsVoiceId(bad)).toBeNull();
    }
  });

  it("ICOS_VOICE_TTS_VOICE reaches the provider and is reported in the status", () => {
    const gateway = { OMNIROUTE_BASE_URL: "http://gw", OMNIROUTE_API_KEY: "k" };
    const configured = omniRouteVoiceFromEnv({
      ...gateway,
      ICOS_VOICE_TTS_MODEL: "fishaudio/s1",
      ICOS_VOICE_TTS_VOICE: "7f3a2b91c4de4f0a8b6d5e2c1a9f8e7d",
    });
    expect(configured.status).toMatchObject({
      tts: "CONFIGURED",
      voice: "7f3a2b91c4de4f0a8b6d5e2c1a9f8e7d",
    });
    // The id is part of the provider identity, so metrics/logs name the live voice.
    expect(configured.tts?.id).toBe("omniroute:fishaudio/s1:7f3a2b91c4de4f0a8b6d5e2c1a9f8e7d");
    // A rejected value must not silently become the voice.
    expect(
      omniRouteVoiceFromEnv({ ...gateway, ICOS_VOICE_TTS_MODEL: "t", ICOS_VOICE_TTS_VOICE: "a/b" })
        .status.voice,
    ).toBe("language");
  });
});

describe("helpers and configuration", () => {
  it("splits sentences and keeps the incomplete tail", () => {
    const split = (text: string) => {
      const chunker = new SpeechChunker(SENTENCE_CHUNKING);
      return { sentences: chunker.push(text), rest: chunker.flush() };
    };
    expect(split("Oui. Non ! Peut-être… ou pas")).toEqual({
      sentences: ["Oui.", "Non !", "Peut-être…"],
      rest: ["ou pas"],
    });
    // A line break is a boundary, and the line gets its pause.
    expect(split("ligne un\nligne deux")).toEqual({
      sentences: ["ligne un."],
      rest: ["ligne deux"],
    });
    expect(split("")).toEqual({ sentences: [], rest: [] });
    expect(split("Pi vaut 3.14 environ. Fin")).toEqual({
      sentences: ["Pi vaut 3.14 environ."],
      rest: ["Fin"],
    });
  });

  it("speakable() removes markup and URLs", () => {
    expect(speakable("# Titre `code` > cité https://a.b")).toBe("Titre code cité");
  });

  it("wav() writes a valid mono 16-bit header", () => {
    const out = new DataView(wav(new Uint8Array(4), 16000).buffer);
    expect(out.getUint32(24, true)).toBe(16000);
    expect(out.getUint16(22, true)).toBe(1);
    expect(out.getUint32(40, true)).toBe(4);
  });

  it("reports NOT_CONFIGURED instead of faking a provider", () => {
    const gateway = { OMNIROUTE_BASE_URL: "http://gw", OMNIROUTE_API_KEY: "k" };
    expect(omniRouteVoiceFromEnv({}).status).toEqual({
      stt: "NOT_CONFIGURED",
      tts: "NOT_CONFIGURED",
      language: "fr",
      voice: "language",
    });
    expect(
      omniRouteVoiceFromEnv({ ICOS_VOICE_STT_MODEL: "m", ICOS_VOICE_TTS_MODEL: "t" }).status,
    ).toEqual({
      stt: "NOT_CONFIGURED",
      tts: "NOT_CONFIGURED",
      language: "fr",
      voice: "language",
    });
    const configured = omniRouteVoiceFromEnv({ ...gateway, ICOS_VOICE_STT_MODEL: "m" });
    expect(configured.status).toEqual({
      stt: "CONFIGURED",
      tts: "NOT_CONFIGURED",
      language: "fr",
      voice: "language",
    });
    expect(configured.stt?.simulated).toBe(false);
  });

  it("takes the fallback language from configuration, keeping other locales possible", () => {
    const gateway = { OMNIROUTE_BASE_URL: "http://gw", OMNIROUTE_API_KEY: "k" };
    expect(omniRouteVoiceFromEnv({ ...gateway }).status.language).toBe("fr");
    expect(
      omniRouteVoiceFromEnv({ ...gateway, ICOS_VOICE_LANGUAGE: "en-US" }).status.language,
    ).toBe("en");
    // Nonsense never silently becomes a wrong voice: it falls back to the default.
    expect(omniRouteVoiceFromEnv({ ...gateway, ICOS_VOICE_LANGUAGE: "!" }).status.language).toBe(
      "fr",
    );
  });
});
