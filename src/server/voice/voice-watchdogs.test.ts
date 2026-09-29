import { describe, expect, it } from "vitest";

import type { CognitiveEvent, CommittedTurn } from "@/core/voice/contracts";

import { flush, say, setup } from "./voice-test-harness";

const T1 = "turn-0001";
const T2 = "turn-0002";

describe("voice watchdogs: a hung dependency never blocks later turns", () => {
  it("STT stall: no final after end of speech -> STT_TIMEOUT, then the next turn works", async () => {
    const s = setup({ timeouts: { sttFinalMs: 50 } });
    const open = s.stt.open.bind(s.stt);
    let stalled = false;
    s.stt.open = (o, cb) => {
      const stream = open(o, cb);
      if (stalled) return stream;
      stalled = true;
      return { ...stream, finish: () => {} }; // the first utterance never gets a final
    };
    say(s.conn, T1, ["perdu"]);
    s.advance(49);
    expect(s.of("error")).toEqual([]);
    s.advance(1);
    expect(s.of("error")).toEqual([
      expect.objectContaining({
        code: "STT_TIMEOUT",
        turnId: T1,
        audioLost: true,
        retryable: true,
      }),
    ]);
    say(s.conn, T2, ["suivant"]);
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T2]);
  });

  it("acceptance stall: COGNITIVE_TIMEOUT with the text, queue released, resend accepted once", async () => {
    const s = setup({ timeouts: { acceptMs: 50 } });
    const submit = s.cognitive.submitTurn.bind(s.cognitive);
    const signals: AbortSignal[] = [];
    s.cognitive.submitTurn = (turn: CommittedTurn, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise(() => {}) : submit(turn, signal);
    };
    say(s.conn, T1, ["urgent"]);
    await flush();
    s.advance(50);
    await flush();
    expect(s.of("error")).toEqual([
      expect.objectContaining({
        code: "COGNITIVE_TIMEOUT",
        retryable: true,
        turnId: T1,
        text: "urgent",
      }),
    ]);
    expect(signals[0].aborted).toBe(true);
    expect(signals[0].reason).toBe("TIMEOUT");

    say(s.conn, T2, ["suivant"]); // not blocked behind the hung T1
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T2]);

    s.conn.receive({ type: "turn", turnId: T1, signal: "TURN_COMMIT" }); // resend
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T2, T1]);
    expect(s.cognitive.conversations.get("conv-1")?.map((t) => t.turnId)).toEqual([T2, T1]);
  });

  it("response stall: silence between events -> COGNITIVE_TIMEOUT, abort TIMEOUT, next turn works", async () => {
    const s = setup({ timeouts: { responseIdleMs: 100 } });
    say(s.conn, T1, ["question"]);
    await flush();
    const q = s.cognitive.responses.get(T1)!;
    for (let i = 0; i < 3; i++) {
      s.advance(90); // events inside the window keep resetting the watchdog
      q.push({ type: "TEXT_DELTA", text: `morceau ${i}` } satisfies CognitiveEvent);
      await flush();
    }
    expect(s.of("error")).toEqual([]);
    s.advance(100);
    expect(s.of("error")).toEqual([
      expect.objectContaining({ code: "COGNITIVE_TIMEOUT", retryable: false, turnId: T1 }),
    ]);
    expect(s.cognitive.aborts).toEqual([{ turnId: T1, reason: "TIMEOUT" }]);
    expect(s.of("playback_stop")).toEqual([
      { type: "playback_stop", turnId: T1, reason: "TIMEOUT" },
    ]);

    say(s.conn, T2, ["suivant"]);
    await flush();
    expect(s.of("turn_accepted").map((m) => m.turnId)).toEqual([T1, T2]);
  });

  it("TTS that finishes in time never times out, and a complete turn leaves no timer", async () => {
    const s = setup({ timeouts: { ttsTailMs: 100 } });
    say(s.conn, T1, ["question"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "FINAL_RESPONSE", text: "ok" });
    await flush();
    s.advance(50);
    s.tts.flush();
    s.advance(500);
    expect(s.of("error")).toEqual([]);
    expect(s.of("turn_metrics")).toHaveLength(1);
    expect(s.pendingTimers()).toBe(0);
  });

  it("provider-reported timeouts are classified as timeouts", async () => {
    const s = setup();
    say(s.conn, T1, ["a"]);
    await flush();
    s.cognitive.responses.get(T1)!.push({ type: "TEXT_DELTA", text: "Bonjour." });
    await flush();
    s.tts.streams[0].emitRaw({ type: "error", message: "slow", timeout: true });
    expect(s.of("error").map((e) => e.code)).toEqual(["TTS_TIMEOUT"]);

    const t = setup();
    const open = t.stt.open.bind(t.stt);
    t.stt.open = (o, cb) => {
      const stream = open(o, cb);
      return { ...stream, finish: () => cb({ type: "error", message: "slow", timeout: true }) };
    };
    say(t.conn, T1, ["b"]);
    expect(t.of("error").map((e) => e.code)).toEqual(["STT_TIMEOUT"]);
  });
});
