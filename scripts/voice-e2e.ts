/**
 * Real voice path certification — `tsx scripts/voice-e2e.ts <base-url> <q1.wav> <q2.wav> <q3.wav>`.
 *
 * Drives a running `pnpm voice:serve` exactly like the phone client does:
 * sign in (ICOS_OWNER_EMAIL / ICOS_OWNER_PASSWORD from the environment), open
 * the voice WebSocket, stream real speech (16 kHz mono PCM16 WAV files) in
 * 100 ms frames at real-time pace, and check:
 *   1. an unauthenticated upgrade is refused;
 *   2. speech → real STT → ICOS → real TTS audio;
 *   3. barge-in: speaking during ICOS audio stops it, and a new turn commits;
 *   4. phone hang-up: the socket dies after acceptance, the answer still lands
 *      in the conversation, and the session resumes.
 * Prints timings and verdicts only — never credentials, cookies or audio.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { WebSocket } from "ws";

import type { ServerMessage } from "@/core/voice/contracts";

const [base, ...wavs] = process.argv.slice(2);
const outDir = process.env.VOICE_E2E_OUT;
const origin = new URL(base).origin;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pcm(path: string): Buffer {
  const wav = readFileSync(path);
  const fmt = wav.indexOf("fmt ");
  if (wav.toString("ascii", 0, 4) !== "RIFF" || fmt < 0 || wav.readUInt32LE(fmt + 12) !== 16_000) {
    throw new Error(`${path}: expected a 16 kHz RIFF WAV`);
  }
  const data = wav.indexOf("data");
  return wav.subarray(data + 8);
}

async function signIn(): Promise<string> {
  const response = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      email: process.env.ICOS_OWNER_EMAIL,
      password: process.env.ICOS_OWNER_PASSWORD,
    }),
  });
  const cookies = response.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (!response.ok || cookies.length === 0)
    throw new Error(`sign-in failed: HTTP ${response.status}`);
  return cookies.join("; ");
}

type Client = {
  ws: WebSocket;
  inbox: { at: number; m: ServerMessage }[];
  send: (m: object) => void;
  until: (p: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
};

function connect(cookie: string): Promise<Client> {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/voice/ws`, {
    headers: { cookie, origin },
  });
  const inbox: Client["inbox"] = [];
  ws.on("message", (data) =>
    inbox.push({ at: Date.now(), m: JSON.parse(String(data)) as ServerMessage }),
  );
  const client: Client = {
    ws,
    inbox,
    send: (m) => ws.send(JSON.stringify(m)),
    until: async (predicate, timeoutMs = 150_000) => {
      const start = Date.now();
      let seen = 0;
      while (Date.now() - start < timeoutMs) {
        for (; seen < inbox.length; seen++) if (predicate(inbox[seen].m)) return inbox[seen].m;
        await sleep(20);
      }
      throw new Error("timed out waiting for a server message");
    },
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`upgrade refused: ${res.statusCode}`)),
    );
    ws.once("error", reject);
  });
}

async function speak(c: Client, turnId: string, audio: Buffer, start = true) {
  if (start) c.send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_START" });
  const frame = 3_200; // 100 ms
  for (let seq = 0, at = 0; at < audio.length; seq++, at += frame) {
    c.send({
      type: "audio",
      turnId,
      seq,
      encoding: "pcm16",
      sampleRate: 16_000,
      data: audio.subarray(at, at + frame).toString("base64"),
    });
    await sleep(100);
  }
  c.send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_END" });
  c.send({ type: "turn", turnId, signal: "TURN_COMMIT" });
}

const of = (c: Client, type: string, turnId?: string) =>
  c.inbox.filter(
    (e) => e.m.type === type && (!turnId || ("turnId" in e.m && e.m.turnId === turnId)),
  );

async function main() {
  const report: Record<string, unknown> = {};
  const [q1, q2, q3] = wavs.map(pcm);

  // 1. unauthenticated upgrade
  report.unauthenticated = await connect("")
    .then(() => "ACCEPTED (FAIL)")
    .catch((e: Error) => e.message);

  const cookie = await signIn();
  const c = await connect(cookie);
  c.send({ type: "hello", device: "browser", turnMode: "push_to_talk", language: "fr-FR" });
  const ready = await c.until((m) => m.type === "ready");
  const sessionId = ready.type === "ready" ? ready.sessionId : "";

  // 2. speech → STT → ICOS → TTS
  const t1 = `e2e-${Date.now()}-1`;
  const spokeAt = Date.now();
  await speak(c, t1, q1);
  const endAt = Date.now();
  const final1 = await c.until((m) => m.type === "transcript" && m.turnId === t1 && m.final);
  await c.until((m) => m.type === "turn_accepted" && m.turnId === t1);
  const answer1 = await c.until((m) => m.type === "response_final" && m.turnId === t1);
  const metrics1 = await c.until((m) => m.type === "turn_metrics" && m.metrics.turnId === t1);
  const audio1 = of(c, "audio", t1);
  if (outDir && audio1[0]?.m.type === "audio") {
    writeFileSync(`${outDir}/answer1-chunk0.mp3`, Buffer.from(audio1[0].m.data, "base64"));
  }
  report.turn1 = {
    partials: of(c, "transcript", t1).length - 1,
    heard: final1.type === "transcript" ? final1.text : null,
    answer: answer1.type === "response_final" ? answer1.text.slice(0, 160) : null,
    audioChunks: audio1.length,
    audioMime: audio1[0]?.m.type === "audio" ? audio1[0].m.mime : null,
    speechSentMs: endAt - spokeAt,
    speechEndToFirstAudioWallMs: audio1[0] ? audio1[0].at - endAt : null,
    serverMetrics: metrics1.type === "turn_metrics" ? metrics1.metrics : null,
    errors: of(c, "error").map((e) => (e.m.type === "error" ? e.m.code : "")),
  };

  // 3. barge-in during ICOS audio
  const t2 = `e2e-${Date.now()}-2`;
  await speak(c, t2, q2);
  await c.until((m) => m.type === "audio" && m.turnId === t2);
  const t3 = `e2e-${Date.now()}-3`;
  c.send({ type: "turn", turnId: t3, signal: "VOICE_ACTIVITY_START" }); // human speaks over ICOS
  const stop = await c.until((m) => m.type === "playback_stop" && m.turnId === t2, 5_000);
  const stopIndex = c.inbox.findIndex((e) => e.m === stop);
  await speak(c, t3, q3, false);
  await c.until((m) => m.type === "turn_accepted" && m.turnId === t3);
  await c.until((m) => m.type === "response_final" && m.turnId === t3);
  await sleep(3_000);
  const lateT2Audio = c.inbox
    .slice(stopIndex + 1)
    .filter((e) => e.m.type === "audio" && e.m.turnId === t2);
  report.bargeIn = {
    playbackStop: stop.type === "playback_stop" ? stop.reason : null,
    t2AudioBeforeStop: of(c, "audio", t2).length - lateT2Audio.length,
    t2AudioAfterStop: lateT2Audio.length,
    t3Accepted: of(c, "turn_accepted", t3).length === 1,
    t3Audio: of(c, "audio", t3).length,
  };

  // 4. phone hang-up after acceptance
  const t4 = `e2e-${Date.now()}-4`;
  await speak(c, t4, q1);
  await c.until((m) => m.type === "turn_accepted" && m.turnId === t4);
  const heard4 = of(c, "transcript", t4).find((e) => e.m.type === "transcript" && e.m.final);
  c.ws.terminate(); // no close handshake: the phone just vanished
  const hungUpAt = Date.now();
  let landed: { role: string; content: string }[] = [];
  while (Date.now() - hungUpAt < 150_000) {
    const res = await fetch(`${base}/api/conversation`, { headers: { cookie } });
    const body = (await res.json()) as { messages: { role: string; content: string }[] };
    const heardText = heard4?.m.type === "transcript" ? heard4.m.text.trim() : "";
    const idx = body.messages.map((m) => m.content).lastIndexOf(heardText);
    landed = idx >= 0 ? body.messages.slice(idx) : [];
    if (landed.some((m) => m.role === "assistant")) break;
    await sleep(2_000);
  }
  const back = await connect(cookie);
  back.send({ type: "hello", sessionId, device: "browser" });
  const resumed = await back.until((m) => m.type === "ready");
  report.phoneHangUp = {
    answerStoredAfterHangUp: landed.some((m) => m.role === "assistant"),
    storedAfterMs: Date.now() - hungUpAt,
    resumed: resumed.type === "ready" && resumed.resumed,
    t4InAccepted: resumed.type === "ready" && resumed.acceptedTurnIds.includes(t4),
  };
  back.ws.close();

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error("E2E FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
