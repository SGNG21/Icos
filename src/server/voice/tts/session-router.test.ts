import { describe, expect, it } from "vitest";

import { flush, say, setup, signal } from "../voice-test-harness";

import { SENTENCE_CHUNKING } from "./speech-text";
import { FakeSynth, type Plan } from "./tts-test-kit";
import { TtsRouter } from "./tts-router";

/**
 * The voice session driving the REAL TTS router (vendors are SIMULATED): what the
 * browser receives when a provider fails, when the user barges in, and when every
 * provider is down.
 */

const T1 = "turn-0001";
const T2 = "turn-0002";

function voice(plans: { fish?: Plan[]; elevenlabs?: Plan[] } = {}) {
  const fish = new FakeSynth("fish", plans.fish ?? [{ audio: "f" }]);
  const elevenlabs = new FakeSynth("elevenlabs", plans.elevenlabs ?? [{ audio: "e" }]);
  const router = new TtsRouter({
    providers: [fish, elevenlabs],
    chunking: SENTENCE_CHUNKING,
    retries: 0,
  });
  const s = setup({ ttsProvider: router });
  return { ...s, fish, elevenlabs, router };
}

describe("voice session × TTS router", () => {
  it("Fish fails → the browser hears ElevenLabs; metrics name the provider and the fallback", async () => {
    const s = voice({ fish: [{ fail: "UNAVAILABLE" }] });
    say(s.conn, T1, ["bonjour"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "FINAL_RESPONSE", text: "Bonjour Geoffrey." });
    await flush();
    await flush();
    expect(s.of("audio").map((a) => [a.turnId, a.generation, a.seq])).toEqual([[T1, 1, 0]]);
    expect(s.of("error")).toEqual([]);
    expect(s.of("turn_metrics")[0].metrics).toMatchObject({
      ttsProvider: "elevenlabs",
      ttsFallbackUsed: true,
      simulated: true,
    });
  });

  it("barge-in: synthesis is aborted, nothing falls back, late audio is dropped, the next turn speaks", async () => {
    const s = voice({ fish: ["manual", { audio: "deux" }] });
    say(s.conn, T1, ["raconte"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "Il était une fois. " });
    await flush();
    const inFlight = s.fish.calls[0];
    s.conn.receive(signal(T2, "VOICE_ACTIVITY_START")); // the human speaks over ICOS
    expect(inFlight.signal.aborted).toBe(true);
    expect(s.of("playback_stop")).toEqual([
      { type: "playback_stop", turnId: T1, generation: 1, reason: "BARGE_IN" },
    ]);
    const late = inFlight.respond(); // the provider answers anyway
    late.push("old");
    late.end();
    await flush();
    expect(s.of("audio")).toEqual([]);
    expect(s.elevenlabs.calls).toHaveLength(0); // an abort never falls back

    s.conn.receive({
      type: "audio",
      turnId: T2,
      seq: 0,
      encoding: "pcm16",
      sampleRate: 16_000,
      data: "AA==",
    });
    s.conn.receive(signal(T2, "VOICE_ACTIVITY_END"));
    s.conn.receive(signal(T2, "TURN_COMMIT"));
    await flush();
    s.cognitive.responses.get(T2)!.push({ type: "FINAL_RESPONSE", text: "Deuxième réponse." });
    await flush();
    await flush();
    expect(s.of("audio").map((a) => [a.turnId, a.generation])).toEqual([[T2, 2]]);
    expect(s.router.health()[0].circuit?.consecutiveFailures).toBe(0);
  });

  it("every provider down: TTS_UNAVAILABLE, and the answer still arrives as text", async () => {
    const s = voice({ fish: [{ fail: "TIMEOUT" }], elevenlabs: [{ fail: "UPSTREAM" }] });
    say(s.conn, T1, ["statut"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "FINAL_RESPONSE", text: "Tout va bien." });
    await flush();
    await flush();
    expect(s.of("response_final").map((m) => m.text)).toEqual(["Tout va bien."]);
    // Verdict once the answer ended: nothing was spoken, so unavailable — not "degraded".
    expect(s.of("error").map((e) => e.code)).toEqual(["TTS_UNAVAILABLE"]);
    expect(s.of("audio")).toEqual([]);
    expect(s.of("turn_metrics")).toHaveLength(1); // the turn completes; voice did not break it
    expect(s.of("turn_metrics")[0].metrics).toMatchObject({
      tts: "CONFIGURED",
      ttsSentencesLost: 1,
    });
  });

  it("one sentence lost on every provider: the next still plays, in order, and the answer is TTS_DEGRADED", async () => {
    const s = voice({
      fish: [{ fail: "UNAVAILABLE" }, { audio: "deux" }],
      elevenlabs: [{ fail: "UPSTREAM" }],
    });
    say(s.conn, T1, ["raconte"]);
    await flush();
    s.cognitive.responses
      .get(T1)!
      .push({ type: "FINAL_RESPONSE", text: "Première phrase perdue. Seconde phrase entendue." });
    await flush();
    await flush();
    await flush();
    expect(s.of("audio").map((a) => [a.turnId, a.generation, a.seq])).toEqual([[T1, 1, 0]]);
    expect(s.of("playback_stop")).toEqual([]); // a lost sentence never flushes the client queue
    expect(s.of("error").map((e) => e.code)).toEqual(["TTS_DEGRADED"]);
    expect(s.of("turn_metrics")[0].metrics).toMatchObject({ ttsSentencesLost: 1 });
  });

  it("hangup (transport lost) aborts synthesis", async () => {
    const s = voice({ fish: ["hang"] });
    say(s.conn, T1, ["bonjour"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "Une longue phrase. " });
    await flush();
    s.conn.close();
    expect(s.fish.calls[0].signal.aborted).toBe(true);
    expect(s.elevenlabs.calls).toHaveLength(0);
  });
});
