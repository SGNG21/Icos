import { describe, expect, it } from "vitest";

import { DEFAULT_RETENTION, type ServerMessage } from "@/core/voice/contracts";

import { SimulatedCognitiveRuntime, SimulatedStt, SimulatedTts } from "./simulated-providers";
import { VoiceSessionRegistry, type VoiceConnection } from "./voice-session";

const flush = () => new Promise((resolve) => setImmediate(resolve));

const frame = (turnId: string, seq: number, word: string) => ({
  type: "audio",
  turnId,
  seq,
  encoding: "pcm16",
  sampleRate: 16_000,
  data: Buffer.from(word).toString("base64"),
});
const signal = (turnId: string, s: string) => ({ type: "turn", turnId, signal: s });

function setup(options: { tts?: boolean; turnMode?: "push_to_talk" | "auto_vad" } = {}) {
  let clock = 1_000;
  let ids = 0;
  const stt = new SimulatedStt();
  const tts = new SimulatedTts();
  const cognitive = new SimulatedCognitiveRuntime();
  const registry = new VoiceSessionRegistry({
    stt,
    ...(options.tts === false ? {} : { tts }),
    cognitive,
    now: () => clock,
    newId: () => `session-${++ids}`,
    idleTtlMs: 10_000,
  });
  const client = (userId = "user-1") => {
    const out: ServerMessage[] = [];
    const conn = registry.connect(userId, (m) => out.push(m));
    return {
      conn,
      out,
      of: <T extends ServerMessage["type"]>(t: T) =>
        out.filter((m) => m.type === t) as Extract<ServerMessage, { type: T }>[],
    };
  };
  const c = client();
  c.conn.receive({
    type: "hello",
    device: "browser",
    turnMode: options.turnMode ?? "push_to_talk",
  });
  return { stt, tts, cognitive, registry, client, ...c, advance: (ms: number) => (clock += ms) };
}

/** Push-to-talk utterance: press, frames, release. */
function say(conn: VoiceConnection, turnId: string, words: string[], firstSeq = 0) {
  conn.receive(signal(turnId, "VOICE_ACTIVITY_START"));
  words.forEach((w, i) => conn.receive(frame(turnId, firstSeq + i, w)));
  conn.receive(signal(turnId, "VOICE_ACTIVITY_END"));
  conn.receive(signal(turnId, "TURN_COMMIT"));
}

const T1 = "turn-0001";
const T2 = "turn-0002";

describe("voice session (SIMULATED providers)", () => {
  it("1. streams partial transcripts in order, then one final", () => {
    const s = setup();
    say(s.conn, T1, ["ouvre", "la", "mission"]);
    const transcripts = s.of("transcript");
    expect(transcripts.map((t) => [t.rev, t.final, t.text])).toEqual([
      [1, false, "ouvre"],
      [2, false, "ouvre la"],
      [3, false, "ouvre la mission"],
      [4, true, "ouvre la mission"],
    ]);
  });

  it("2. a final transcript commits exactly once", async () => {
    const s = setup();
    say(s.conn, T1, ["bonjour"]);
    s.conn.receive(signal(T1, "TURN_COMMIT"));
    s.stt.onEvent?.({ type: "final", text: "bonjour encore" }); // provider emits a second final
    await flush();
    expect(s.cognitive.conversations.get("conv-1")).toHaveLength(1);
    expect(s.of("turn_accepted")).toHaveLength(1);
    expect(s.of("transcript").filter((t) => t.final)).toHaveLength(1);
  });

  it("2b. auto VAD commits on voice-activity end without an explicit commit", async () => {
    const s = setup({ turnMode: "auto_vad" });
    s.conn.receive(signal(T1, "VOICE_ACTIVITY_START"));
    s.conn.receive(frame(T1, 0, "statut"));
    s.conn.receive(signal(T1, "VOICE_ACTIVITY_END"));
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T1]);
  });

  it("3. a duplicated audio frame does not duplicate speech or the turn", async () => {
    const s = setup();
    s.conn.receive(signal(T1, "VOICE_ACTIVITY_START"));
    s.conn.receive(frame(T1, 0, "hello"));
    s.conn.receive(frame(T1, 0, "hello"));
    s.conn.receive(frame(T1, 1, "world"));
    s.conn.receive(frame(T1, 1, "world"));
    s.conn.receive(signal(T1, "TURN_COMMIT"));
    await flush();
    expect(s.cognitive.conversations.get("conv-1")?.map((t) => t.text)).toEqual(["hello world"]);
    expect(s.stt.opened).toBe(1);
  });

  it("4. barge-in stops playback, interrupts the response and lets a new turn commit", async () => {
    const s = setup();
    say(s.conn, T1, ["raconte"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "Il était une fois" });
    await flush();
    s.tts.flush();
    expect(s.of("audio").map((a) => a.turnId)).toEqual([T1]); // ICOS is speaking
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "un roi" });
    await flush(); // queued in TTS, not yet played

    s.conn.receive(signal(T2, "VOICE_ACTIVITY_START")); // human speaks over ICOS

    expect(s.of("playback_stop")).toEqual([
      { type: "playback_stop", turnId: T1, reason: "BARGE_IN" },
    ]);
    expect(s.tts.streams[0].cancelled).toBe(true);
    expect(s.cognitive.aborts).toEqual([{ turnId: T1, reason: "BARGE_IN" }]);

    s.conn.receive(frame(T2, 0, "stop"));
    s.conn.receive(signal(T2, "TURN_COMMIT"));
    await flush();
    const turns = s.cognitive.conversations.get("conv-1")!;
    expect(turns.map((t) => [t.turnId, t.interruptedTurnId])).toEqual([
      [T1, undefined],
      [T2, T1],
    ]);
    expect(turns[1].conversationId).toBe("conv-1"); // context preserved
  });

  it("5. cancelled TTS never resumes, and no old audio overlaps the new response", async () => {
    const s = setup();
    say(s.conn, T1, ["raconte"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "phrase un" });
    await flush();
    s.conn.receive({ type: "cancel" });
    const stopAt = s.out.length;

    // A misbehaving provider keeps emitting, and the runtime keeps streaming.
    s.tts.streams[0].emitRaw({ type: "audio", data: Buffer.from("late") });
    s.tts.streams[0].emitRaw({ type: "done" });
    s.tts.flush();
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "phrase deux" });
    await flush();
    expect(s.out.slice(stopAt)).toEqual([]);
    expect(s.cognitive.aborts).toEqual([{ turnId: T1, reason: "USER_CANCEL" }]);

    say(s.conn, T2, ["autre"]);
    await flush();
    s.cognitive.responses.get(T2)!.push({ type: "FINAL_RESPONSE", text: "ok" });
    await flush();
    s.tts.flush();
    const after = s.out.slice(stopAt);
    expect(after.filter((m) => m.type === "audio").map((m) => m.turnId)).toEqual([T2]);
  });

  it("6. reconnecting and replaying a committed turn does not duplicate it", async () => {
    const s = setup();
    say(s.conn, T1, ["note", "ceci"]);
    await flush();
    const sessionId = s.of("ready")[0].sessionId;
    s.conn.close(); // network loss

    const again = s.client();
    again.conn.receive({ type: "hello", sessionId, device: "pwa" });
    expect(again.of("ready")[0]).toMatchObject({ resumed: true, acceptedTurnIds: [T1] });
    say(again.conn, T1, ["note", "ceci"]); // client replays its unacked buffer
    await flush();
    expect(s.cognitive.conversations.get("conv-1")).toHaveLength(1);
    expect(again.of("turn_accepted")).toEqual([]);
    expect(s.stt.opened).toBe(1);
  });

  it("7. losing the voice session does not erase the durable conversation", async () => {
    const s = setup();
    say(s.conn, T1, ["premier"]);
    await flush();
    const sessionId = s.of("ready")[0].sessionId;
    s.conn.close();
    s.advance(60_000); // past the idle TTL

    const again = s.client();
    again.conn.receive({ type: "hello", sessionId, conversationId: "conv-1", device: "browser" });
    expect(again.of("error")[0]).toMatchObject({ code: "SESSION_EXPIRED" });
    expect(again.of("ready")[0]).toMatchObject({ resumed: false, conversationId: "conv-1" });
    expect(s.registry.get(sessionId)).toBeUndefined();

    say(again.conn, T2, ["second"]);
    await flush();
    expect(s.cognitive.conversations.get("conv-1")?.map((t) => t.text)).toEqual([
      "premier",
      "second",
    ]);
  });

  it("8. an STT outage is classified and loses only uncommitted audio", async () => {
    const s = setup();
    s.stt.failOnWrite = true;
    say(s.conn, T1, ["perdu"]);
    await flush();
    expect(s.of("error")).toEqual([
      expect.objectContaining({
        code: "STT_UNAVAILABLE",
        retryable: true,
        turnId: T1,
        audioLost: true,
      }),
    ]);
    expect(s.cognitive.conversations.size).toBe(0);
  });

  it("9. a TTS outage is classified and the answer continues as text", async () => {
    const s = setup();
    s.tts.failOnText = true;
    say(s.conn, T1, ["question"]);
    await flush();
    const q = s.cognitive.responses.get(T1)!;
    q.push({ type: "TEXT_DELTA", text: "début" });
    q.push({ type: "TEXT_DELTA", text: " fin" });
    q.push({ type: "FINAL_RESPONSE", text: "début fin" });
    await flush();
    expect(s.of("error")).toEqual([
      expect.objectContaining({ code: "TTS_UNAVAILABLE", turnId: T1 }),
    ]);
    expect(s.of("playback_stop")).toEqual([
      { type: "playback_stop", turnId: T1, reason: "TTS_FAILED" },
    ]);
    expect(s.of("response_delta").map((d) => d.text)).toEqual(["début", " fin"]);
    expect(s.of("response_final")).toHaveLength(1);
    expect(s.of("turn_metrics")).toHaveLength(1);
    expect(s.of("audio")).toEqual([]);
  });

  it("10. an unavailable Cognitive Runtime is explicit and the committed turn can be resent", async () => {
    const s = setup();
    s.cognitive.available = false;
    say(s.conn, T1, ["urgent"]);
    await flush();
    expect(s.of("error")).toEqual([
      expect.objectContaining({
        code: "COGNITIVE_UNAVAILABLE",
        retryable: true,
        turnId: T1,
        text: "urgent",
      }),
    ]);
    expect(s.of("turn_accepted")).toEqual([]);

    s.cognitive.available = true;
    s.conn.receive(signal(T1, "TURN_COMMIT")); // retry
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T1]);
    expect(s.cognitive.conversations.get("conv-1")?.map((t) => t.text)).toEqual(["urgent"]);
  });

  it("11. privacy defaults: raw audio is not retained anywhere in session state", async () => {
    const s = setup();
    say(s.conn, T1, ["SENTINELAUDIO"]);
    await flush();
    const session = s.registry.get(s.of("ready")[0].sessionId)!;
    const state = JSON.stringify(session.snapshot());
    expect(state).not.toContain("SENTINELAUDIO");
    expect(state).not.toContain(Buffer.from("SENTINELAUDIO").toString("base64"));
    expect(s.of("ready")[0].retention).toEqual({
      audio: "none",
      transcript: "cognitive_runtime",
      diagnostics: "metadata_only",
    });
    expect(DEFAULT_RETENTION.audio).toBe("none");
  });

  it("12. latency metrics are the observed clock deltas, flagged simulated, never invented", async () => {
    const s = setup();
    s.conn.receive(signal(T1, "VOICE_ACTIVITY_START")); // t=1000
    s.advance(20);
    s.conn.receive(frame(T1, 0, "bonjour")); // first audio + partial, t=1020
    s.advance(200);
    s.conn.receive(signal(T1, "VOICE_ACTIVITY_END")); // t=1220
    s.conn.receive(signal(T1, "TURN_COMMIT")); // final at 1220 (fake STT is instant)
    await flush();
    s.advance(150);
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "salut" }); // t=1370
    await flush();
    s.advance(40);
    s.tts.flush(); // first audio t=1410
    s.cognitive.responses.get(T1)!.push({ type: "FINAL_RESPONSE", text: "salut" });
    await flush();
    s.tts.flush();
    expect(s.of("turn_metrics").map((m) => m.metrics)).toEqual([
      {
        turnId: T1,
        simulated: true,
        firstAudioToVoiceStartMs: null, // client-side VAD: not observable server-side
        voiceStartToFirstPartialMs: 20,
        speechEndToFinalMs: 0,
        finalToFirstCognitiveEventMs: 150,
        firstCognitiveEventToFirstTtsAudioMs: 40,
        speechEndToFirstAudioMs: 190,
      },
    ]);

    const text = setup({ tts: false });
    say(text.conn, T1, ["ok"]);
    await flush();
    text.cognitive.responses.get(T1)!.push({ type: "FINAL_RESPONSE", text: "ok" });
    await flush();
    expect(text.of("turn_metrics")[0].metrics).toMatchObject({
      firstCognitiveEventToFirstTtsAudioMs: null,
      speechEndToFirstAudioMs: null,
    });
  });

  it("refuses to resume another user's session and rejects malformed or early messages", () => {
    const s = setup();
    const sessionId = s.of("ready")[0].sessionId;
    const other = s.client("user-2");
    other.conn.receive(frame(T1, 0, "x"));
    other.conn.receive({ type: "hello", sessionId, device: "browser" });
    other.conn.receive({ type: "audio", turnId: "../../etc", seq: -1 });
    expect(other.of("error").map((e) => e.code)).toEqual([
      "NOT_READY",
      "SESSION_FORBIDDEN",
      "INVALID_MESSAGE",
    ]);
    expect(other.of("ready")).toEqual([]);

    s.conn.receive({ type: "heartbeat" });
    expect(s.of("heartbeat_ack")).toHaveLength(1);
  });

  it("a replaced connection can no longer drive the resumed session", () => {
    const s = setup();
    const sessionId = s.of("ready")[0].sessionId;
    const again = s.client();
    again.conn.receive({ type: "hello", sessionId, device: "browser" });
    s.conn.receive({ type: "heartbeat" });
    expect(s.of("error").map((e) => e.code)).toEqual(["NOT_READY"]);
  });

  describe("review findings (regressions)", () => {
    it("F1. the committed turn carries the authenticated user, not a client claim", async () => {
      const s = setup();
      say(s.conn, T1, ["moi"]);
      await flush();
      expect(s.cognitive.conversations.get("conv-1")?.[0].userId).toBe("user-1");
    });

    it("F2. turns committed back-to-back stay on one conversation, in order", async () => {
      const s = setup();
      say(s.conn, T1, ["un"]);
      say(s.conn, T2, ["deux"]); // before T1 is accepted
      await flush();
      await flush();
      expect([...s.cognitive.conversations.keys()]).toEqual(["conv-1"]);
      expect(s.cognitive.conversations.get("conv-1")?.map((t) => t.turnId)).toEqual([T1, T2]);
    });

    it("F3. a throwing transport detaches the session instead of crashing the process", async () => {
      const s = setup();
      const broken = s.client();
      let calls = 0;
      const conn = s.registry.connect("user-1", (m) => {
        calls += 1;
        if (m.type === "turn_accepted") throw new Error("ws closed");
        broken.out.push(m);
      });
      conn.receive({ type: "hello", device: "browser" });
      say(conn, T1, ["x"]);
      await flush();
      const session = s.registry.get(broken.out.find((m) => m.type === "ready")!.sessionId)!;
      expect(session.snapshot().attached).toBe(false);
      expect(calls).toBeGreaterThan(0);
      expect(s.cognitive.conversations.get("conv-1")).toHaveLength(1); // the turn is safe
    });

    it("F4. a TTS stream that throws degrades to text with the right error", async () => {
      const s = setup();
      say(s.conn, T1, ["q"]);
      await flush();
      s.tts.streams.length = 0;
      const original = s.tts.start.bind(s.tts);
      s.tts.start = (o, cb) => ({
        ...original(o, cb),
        text: () => {
          throw new Error("tts crashed");
        },
      });
      const q = s.cognitive.responses.get(T1)!;
      q.push({ type: "TEXT_DELTA", text: "a" });
      q.push({ type: "TEXT_DELTA", text: "b" });
      q.push({ type: "FINAL_RESPONSE", text: "ab" });
      await flush();
      expect(s.of("error").map((e) => e.code)).toEqual(["TTS_UNAVAILABLE"]);
      expect(s.of("response_delta").map((d) => d.text)).toEqual(["a", "b"]);
      expect(s.of("response_final")).toHaveLength(1);
      expect(s.of("turn_metrics")).toHaveLength(1);
    });

    it("F5. a throwing TTS cancel still aborts the response", async () => {
      const s = setup();
      say(s.conn, T1, ["q"]);
      await flush();
      const original = s.tts.start.bind(s.tts);
      s.tts.start = (o, cb) => ({
        ...original(o, cb),
        cancel: () => {
          throw new Error("cancel crashed");
        },
      });
      s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "a" });
      await flush();
      s.conn.receive({ type: "cancel" });
      expect(s.cognitive.aborts).toEqual([{ turnId: T1, reason: "USER_CANCEL" }]);
    });

    it("F6. a superseded or empty utterance is reported, never silently dropped", () => {
      const s = setup();
      s.conn.receive(signal(T1, "VOICE_ACTIVITY_START"));
      s.conn.receive(frame(T1, 0, "a"));
      s.conn.receive(frame(T2, 0, "b")); // overlapping segment
      s.conn.receive(signal("turn-0003", "TURN_COMMIT")); // commit with no audio
      expect(s.of("error").map((e) => [e.code, e.turnId, e.audioLost])).toEqual([
        ["TURN_DROPPED", T1, true],
        ["TURN_DROPPED", T2, true],
        ["TURN_DROPPED", "turn-0003", true],
      ]);
    });

    it("F7. an attached but quiet session is not swept mid-answer", async () => {
      const s = setup();
      say(s.conn, T1, ["long"]);
      await flush();
      s.advance(600_000);
      s.client("user-2").conn.receive({ type: "hello", device: "browser" }); // triggers sweep
      expect(s.cognitive.aborts).toEqual([]);
      s.conn.receive({ type: "heartbeat" });
      expect(s.of("heartbeat_ack")).toHaveLength(1);
    });

    it("F8. turns and sessions per user are bounded", () => {
      const s = setup();
      for (let i = 0; i < 1_000; i++)
        s.conn.receive(signal(`turn-${String(i).padStart(5, "0")}`, "VOICE_ACTIVITY_START"));
      const first = s.registry.get(s.of("ready")[0].sessionId)!;
      expect(first.snapshot().turns.length).toBeLessThanOrEqual(200);

      for (let i = 0; i < 20; i++) s.client().conn.receive({ type: "hello", device: "browser" });
      const live = [...Array(30).keys()].filter((i) => s.registry.get(`session-${i}`)).length;
      expect(live).toBeLessThanOrEqual(5);
    });

    it("F11. a retried turn does not report the user's wait as system latency", async () => {
      const s = setup({ tts: false });
      s.cognitive.available = false;
      say(s.conn, T1, ["x"]);
      await flush();
      s.advance(30_000);
      s.cognitive.available = true;
      s.conn.receive(signal(T1, "TURN_COMMIT"));
      await flush();
      s.cognitive.responses.get(T1)!.push({ type: "FINAL_RESPONSE", text: "ok" });
      await flush();
      expect(s.of("turn_metrics")[0].metrics).toMatchObject({
        finalToFirstCognitiveEventMs: null,
        speechEndToFirstAudioMs: null,
      });
    });
  });
});
