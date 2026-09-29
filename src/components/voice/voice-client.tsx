"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import type { ServerMessage } from "@/core/voice/contracts";
import {
  activeTurn,
  base64ToBytes,
  bytesToBase64,
  initialVoiceState,
  mayPlay,
  newTurnId,
  reconnectDelay,
  toPcm16,
  voiceReducer,
  type VoiceUiState,
} from "@/features/voice/voice-client";

import styles from "./voice-client.module.css";

/**
 * Mobile-first voice client (decision 0056). Tap to talk, tap again to send.
 * Talking while ICOS speaks is a barge-in: local playback stops at once and
 * the server interrupts the answer.
 */

const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const HEARTBEAT_MS = 15_000;

// Copies each 128-sample render quantum to the main thread.
const TAP_WORKLET = `
class IcosVoiceTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor("icos-voice-tap", IcosVoiceTap);
`;

const LINK_LABEL: Record<VoiceUiState["link"], string> = {
  connecting: "Connexion…",
  ready: "Connecté",
  reconnecting: "Reconnexion…",
  offline: "Hors ligne",
  unavailable: "Voix indisponible",
};

const TURN_LABEL: Record<string, string> = {
  listening: "écoute",
  thinking: "réflexion",
  answering: "réponse",
  done: "",
  interrupted: "interrompu",
  dropped: "non retenu",
  failed: "non transmis",
};

/** Answers are plain text on a phone: drop markdown emphasis markers. */
const plain = (text: string) => text.replace(/\*\*|__|`/g, "");

export function VoiceClient() {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const ws = useRef<WebSocket | null>(null);
  const session = useRef<{ sessionId: string | null; conversationId: string | null }>({
    sessionId: null,
    conversationId: null,
  });
  const audio = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    tap: AudioWorkletNode;
    pending: Float32Array[];
    seq: number;
  } | null>(null);
  const playback = useRef({
    sources: new Set<AudioBufferSourceNode>(),
    nextAt: 0,
    chain: Promise.resolve(),
    generation: 0,
  });
  const [speaking, setSpeaking] = useState(false);
  const turnsEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    turnsEnd.current?.scrollIntoView({ block: "end" });
  }, [state.turns]);

  const send = useCallback((message: object) => {
    const socket = ws.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /** Stop every scheduled/playing chunk and drop anything still decoding. */
  const stopPlayback = useCallback(() => {
    const p = playback.current;
    p.generation += 1;
    for (const source of p.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
    }
    p.sources.clear();
    p.nextAt = 0;
    setSpeaking(false);
  }, []);

  const play = useCallback((turnId: string, data: string) => {
    const ctx = audio.current?.ctx;
    if (!ctx) return;
    const p = playback.current;
    const generation = p.generation;
    const bytes = base64ToBytes(data);
    // Decode in arrival order; a stop in the meantime bumps the generation.
    p.chain = p.chain
      .then(() => ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer))
      .then((buffer) => {
        if (generation !== p.generation || !mayPlay(stateRef.current, turnId)) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        const at = Math.max(ctx.currentTime, p.nextAt);
        source.start(at);
        p.nextAt = at + buffer.duration;
        p.sources.add(source);
        setSpeaking(true);
        source.onended = () => {
          p.sources.delete(source);
          if (p.sources.size === 0) setSpeaking(false);
        };
      })
      .catch(() => {
        dispatch({
          type: "local_error",
          code: "PLAYBACK",
          message: "un extrait audio n'a pas pu être lu",
        });
      });
  }, []);

  // --- transport --------------------------------------------------------------
  useEffect(() => {
    let attempt = 0;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${location.host}/api/voice/ws`);
      ws.current = socket;
      socket.onopen = () => {
        const standalone = window.matchMedia?.("(display-mode: standalone)").matches;
        socket.send(
          JSON.stringify({
            type: "hello",
            device: standalone ? "pwa" : "browser",
            turnMode: "push_to_talk",
            language: navigator.language || "fr-FR",
            ...(session.current.sessionId ? { sessionId: session.current.sessionId } : {}),
            ...(session.current.conversationId
              ? { conversationId: session.current.conversationId }
              : {}),
          }),
        );
        beat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_MS);
      };
      socket.onmessage = (event) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(String(event.data)) as ServerMessage;
        } catch {
          return;
        }
        if (message.type === "ready") {
          attempt = 0;
          session.current = {
            sessionId: message.sessionId,
            conversationId: message.conversationId,
          };
        }
        if (message.type === "turn_accepted")
          session.current.conversationId = message.conversationId;
        if (message.type === "playback_stop") stopPlayback();
        if (message.type === "audio") play(message.turnId, message.data);
        dispatch({ type: "server", message });
      };
      socket.onclose = (event) => {
        clearInterval(beat);
        if (ws.current === socket) ws.current = null;
        stopPlayback();
        if (closed) return;
        if (event.code === 1011 && event.reason === "PROVIDER_NOT_CONFIGURED") {
          return dispatch({ type: "link", link: "unavailable" });
        }
        dispatch({ type: "link", link: "reconnecting" });
        retry = setTimeout(connect, reconnectDelay(attempt++));
      };
    };

    const onOffline = () => dispatch({ type: "link", link: "offline" });
    const onOnline = () => {
      if (!ws.current) {
        clearTimeout(retry);
        connect();
      }
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(beat);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      ws.current?.close();
      audio.current?.stream.getTracks().forEach((track) => track.stop());
      void audio.current?.ctx.close();
    };
  }, [play, send, stopPlayback]);

  // --- microphone --------------------------------------------------------------
  const ensureAudio = async () => {
    if (audio.current) {
      if (audio.current.ctx.state !== "running") await audio.current.ctx.resume();
      return audio.current;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Micro indisponible : ouvrez ICOS en HTTPS (origine sécurisée).");
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = new AudioContext();
    if (!ctx.audioWorklet)
      throw new Error("Ce navigateur ne permet pas la capture audio (AudioWorklet).");
    const url = URL.createObjectURL(new Blob([TAP_WORKLET], { type: "application/javascript" }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    const tap = new AudioWorkletNode(ctx, "icos-voice-tap");
    ctx.createMediaStreamSource(stream).connect(tap);
    const mic = { ctx, stream, tap, pending: [] as Float32Array[], seq: 0 };
    let buffered = 0;
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const turnId = stateRef.current.talkingTurnId;
      if (!turnId) return;
      mic.pending.push(event.data);
      buffered += event.data.length;
      if (buffered < (ctx.sampleRate * FRAME_MS) / 1000) return;
      const samples = new Float32Array(buffered);
      let at = 0;
      for (const chunk of mic.pending) {
        samples.set(chunk, at);
        at += chunk.length;
      }
      mic.pending = [];
      buffered = 0;
      const pcm = toPcm16(samples, ctx.sampleRate, SAMPLE_RATE);
      send({
        type: "audio",
        turnId,
        seq: mic.seq++,
        encoding: "pcm16",
        sampleRate: SAMPLE_RATE,
        data: bytesToBase64(new Uint8Array(pcm.buffer)),
      });
    };
    audio.current = mic;
    return mic;
  };

  const startTalking = async () => {
    try {
      const mic = await ensureAudio(); // on the tap: unlocks audio on iOS
      const turnId = newTurnId();
      mic.seq = 0;
      mic.pending = [];
      stopPlayback(); // barge-in: silence ICOS locally, immediately
      dispatch({ type: "talk", turnId });
      send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_START" });
    } catch (error) {
      dispatch({
        type: "local_error",
        code: "MICROPHONE",
        message: error instanceof Error ? error.message : "micro refusé",
      });
    }
  };

  const stopTalking = () => {
    const turnId = stateRef.current.talkingTurnId;
    if (!turnId) return;
    dispatch({ type: "stop_talking" });
    send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_END" });
    send({ type: "turn", turnId, signal: "TURN_COMMIT" });
  };

  const interrupt = () => {
    stopPlayback();
    dispatch({ type: "interrupt" });
    send({ type: "interrupt" });
  };

  const talking = state.talkingTurnId !== null;
  const busy = activeTurn(state);
  const canTalk = state.link === "ready";

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>ICOS</h1>
        <span className={styles.link} data-link={state.link} role="status" aria-live="polite">
          {LINK_LABEL[state.link]}
        </span>
      </header>

      <section className={styles.turns} aria-live="polite">
        {state.turns.length === 0 && (
          <p className={styles.hint}>
            Touchez le micro, parlez, puis touchez à nouveau pour envoyer.
          </p>
        )}
        {state.turns.map((turn) => (
          <article key={turn.id} className={styles.turn}>
            {turn.you && (
              <p className={styles.you} data-final={turn.youFinal}>
                {turn.you}
              </p>
            )}
            {turn.icos && <p className={styles.icos}>{plain(turn.icos)}</p>}
            {TURN_LABEL[turn.state] && (
              <span className={styles.badge}>{TURN_LABEL[turn.state]}</span>
            )}
          </article>
        ))}
        <div ref={turnsEnd} />
      </section>

      {state.error && (
        <p className={styles.error} role="alert">
          <strong>{state.error.code}</strong> — {state.error.message}
        </p>
      )}

      <footer className={styles.controls}>
        <button
          type="button"
          className={styles.interrupt}
          onClick={interrupt}
          disabled={!speaking && !busy}
          aria-label="Interrompre ICOS"
        >
          Stop
        </button>
        <button
          type="button"
          className={styles.mic}
          data-talking={talking}
          data-speaking={speaking}
          disabled={!canTalk}
          onClick={talking ? stopTalking : startTalking}
          aria-pressed={talking}
          aria-label={talking ? "Envoyer" : "Parler"}
        >
          {talking ? "Envoyer" : speaking ? "Parler (interrompt)" : "Parler"}
        </button>
      </footer>
    </main>
  );
}
