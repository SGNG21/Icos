import { describe, expect, it } from "vitest";

import type { SttEvent, TtsEvent } from "@/core/voice/contracts";

import {
  OmniRouteStt,
  OmniRouteTts,
  omniRouteVoiceFromEnv,
  speakable,
  takeSentences,
  wav,
} from "./omniroute-voice";

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
    expect(events).toEqual([{ type: "partial", text: "bon", language: undefined }]);
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

  it("an HTTP error or a non-audio 200 is one error and no done", async () => {
    for (const response of [json({}, 502), json({ ok: true })]) {
      const t = start();
      t.stream.text("Un. Deux.");
      t.stream.finish();
      t.f.calls[0].resolve(response);
      await flush();
      expect(t.events).toEqual([{ type: "error", message: expect.any(String), timeout: false }]);
      expect(t.f.calls).toHaveLength(1);
    }
  });

  it("strips markdown before speaking", async () => {
    const t = start();
    t.stream.text("**Statut** : voir [le cockpit](https://x.y/z). ");
    expect(t.input(0)).toBe("Statut : voir le cockpit.");
  });
});

describe("helpers and configuration", () => {
  it("splits sentences and keeps the incomplete tail", () => {
    expect(takeSentences("Oui. Non ! Peut-être… ou pas")).toEqual({
      sentences: ["Oui.", "Non !", "Peut-être…"],
      rest: " ou pas",
    });
    expect(takeSentences("ligne un\nligne deux")).toEqual({
      sentences: ["ligne un"],
      rest: "ligne deux",
    });
    expect(takeSentences("")).toEqual({ sentences: [], rest: "" });
    expect(takeSentences("Pi vaut 3.14 environ. Fin")).toEqual({
      sentences: ["Pi vaut 3.14 environ."],
      rest: " Fin",
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
    });
    expect(
      omniRouteVoiceFromEnv({ ICOS_VOICE_STT_MODEL: "m", ICOS_VOICE_TTS_MODEL: "t" }).status,
    ).toEqual({
      stt: "NOT_CONFIGURED",
      tts: "NOT_CONFIGURED",
    });
    const configured = omniRouteVoiceFromEnv({ ...gateway, ICOS_VOICE_STT_MODEL: "m" });
    expect(configured.status).toEqual({ stt: "CONFIGURED", tts: "NOT_CONFIGURED" });
    expect(configured.stt?.simulated).toBe(false);
  });
});
