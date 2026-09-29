import { describe, expect, it } from "vitest";

import type { ServerMessage } from "@/core/voice/contracts";

import {
  base64ToBytes,
  bytesToBase64,
  initialVoiceState,
  mayPlay,
  reconnectDelay,
  toPcm16,
  voiceReducer,
  type VoiceAction,
  type VoiceUiState,
} from "./voice-client";

const server = (message: ServerMessage): VoiceAction => ({ type: "server", message });
const run = (actions: VoiceAction[], from: VoiceUiState = initialVoiceState) =>
  actions.reduce(voiceReducer, from);

const answering = run([
  server({
    type: "ready",
    sessionId: "s-1",
    conversationId: null,
    resumed: false,
    acceptedTurnIds: [],
    retention: { audio: "none", transcript: "cognitive_runtime", diagnostics: "metadata_only" },
  }),
  { type: "talk", turnId: "t-1" },
  server({ type: "transcript", turnId: "t-1", final: true, rev: 1, text: "statut ?" }),
  { type: "stop_talking" },
  server({ type: "turn_accepted", turnId: "t-1", conversationId: "c-1" }),
  server({ type: "response_final", turnId: "t-1", text: "Tout va bien." }),
]);

describe("voice client state", () => {
  it("tracks a turn from speech to answer", () => {
    expect(answering.link).toBe("ready");
    expect(answering.conversationId).toBe("c-1");
    expect(answering.turns).toEqual([
      {
        id: "t-1",
        you: "statut ?",
        youFinal: true,
        rev: 1,
        icos: "Tout va bien.",
        state: "answering",
      },
    ]);
    expect(mayPlay(answering, "t-1")).toBe(true);
    const done = run(
      [server({ type: "turn_metrics", metrics: { turnId: "t-1" } as never })],
      answering,
    );
    expect(done.turns[0].state).toBe("done");
  });

  it("barge-in silences the answer locally and ignores its late text", () => {
    const s = run(
      [
        { type: "talk", turnId: "t-2" },
        server({ type: "response_delta", turnId: "t-1", text: " encore" }),
      ],
      answering,
    );
    expect(mayPlay(s, "t-1")).toBe(false);
    expect(s.turns.find((t) => t.id === "t-1")).toMatchObject({
      state: "interrupted",
      icos: "Tout va bien.",
    });
    expect(s.talkingTurnId).toBe("t-2");
  });

  it("the interrupt button and a server playback_stop both silence a turn", () => {
    expect(mayPlay(run([{ type: "interrupt" }], answering), "t-1")).toBe(false);
    expect(
      mayPlay(
        run([server({ type: "playback_stop", turnId: "t-1", reason: "BARGE_IN" })], answering),
        "t-1",
      ),
    ).toBe(false);
  });

  it("ignores stale partial transcripts", () => {
    const s = run([
      server({ type: "transcript", turnId: "t-9", final: false, rev: 2, text: "ouvre la" }),
      server({ type: "transcript", turnId: "t-9", final: false, rev: 1, text: "ouvre" }),
    ]);
    expect(s.turns[0].you).toBe("ouvre la");
  });

  it("surfaces explicit provider, runtime and session errors", () => {
    const s = run([
      server({
        type: "error",
        code: "PROVIDER_NOT_CONFIGURED",
        retryable: false,
        message: "no STT",
      }),
    ]);
    expect(s.link).toBe("unavailable");
    expect(s.error).toEqual({ code: "PROVIDER_NOT_CONFIGURED", message: "no STT" });

    const failed = run([
      { type: "talk", turnId: "t-3" },
      server({
        type: "error",
        code: "COGNITIVE_UNAVAILABLE",
        retryable: true,
        turnId: "t-3",
        text: "x",
        message: "m",
      }),
    ]);
    expect(failed.turns[0].state).toBe("failed");

    const dropped = run([
      { type: "talk", turnId: "t-4" },
      server({
        type: "error",
        code: "STT_TIMEOUT",
        retryable: true,
        turnId: "t-4",
        audioLost: true,
        message: "m",
      }),
    ]);
    expect(dropped.turns[0].state).toBe("dropped");

    const expired = run(
      [server({ type: "error", code: "SESSION_EXPIRED", retryable: false, message: "m" })],
      answering,
    );
    expect(expired.sessionId).toBeNull();
  });

  it("losing the link stops talking", () => {
    const s = run(
      [
        { type: "talk", turnId: "t-5" },
        { type: "link", link: "reconnecting" },
      ],
      answering,
    );
    expect(s.talkingTurnId).toBeNull();
  });
});

describe("pcm helpers", () => {
  it("downsamples 48 kHz float audio to 16 kHz 16-bit PCM with clipping", () => {
    const input = new Float32Array(480).fill(0.5);
    input[0] = 2; // out of range
    input[1] = 2;
    input[2] = 2;
    const pcm = toPcm16(input, 48_000);
    expect(pcm).toHaveLength(160);
    expect(pcm[0]).toBe(0x7fff);
    expect(pcm[1]).toBe(Math.trunc(0.5 * 0x7fff));
    expect(toPcm16(new Float32Array(3).fill(-1), 48_000)[0]).toBe(-0x8000);
  });

  it("round-trips base64", () => {
    const bytes = new Uint8Array([0, 1, 254, 255, 128]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it("backs off reconnects up to 10 s", () => {
    expect([0, 1, 2, 10].map(reconnectDelay)).toEqual([500, 1000, 2000, 10_000]);
  });
});
