"use client";

import {
  Activity,
  ArrowUp,
  AudioLines,
  Brain,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  Info,
  LoaderCircle,
  Mic,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
  TriangleAlert,
  Users,
  WifiOff,
  X,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";

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
  type VoiceTurnView,
} from "@/features/voice/voice-client";
import {
  PHASE,
  isBlocking,
  operationalEvent,
  plainText,
  relativeTime,
  userMessage,
  voicePhase,
  type MissionCard,
  type Tone,
  type VoicePhase,
} from "@/features/voice/voice-presentation";

import styles from "./voice.module.css";

/**
 * Mobile-first voice client (decision 0061). Tap to talk, tap again to send.
 * Talking while ICOS speaks is a barge-in: local playback stops at once and
 * the server interrupts the answer. Every state shown is derived from the
 * protocol (voice-presentation.ts); nothing is simulated.
 */

const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const HEARTBEAT_MS = 15_000;

/** Same-origin static file: iOS Safari is unreliable with blob: worklet modules. */
const TAP_WORKLET_URL = "/icos-voice-tap.js";

const PHASE_ICON: Record<VoicePhase, ReactNode> = {
  CONNECTING: <LoaderCircle aria-hidden />,
  IDLE: <CircleCheck aria-hidden />,
  LISTENING: <Mic aria-hidden />,
  TRANSCRIBING: <AudioLines aria-hidden />,
  THINKING: <Brain aria-hidden />,
  SPEAKING: <AudioLines aria-hidden />,
  INTERRUPTED: <CirclePause aria-hidden />,
  RECONNECTING: <RefreshCw aria-hidden />,
  ERROR: <TriangleAlert aria-hidden />,
  OFFLINE: <WifiOff aria-hidden />,
};

const TONE_ICON: Record<Tone, ReactNode> = {
  flow: <Activity aria-hidden />,
  ok: <CircleCheck aria-hidden />,
  critical: <CircleAlert aria-hidden />,
  autonomy: <Sparkles aria-hidden />,
  warn: <TriangleAlert aria-hidden />,
  unknown: <Info aria-hidden />,
};

/** Compact mission card: renders only the fields the runtime actually sent. */
function Mission({ mission, label, tone }: { mission: MissionCard; label: string; tone: Tone }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(tick);
  }, []);
  const facts: [string, ReactNode][] = [];
  if (mission.currentStep) facts.push(["Étape", mission.currentStep]);
  if (mission.workersActive !== undefined) {
    facts.push([
      "Workers",
      <span key="w" className={styles.status}>
        <Users aria-hidden /> {mission.workersActive} actif{mission.workersActive > 1 ? "s" : ""}
      </span>,
    ]);
  }
  if (mission.startedAt) {
    facts.push([
      "Démarrée",
      <span key="s" className={styles.status}>
        <Clock aria-hidden /> {relativeTime(mission.startedAt, now)}
      </span>,
    ]);
  }
  if (mission.resultAvailable !== undefined) {
    facts.push(["Résultat", mission.resultAvailable ? "Disponible" : "Pas encore"]);
  }
  return (
    <section className={styles.mission} aria-label={`Mission : ${mission.title}`}>
      <div className={styles.missionHead}>
        <h3 className={styles.missionTitle}>{mission.title}</h3>
        <span className={styles.chip} data-tone={tone}>
          {TONE_ICON[tone]}
          {label}
        </span>
      </div>
      {mission.progress !== undefined && (
        <div
          className={styles.progress}
          role="progressbar"
          aria-label="Avancement"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(mission.progress)}
        >
          <span style={{ width: `${mission.progress}%` }} />
        </div>
      )}
      {facts.length > 0 && (
        <dl className={styles.facts}>
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {mission.needsAttention && (
        <p className={`${styles.chip} ${styles.attention}`} data-tone="warn">
          <ShieldAlert aria-hidden />
          Votre attention est requise
        </p>
      )}
    </section>
  );
}

const TURN_STATUS: Partial<Record<VoiceTurnView["state"], { label: string; tone: Tone }>> = {
  interrupted: { label: "Interrompu", tone: "warn" },
  dropped: { label: "Non retenu", tone: "critical" },
  failed: { label: "Non transmis", tone: "critical" },
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
        code: window.isSecureContext ? "MICROPHONE" : "INSECURE_CONTEXT",
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

  const cancelTalking = () => {
    talkingTurn.current = null;
    const c = capture.current;
    if (c) {
      c.source.disconnect();
      c.stream.getTracks().forEach((track) => track.stop());
    }
    capture.current = null;
    dispatch({ type: "stop_talking" });
    send({ type: "cancel" }); // the server drops the uncommitted utterance
  };

  const phase = voicePhase(state, speaking);
  const meta = PHASE[phase];
  const talking = state.talkingTurnId !== null;
  const canTalk = state.link === "ready";
  const canInterrupt = speaking || !!activeTurn(state);
  const [diagnostics, setDiagnostics] = useState(false);
  const blocking = state.error && isBlocking(state.error.code) ? state.error : null;
  const hint = phase === "ERROR" && state.error ? userMessage(state.error.code) : meta.hint || " ";

  const micLabel = talking
    ? "Envoyer le message"
    : phase === "SPEAKING"
      ? "Interrompre ICOS et parler"
      : "Parler à ICOS";

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden="true">
            I
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>ICOS</span>
            <span className={styles.brandSub}>
              {state.conversationId ? "Conversation en cours" : "Nouvelle conversation"}
            </span>
          </span>
        </div>
        <span className={styles.chip} data-tone={meta.tone} role="status" aria-live="polite">
          {PHASE_ICON[phase]}
          {meta.label}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => setDiagnostics((d) => !d)}
          aria-expanded={diagnostics}
          aria-controls="voice-diagnostics"
          aria-label="Diagnostics techniques"
        >
          <Info aria-hidden />
        </button>
      </header>

      <div className={styles.feed} aria-label="Conversation avec ICOS" role="log">
        {blocking && (
          <p className={styles.banner} data-tone="critical" role="alert">
            <ShieldAlert aria-hidden />
            <span>{userMessage(blocking.code)}</span>
          </p>
        )}
        {state.turns.length === 0 && !blocking && (
          <div className={styles.empty}>
            <span className={styles.emptyGlyph} aria-hidden="true">
              <Sparkles />
            </span>
            <p className={styles.emptyTitle}>Parlez à ICOS</p>
            <p className={styles.emptyText}>
              Touchez le micro, parlez, puis touchez à nouveau pour envoyer. Vous pouvez interrompre
              ICOS à tout moment.
            </p>
          </div>
        )}
        {state.turns.map((turn) => {
          const status = TURN_STATUS[turn.state];
          const events = turn.events.map(operationalEvent).filter((e) => e !== null);
          return (
            <article key={turn.id} className={styles.turn}>
              {turn.you && (
                <p className={`${styles.bubble} ${styles.user}`} data-partial={!turn.youFinal}>
                  <span className={styles.srOnly}>Vous : </span>
                  {turn.you}
                  {!turn.youFinal && <span className={styles.dots} aria-hidden="true" />}
                </p>
              )}
              {!turn.you && turn.id === state.talkingTurnId && (
                <p className={`${styles.bubble} ${styles.user}`} data-partial="true">
                  À l&apos;écoute
                  <span className={styles.dots} aria-hidden="true" />
                </p>
              )}
              {status && (
                <div className={`${styles.meta} ${styles.metaUser}`}>
                  <span className={styles.status} data-tone={status.tone}>
                    {TONE_ICON[status.tone]}
                    {status.label}
                  </span>
                  {turn.state === "failed" && (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => resend(turn.id)}
                    >
                      Renvoyer
                    </button>
                  )}
                </div>
              )}
              {turn.icos && (
                <p className={`${styles.bubble} ${styles.icos}`}>
                  <span className={styles.who}>ICOS</span>
                  {plainText(turn.icos)}
                </p>
              )}
              {events.map((event, i) =>
                event.kind === "mission" ? (
                  <Mission key={i} mission={event.mission} label={event.label} tone={event.tone} />
                ) : (
                  <p key={i} className={styles.event} data-tone={event.tone}>
                    {TONE_ICON[event.tone]}
                    {event.label}
                  </p>
                ),
              )}
            </article>
          );
        })}
        <div ref={turnsEnd} />
      </div>

      <footer className={styles.dock} data-tone={meta.tone}>
        <div className={styles.phase} aria-live="polite">
          <span className={styles.phaseLabel}>
            {PHASE_ICON[phase]}
            {meta.label}
          </span>
          <span className={styles.phaseHint}>{hint}</span>
        </div>
        <div className={styles.side}>
          <button
            type="button"
            className={styles.secondary}
            onClick={interrupt}
            disabled={!canInterrupt}
            aria-label="Interrompre la réponse d'ICOS"
          >
            <Square aria-hidden />
            Stop
          </button>
        </div>
        <button
          type="button"
          className={styles.mic}
          data-phase={phase}
          disabled={!canTalk}
          onClick={talking ? stopTalking : startTalking}
          aria-pressed={talking}
          aria-label={micLabel}
        >
          {talking ? (
            <ArrowUp aria-hidden />
          ) : phase === "SPEAKING" ? (
            <span className={styles.bars} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
          ) : (
            <Mic aria-hidden />
          )}
        </button>
        <div className={`${styles.side} ${styles.sideEnd}`}>
          <button
            type="button"
            className={styles.secondary}
            onClick={cancelTalking}
            disabled={!talking}
            aria-label="Annuler l'enregistrement"
          >
            <X aria-hidden />
            Annuler
          </button>
        </div>
      </footer>

      {diagnostics && (
        <section
          id="voice-diagnostics"
          className={styles.diagnostics}
          aria-label="Diagnostics techniques"
        >
          <div className={styles.missionHead}>
            <h2>Diagnostics</h2>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setDiagnostics(false)}
              aria-label="Fermer les diagnostics"
            >
              <X aria-hidden />
            </button>
          </div>
          <dl>
            <dt>phase</dt>
            <dd>{phase}</dd>
            <dt>link</dt>
            <dd>{state.link}</dd>
            <dt>session</dt>
            <dd>{state.sessionId ?? "—"}</dd>
            <dt>conversation</dt>
            <dd>{state.conversationId ?? "—"}</dd>
            <dt>last error</dt>
            <dd>{state.error ? `${state.error.code} — ${state.error.message}` : "—"}</dd>
            {state.lastMetrics && (
              <>
                <dt>simulated</dt>
                <dd>{String(state.lastMetrics.simulated)}</dd>
                <dt>speech→final</dt>
                <dd>{state.lastMetrics.speechEndToFinalMs ?? "n/a"} ms</dd>
                <dt>final→ICOS</dt>
                <dd>{state.lastMetrics.finalToFirstCognitiveEventMs ?? "n/a"} ms</dd>
                <dt>speech→audio</dt>
                <dd>{state.lastMetrics.speechEndToFirstAudioMs ?? "n/a"} ms</dd>
              </>
            )}
          </dl>
          {state.error && (
            <button
              type="button"
              className={styles.textButton}
              onClick={() => dispatch({ type: "clear_error" })}
            >
              Effacer l&apos;erreur
            </button>
          )}
        </section>
      )}
    </main>
  );
}
