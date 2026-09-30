import type { ServerMessage } from "@/core/voice/contracts";

import { SimulatedCognitiveRuntime, SimulatedStt, SimulatedTts } from "./simulated-providers";
import { VoiceSessionRegistry, type VoiceConnection, type VoiceTimeouts } from "./voice-session";

/** Shared deterministic harness for voice engine tests (SIMULATED providers). */

export const flush = () => new Promise((resolve) => setImmediate(resolve));

export const frame = (turnId: string, seq: number, word: string) => ({
  type: "audio",
  turnId,
  seq,
  encoding: "pcm16",
  sampleRate: 16_000,
  data: Buffer.from(word).toString("base64"),
});
export const signal = (turnId: string, s: string) => ({ type: "turn", turnId, signal: s });

export function setup(
  options: {
    tts?: boolean;
    turnMode?: "push_to_talk" | "auto_vad";
    timeouts?: Partial<VoiceTimeouts>;
  } = {},
) {
  let clock = 1_000;
  let ids = 0;
  /** Manual timers driven by `advance`: deterministic watchdog tests. */
  const timers = new Set<{ at: number; fn: () => void }>();
  const setTimer = (fn: () => void, ms: number) => {
    const timer = { at: clock + ms, fn };
    timers.add(timer);
    return () => void timers.delete(timer);
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= clock && timers.delete(timer)) timer.fn();
    }
    return clock;
  };
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
    setTimer,
    ...(options.timeouts ? { timeouts: options.timeouts } : {}),
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
  return { stt, tts, cognitive, registry, client, ...c, advance, pendingTimers: () => timers.size };
}

/** Push-to-talk utterance: press, frames, release. */
export function say(conn: VoiceConnection, turnId: string, words: string[], firstSeq = 0) {
  conn.receive(signal(turnId, "VOICE_ACTIVITY_START"));
  words.forEach((w, i) => conn.receive(frame(turnId, firstSeq + i, w)));
  conn.receive(signal(turnId, "VOICE_ACTIVITY_END"));
  conn.receive(signal(turnId, "TURN_COMMIT"));
}
