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
 * Mobile-first voice client (decision 0061). Tap to talk, tap again to send.
 * Talking while ICOS speaks is a barge-in: local playback stops at once and
 * the server interrupts the answer.
 */

const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const HEARTBEAT_MS = 15_000;

/** Same-origin static file: iOS Safari is unreliable with blob: worklet modules. */
const TAP_WORKLET_URL = "/icos-voice-tap.js";

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

/** Derive the high-level UI state for the central microphone button. */
type MicState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

function deriveMicState(state: VoiceUiState, speaking: boolean): MicState {
  if (state.error) return "error";
  if (state.link !== "ready") return "idle";
  const talkingTurnId = state.talkingTurnId;
  if (talkingTurnId) {
    const turn = state.turns.find((t) => t.id === talkingTurnId);
    if (turn?.youFinal) return "transcribing";
    return "listening";
  }
  if (speaking) return "speaking";
  const active = activeTurn(state);
  if (active?.state === "thinking") return "thinking";
  if (active?.state === "answering") return "speaking";
  return "idle";
}

const MIC_LABEL: Record<MicState, string> = {
  idle: "Appuyez pour parler",
  listening: "Écoute… Relâchez pour envoyer",
  transcribing: "Transcription…",
  thinking: "ICOS réfléchit…",
  speaking: "ICOS parle…",
  error: "Erreur",
};

const MIC_ARIA_LABEL: Record<MicState, string> = {
  idle: "Commencer l'enregistrement vocal",
  listening: "Arrêter l'enregistrement et envoyer",
  transcribing: "Transcription en cours",
  thinking: "ICOS est en train de réfléchir",
  speaking: "ICOS est en train de parler, appuyez pour interrompre",
  error: "Erreur de connexion vocale",
};

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
  /** Output + capture graph, created once on the first tap. */
  const audio = useRef<{ ctx: AudioContext; tap: Promise<AudioWorkletNode> } | null>(null);
  /** The utterance being captured: its mic stream lives only this long. */
  const capture = useRef<{
    turnId: string;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    pending: Float32Array[];
    buffered: number;
    seq: number;
  } | null>(null);
  /** Turns silenced locally, updated at the moment of the tap (not after a render). */
  const silenced = useRef(new Set<string>());
  const lastAudioTurn = useRef<string | null>(null);
  const talkingTurn = useRef<string | null>(null);
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
    if (!ctx || silenced.current.has(turnId)) return;
    lastAudioTurn.current = turnId;
    const p = playback.current;
    const generation = p.generation;
    const bytes = base64ToBytes(data);
    // Decode in arrival order; a stop in the meantime bumps the generation.
    p.chain = p.chain
      .then(() => ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer))
      .then((buffer) => {
        if (
          generation !== p.generation ||
          silenced.current.has(turnId) ||
          !mayPlay(stateRef.current, turnId)
        ) {
          return;
        }
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
        if (message.type === "playback_stop") {
          silenced.current.add(message.turnId);
          stopPlayback();
        }
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
        // A refused upgrade looks like any drop (1006): after a few, ask HTTP why.
        if (attempt >= 2) {
          void fetch("/api/conversation", { cache: "no-store" }).then(
            (res) => {
              if (res.status === 401) location.assign("/login?next=%2Fvoice");
              if (res.status === 403) {
                closed = true;
                clearTimeout(retry);
                dispatch({ type: "link", link: "unavailable" });
                dispatch({ type: "local_error", code: "FORBIDDEN", message: "accès voix refusé" });
              }
            },
            () => {},
          );
        }
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
      capture.current?.stream.getTracks().forEach((track) => track.stop());
      void audio.current?.ctx.close();
    };
  }, [play, send, stopPlayback]);

  // --- microphone --------------------------------------------------------------
  /** Must start synchronously inside the tap: iOS only unlocks audio there. */
  const ensureAudio = () => {
    if (!audio.current) {
      const ctx = new AudioContext();
      if (!ctx.audioWorklet) {
        void ctx.close();
        throw new Error("Ce navigateur ne permet pas la capture audio (AudioWorklet).");
      }
      const tap = ctx.audioWorklet.addModule(TAP_WORKLET_URL).then(() => {
        const node = new AudioWorkletNode(ctx, "icos-voice-tap");
        // Rendering is pulled from the destination: keep the tap in the graph, silently.
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute).connect(ctx.destination);
        node.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(ctx, event.data);
        return node;
      });
      audio.current = { ctx, tap };
    }
    void audio.current.ctx.resume();
    return audio.current;
  };

  const sendFrame = (ctx: AudioContext) => {
    const c = capture.current;
    if (!c || c.buffered === 0) return;
    const samples = new Float32Array(c.buffered);
    let at = 0;
    for (const chunk of c.pending) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    c.pending = [];
    c.buffered = 0;
    const pcm = toPcm16(samples, ctx.sampleRate, SAMPLE_RATE);
    send({
      type: "audio",
      turnId: c.turnId,
      seq: c.seq++,
      encoding: "pcm16",
      sampleRate: SAMPLE_RATE,
      data: bytesToBase64(new Uint8Array(pcm.buffer)),
    });
  };

  const onSamples = (ctx: AudioContext, samples: Float32Array) => {
    const c = capture.current;
    if (!c) return;
    c.pending.push(samples);
    c.buffered += samples.length;
    if (c.buffered >= (ctx.sampleRate * FRAME_MS) / 1000) sendFrame(ctx);
  };

  /** Silence whatever ICOS is saying, locally and at once. */
  const silenceCurrent = () => {
    const active = activeTurn(stateRef.current)?.id ?? lastAudioTurn.current;
    if (active) silenced.current.add(active);
    stopPlayback();
  };

  const startTalking = async () => {
    try {
      const { ctx, tap } = ensureAudio(); // synchronous part of the tap
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Micro indisponible : ouvrez ICOS en HTTPS (origine sécurisée).");
      }
      const turnId = newTurnId();
      silenceCurrent(); // barge-in
      talkingTurn.current = turnId;
      dispatch({ type: "talk", turnId });
      send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_START" });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (talkingTurn.current !== turnId) {
        stream.getTracks().forEach((track) => track.stop()); // sent before the mic opened
        return;
      }
      const source = ctx.createMediaStreamSource(stream);
      source.connect(await tap);
      capture.current = { turnId, stream, source, pending: [], buffered: 0, seq: 0 };
    } catch (error) {
      talkingTurn.current = null;
      dispatch({ type: "stop_talking" });
      dispatch({
        type: "local_error",
        code: "MICROPHONE",
        message: error instanceof Error ? error.message : "micro refusé",
      });
    }
  };

  const stopTalking = () => {
    const turnId = talkingTurn.current;
    talkingTurn.current = null;
    const c = capture.current;
    if (c && audio.current) sendFrame(audio.current.ctx); // don't clip the last word
    if (c) {
      c.source.disconnect();
      c.stream.getTracks().forEach((track) => track.stop()); // mic indicator off
    }
    capture.current = null;
    dispatch({ type: "stop_talking" });
    if (!turnId) return;
    send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_END" });
    send({ type: "turn", turnId, signal: "TURN_COMMIT" });
  };

  const resend = (turnId: string) => send({ type: "turn", turnId, signal: "TURN_COMMIT" });

  const interrupt = () => {
    silenceCurrent();
    dispatch({ type: "interrupt" });
    send({ type: "interrupt" });
  };

  const talking = state.talkingTurnId !== null;
  const busy = activeTurn(state);
  const canTalk = state.link === "ready";
  const micState = deriveMicState(state, speaking);

  // Render helpers
  const renderTranscript = () => {
    if (state.turns.length === 0) {
      return (
        <p className={styles.hint} aria-live="polite">
          Appuyez sur le micro, parlez, puis relâchez pour envoyer.
        </p>
      );
    }
    return state.turns.map((turn) => (
      <article key={turn.id} className={styles.turn}>
        {turn.you && (
          <p className={styles.you} data-final={turn.youFinal} aria-label="Vous">
            {turn.you}
          </p>
        )}
        {turn.icos && (
          <p className={styles.icos} aria-label="ICOS">
            {plain(turn.icos)}
          </p>
        )}
        {TURN_LABEL[turn.state] && (
          <span className={styles.badge} data-state={turn.state} aria-label={`État : ${TURN_LABEL[turn.state]}`}>
            {TURN_LABEL[turn.state]}
          </span>
        )}
        {turn.state === "failed" && (
          <button
            type="button"
            className={styles.resend}
            onClick={() => resend(turn.id)}
            aria-label="Renvoyer ce message"
          >
            Renvoyer
          </button>
        )}
      </article>
    ));
  };

  const renderMissionCard = () => {
    // Future: Cognitive/CORE3 data will populate this
    // Show connection state and session info for now
    if (state.link === "connecting" || state.link === "reconnecting") {
      return (
        <div className={styles.missionCard} aria-live="polite">
          <div className={styles.missionCardHeader}>
            <span className={styles.missionCardTitle}>Session vocale</span>
            <span className={`${styles.missionCardStatus} ${styles[`status-${state.link}`]}`}>
              {LINK_LABEL[state.link]}
            </span>
          </div>
          <p className={styles.missionCardSubtitle}>
            Connexion au runtime cognitif en cours…
          </p>
        </div>
      );
    }
    if (state.link === "ready" && state.sessionId) {
      return (
        <div className={styles.missionCard} aria-live="polite">
          <div className={styles.missionCardHeader}>
            <span className={styles.missionCardTitle}>Session active</span>
            <span className={`${styles.missionCardStatus} ${styles["status-ready"]}`}>
              {LINK_LABEL.ready}
            </span>
          </div>
          <p className={styles.missionCardSubtitle}>
            Session: <code>{state.sessionId.slice(0, 8)}…</code>
            {state.conversationId && (
              <>
                {" | "}
                Conversation: <code>{state.conversationId.slice(0, 8)}…</code>
              </>
            )}
          </p>
        </div>
      );
    }
    if (state.link === "offline" || state.link === "unavailable") {
      return (
        <div className={styles.missionCard} aria-live="polite">
          <div className={styles.missionCardHeader}>
            <span className={styles.missionCardTitle}>Voix indisponible</span>
            <span className={`${styles.missionCardStatus} ${styles[`status-${state.link}`]}`}>
              {LINK_LABEL[state.link]}
            </span>
          </div>
          <p className={styles.missionCardSubtitle}>
            {state.link === "offline"
              ? "Vous êtes hors ligne. La voix nécessite une connexion internet."
              : "Le service vocal n'est pas configuré sur ce serveur."}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <main className={styles.page} role="main">
      <header className={styles.header}>
        <h1 className={styles.title}>ICOS</h1>
        <div className={styles.headerRight}>
          <span
            className={styles.link}
            data-link={state.link}
            role="status"
            aria-live="polite"
            aria-label={`État de connexion : ${LINK_LABEL[state.link]}`}
          >
            {LINK_LABEL[state.link]}
          </span>
        </div>
      </header>

      {renderMissionCard()}

      <section className={styles.turns} aria-live="polite" aria-label="Historique de la conversation">
        {renderTranscript()}
        <div ref={turnsEnd} />
      </section>

      {state.error && (
        <div className={styles.errorBanner} role="alert" aria-live="assertive">
          <strong>{state.error.code}</strong> — {state.error.message}
          {state.error.code === "MICROPHONE" && (
            <button
              type="button"
              className={styles.errorAction}
              onClick={() => dispatch({ type: "local_error", code: "", message: "" })}
              aria-label="Fermer l'erreur"
            >
              Fermer
            </button>
          )}
        </div>
      )}

      <footer className={styles.controls}>
        <button
          type="button"
          className={styles.interrupt}
          onClick={interrupt}
          disabled={!speaking && !busy}
          aria-label="Interrompre ICOS"
          aria-pressed={speaking || !!busy}
        >
          <svg className={styles.stopIcon} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          <span className={styles.interruptLabel}>Stop</span>
        </button>
        <button
          type="button"
          className={`${styles.mic} ${styles[`mic-${micState}`]}`}
          data-state={micState}
          disabled={!canTalk}
          onClick={talking ? stopTalking : startTalking}
          aria-pressed={talking}
          aria-label={MIC_ARIA_LABEL[micState]}
          aria-describedby="mic-hint"
        >
          <svg className={styles.micIcon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
          <span className={styles.micLabel}>{MIC_LABEL[micState]}</span>
        </button>
      </footer>
      <p id="mic-hint" className={styles.srOnly}>
        {micState === "idle" && "Appuyez pour commencer à parler"}
        {micState === "listening" && "Relâchez pour envoyer votre message"}
        {micState === "transcribing" && "Votre message est en cours de transcription"}
        {micState === "thinking" && "ICOS prépare sa réponse"}
        {micState === "speaking" && "ICOS parle, appuyez pour l'interrompre"}
        {micState === "error" && "Une erreur est survenue, réessayez"}
      </p>
    </main>
  );
}