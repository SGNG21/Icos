"use client";

import {
  Activity,
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
  decisionOutcome,
  isBlocking,
  latestMissionEvents,
  operationalEvent,
  plainText,
  proposalCards,
  relativeTime,
  userMessage,
  type MissionCard,
  type ProposalCard,
  type Tone,
  type VoicePhase,
} from "@/features/voice/voice-presentation";

import { createVad } from "@/features/voice/vad";
import {
  initialSessionState,
  inactivityExpired,
  micIsCapturing,
  reduceVoiceSession,
  voicePhase,
  type VoiceSessionEvent,
} from "@/features/voice/voice-session-machine";
import { NO_WAKE_WORD_DETECTOR, wakeWordStatus } from "@/features/voice/wake-word";

import styles from "./voice.module.css";

/**
 * CLIENT VOCAL CONTINU, PENSÉ POUR LE TÉLÉPHONE (P0-P).
 *
 * UN SEUL BOUTON. Un appui ouvre la session : le micro s'ouvre UNE fois et reste ouvert.
 * À partir de là, c'est le VAD LOCAL (`features/voice/vad.ts`) qui découpe les tours, donc
 * on parle, ICOS répond, et l'écoute reprend TOUTE SEULE. Un second appui ferme tout.
 *
 * AVANT : le micro s'ouvrait et se fermait à chaque tour, il fallait donc recliquer entre
 * chaque phrase — l'inverse de ce qu'on attend d'un assistant vocal.
 *
 * BARGE-IN : parler pendant qu'ICOS parle coupe la lecture LOCALEMENT, tout de suite, et
 * interrompt la réponse côté serveur. On n'attend jamais qu'il ait fini.
 *
 * CE QUE CE COMPOSANT NE DÉCIDE PAS. La phase affichée vient de
 * `voice-session-machine.ts`, qui est pure et testée : `LISTENING` n'est retournable que si
 * le micro est RÉELLEMENT ouvert et le transport RÉELLEMENT prêt. Ce fichier ne fait que
 * rapporter des faits (micro ouvert, lien prêt, audio en lecture) — il ne peut pas afficher
 * une écoute qui n'a pas lieu.
 */

/**
 * L'horloge, hors du composant. Ces appels viennent du tap audio, jamais d'un rendu, mais
 * une fonction déclarée dans le corps du composant est traitée comme du rendu par la règle
 * de pureté — et elle a raison de ne pas pouvoir faire la différence.
 */
const nowMs = () => Date.now();

const SAMPLE_RATE = 16_000;
const FRAME_MS = 100;
const HEARTBEAT_MS = 15_000;

/** Same-origin static file: iOS Safari is unreliable with blob: worklet modules. */
const TAP_WORKLET_URL = "/icos-voice-tap.js";

const PHASE_ICON: Record<VoicePhase, ReactNode> = {
  OFF: <Mic aria-hidden />,
  CONNECTING: <LoaderCircle aria-hidden />,
  LISTENING: <Mic aria-hidden />,
  USER_SPEAKING: <AudioLines aria-hidden />,
  THINKING: <Brain aria-hidden />,
  ICOS_SPEAKING: <AudioLines aria-hidden />,
  INTERRUPTED: <CirclePause aria-hidden />,
  RECONNECTING: <RefreshCw aria-hidden />,
  DEGRADED: <WifiOff aria-hidden />,
  ERROR: <TriangleAlert aria-hidden />,
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

/**
 * A durable proposal (decision 0056): what ICOS wants to do, its real status, and
 * — once launched — the CORE3 mission id. Approve/Reject are the ONLY way a spoken
 * request becomes a running mission; the voice layer never launches anything itself.
 */
function Proposal({
  card,
  busy,
  onDecide,
}: {
  card: ProposalCard;
  busy: boolean;
  onDecide: (decision: "approve" | "reject") => void;
}) {
  return (
    <section
      className={styles.mission}
      aria-label={`${card.kind === "goal_proposal" ? "Mission" : "Action"} : ${card.title}`}
    >
      <div className={styles.missionHead}>
        <h3 className={styles.missionTitle}>{card.title}</h3>
        <span className={styles.chip} data-tone={card.tone}>
          {TONE_ICON[card.tone]}
          {card.label}
        </span>
      </div>
      {card.detail && <p className={styles.footnote}>{card.detail}</p>}
      {(card.missionId ?? card.failureReason) && (
        <dl className={styles.facts}>
          {card.missionId && (
            <div>
              <dt>Mission</dt>
              {/* The id is the evidence: selectable, never truncated. */}
              <dd>
                <code>{card.missionId}</code>
              </dd>
            </div>
          )}
          {card.failureReason && (
            <div>
              <dt>Raison</dt>
              <dd>{card.failureReason}</dd>
            </div>
          )}
        </dl>
      )}
      {card.decidable && (
        <div className={styles.missionActions}>
          <button
            type="button"
            className={styles.textButton}
            data-variant="primary"
            disabled={busy}
            onClick={() => onDecide("approve")}
          >
            {busy ? (
              <LoaderCircle aria-hidden className={styles.spinner} />
            ) : (
              <CircleCheck aria-hidden />
            )}
            Approuver
          </button>
          <button
            type="button"
            className={styles.textButton}
            disabled={busy}
            onClick={() => onDecide("reject")}
          >
            <X aria-hidden />
            Rejeter
          </button>
        </div>
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

  /*
   * L'ÉTAT DE SESSION, séparé de l'état des TOURS. `voiceReducer` sait ce que chaque tour
   * est devenu ; celui-ci sait si le micro est ouvert et ce que la session est en train de
   * faire. C'est lui qui porte la phase affichée, parce qu'il est le seul à connaître les
   * faits dont dépend la véracité (micro réellement ouvert, transport réellement prêt).
   */
  const [session, rawSessionDispatch] = useReducer(reduceVoiceSession, initialSessionState);
  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  /*
   * Le miroir est mis à jour SYNCHRONEMENT : le tap audio tourne hors de React et lit cet
   * état des dizaines de fois par seconde. Attendre un rendu lui ferait voir un état périmé
   * et, concrètement, rater le début d'un barge-in.
   */
  const sessionDispatch = useCallback((event: VoiceSessionEvent) => {
    sessionRef.current = reduceVoiceSession(sessionRef.current, event);
    rawSessionDispatch(event);
  }, []);

  const ws = useRef<WebSocket | null>(null);
  /** Identité TRANSPORT de la session serveur (reprise après reconnexion). */
  const wire = useRef<{ sessionId: string | null; conversationId: string | null }>({
    sessionId: null,
    conversationId: null,
  });
  /** Output + capture graph, created once on the first tap. */
  const audio = useRef<{ ctx: AudioContext; tap: Promise<AudioWorkletNode> } | null>(null);
  /**
   * LE MICRO DE LA SESSION. Ouvert UNE fois à l'ouverture, fermé UNE fois à la fermeture.
   * C'est le changement central : avant, il vivait le temps d'un tour, donc chaque phrase
   * demandait un clic.
   */
  const mic = useRef<{ stream: MediaStream; source: MediaStreamAudioSourceNode } | null>(null);
  /** L'énoncé en cours. Créé par le VAD au début d'une parole, clos à la fin. */
  const turn = useRef<{
    turnId: string;
    pending: Float32Array[];
    buffered: number;
    seq: number;
  } | null>(null);
  /** Le découpage en tours, local : aucun octet ne part avant qu'une parole commence. */
  const vad = useRef(createVad());
  /** Turns silenced locally, updated at the moment of the tap (not after a render). */
  const silenced = useRef(new Set<string>());
  const lastAudioTurn = useRef<string | null>(null);
  const playback = useRef({
    sources: new Set<AudioBufferSourceNode>(),
    nextAt: 0,
    chain: Promise.resolve(),
    generation: 0,
  });
  const [speaking, setSpeaking] = useState(false);
  /*
   * Miroir synchrone de `speaking`. Le tap audio doit savoir, AU MOMENT où la première
   * syllabe arrive, si ICOS est en train de parler — c'est ce qui distingue un barge-in
   * d'un tour ordinaire. Un état React lui arriverait un rendu trop tard.
   */
  const speakingRef = useRef(false);
  /**
   * Dit à la machine de session qu'ICOS commence ou cesse de parler. La FIN est ce qui
   * ramène automatiquement à l'écoute : c'est la boucle qui rend la conversation continue.
   */
  const setIcosSpeaking = useCallback(
    (value: boolean) => {
      if (speakingRef.current === value) return;
      speakingRef.current = value;
      setSpeaking(value);
      sessionDispatch(
        value ? { type: "ICOS_AUDIO_STARTED" } : { type: "ICOS_AUDIO_ENDED", at: nowMs() },
      );
    },
    [sessionDispatch],
  );
  /** Durable proposals of this conversation; the server record, never local guesswork. */
  const [proposals, setProposals] = useState<ProposalCard[]>([]);
  const [deciding, setDeciding] = useState<string | null>(null);
  /** Guards against an out-of-order proposal refresh repainting stale state. */
  const refreshGeneration = useRef(0);
  const turnsEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    turnsEnd.current?.scrollIntoView({ block: "end" });
  }, [state.turns]);

  const send = useCallback((message: object) => {
    const socket = ws.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  /**
   * Re-read the conversation's durable proposals. This is the ONLY source of mission
   * state on the phone: `proposal.created` carries just an id and a status, and after a
   * reconnect nothing in the socket replays the proposals — so recovery is this read.
   */
  const refreshProposals = useCallback(async () => {
    const conversationId = wire.current.conversationId;
    if (!conversationId) return;
    // Several refreshes can be in flight (ready, an event, a decision). A slower
    // earlier read must never repaint over a newer one: mission status is evidence.
    const generation = ++refreshGeneration.current;
    try {
      const response = await fetch(
        `/api/cognitive/conversations/${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      // 401/403/503: show nothing rather than something invented.
      if (!response.ok) return;
      const body = (await response.json()) as { proposals?: unknown };
      if (generation !== refreshGeneration.current) return;
      setProposals(proposalCards(body.proposals));
    } catch {
      // Offline: the cards on screen stay as the last state the server confirmed.
    }
  }, []);

  /** The human decision. Launch happens server-side before the response returns. */
  const decide = useCallback(
    async (refId: string, decision: "approve" | "reject") => {
      const conversationId = wire.current.conversationId;
      if (!conversationId) return;
      setDeciding(refId);
      try {
        const response = await fetch(
          `/api/cognitive/conversations/${encodeURIComponent(conversationId)}/proposals/${encodeURIComponent(refId)}/decision`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ decision }),
          },
        );
        const outcome = decisionOutcome(response.status);
        if (!outcome.landed && outcome.code) {
          dispatch({
            type: "local_error",
            code: outcome.code,
            message: `decision HTTP ${response.status}`,
          });
        }
      } catch {
        dispatch({ type: "local_error", code: "DECISION", message: "decision not sent" });
      } finally {
        setDeciding(null);
        await refreshProposals();
      }
    },
    [refreshProposals],
  );

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
    setIcosSpeaking(false);
  }, [setIcosSpeaking]);

  /**
   * Ferme le micro MAINTENANT : lien perdu, hors ligne, session arrêtée. Jamais
   * d'enregistrement qui continue sans que l'écran le dise — `MIC_CLOSED` retire aussitôt
   * la phase d'écoute, donc l'indicateur ne peut pas rester allumé sur un micro fermé.
   */
  const releaseMic = useCallback(() => {
    const open = turn.current;
    turn.current = null;
    vad.current.reset();
    const m = mic.current;
    if (m) {
      m.source.disconnect();
      m.stream.getTracks().forEach((track) => track.stop());
    }
    mic.current = null;
    sessionDispatch({ type: "MIC_CLOSED" });
    if (open) dispatch({ type: "discard_turn", turnId: open.turnId });
  }, [sessionDispatch]);

  const play = useCallback(
    (turnId: string, data: string) => {
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
          setIcosSpeaking(true);
          source.onended = () => {
            p.sources.delete(source);
            if (p.sources.size === 0) setIcosSpeaking(false);
          };
        })
        .catch(() => {
          dispatch({
            type: "local_error",
            code: "PLAYBACK",
            message: "un extrait audio n'a pas pu être lu",
          });
        });
    },
    [setIcosSpeaking],
  );

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
            /*
             * `auto_vad` DIT LA VÉRITÉ AU SERVEUR : c'est bien le client qui segmente les
             * tours, avec son VAD local. En `push_to_talk` le serveur attendrait un geste
             * humain qui n'existe plus, et sa fin d'énoncé ne voudrait plus rien dire.
             */
            turnMode: "auto_vad",
            language: navigator.language || "fr-FR",
            ...(wire.current.sessionId ? { sessionId: wire.current.sessionId } : {}),
            ...(wire.current.conversationId ? { conversationId: wire.current.conversationId } : {}),
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
          sessionDispatch({ type: "LINK", link: "ready" });
          wire.current = {
            sessionId: message.sessionId,
            conversationId: message.conversationId,
          };
          // Recovery: a reconnect gets its mission state back from the record, not the socket.
          void refreshProposals();
        }
        if (message.type === "turn_accepted") wire.current.conversationId = message.conversationId;
        // A proposal was created or advanced: the authority is the record, so re-read it.
        if (message.type === "response_event") void refreshProposals();
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
        releaseMic(); // an utterance cannot survive a lost link
        if (closed) return;
        // 1011 + a reason: the server said why voice cannot work at all (no STT, no
        // cognition). Keep the server's own code so the screen states the real cause
        // instead of retrying something that configuration alone can fix.
        if (event.code === 1011 && event.reason) {
          dispatch({ type: "local_error", code: event.reason, message: event.reason });
          sessionDispatch({ type: "FATAL", message: userMessage(event.reason) });
          return dispatch({ type: "link", link: "unavailable" });
        }
        dispatch({ type: "link", link: "reconnecting" });
        sessionDispatch({ type: "LINK", link: "reconnecting" });
        // A refused upgrade looks like any drop (1006): after a few, ask HTTP why.
        // The probe carries the SOCKET's own permission, so a 403 here really is
        // the socket's 403 — see src/app/api/voice/status/route.ts.
        if (attempt >= 2) {
          void fetch("/api/voice/status", { cache: "no-store" }).then(
            (res) => {
              if (res.status === 401) location.assign("/login?next=%2Fvoice");
              if (res.status === 403) {
                closed = true;
                clearTimeout(retry);
                dispatch({ type: "link", link: "unavailable" });
                sessionDispatch({ type: "FATAL", message: "accès voix refusé" });
                dispatch({ type: "local_error", code: "FORBIDDEN", message: "accès voix refusé" });
              }
            },
            () => {},
          );
        }
        retry = setTimeout(connect, reconnectDelay(attempt++));
      };
    };

    const onOffline = () => {
      releaseMic();
      dispatch({ type: "link", link: "offline" });
      sessionDispatch({ type: "LINK", link: "offline" });
    };
    const onOnline = () => {
      const socket = ws.current;
      if (socket?.readyState === WebSocket.OPEN) {
        sessionDispatch({ type: "LINK", link: "ready" });
        return dispatch({ type: "link", link: "ready" });
      }
      if (socket?.readyState === WebSocket.CONNECTING) return;
      clearTimeout(retry);
      connect();
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
      mic.current?.stream.getTracks().forEach((track) => track.stop());
      void audio.current?.ctx.close();
    };
  }, [play, send, stopPlayback, releaseMic, refreshProposals, sessionDispatch]);

  /*
   * POLITIQUE D'INACTIVITÉ. Une pause entre deux phrases ne ferme JAMAIS la session —
   * `inactivityExpired` n'est vrai qu'au repos, jamais pendant qu'on parle ni pendant
   * qu'ICOS répond. Un micro ouvert qu'on a oublié, en revanche, finit par se fermer.
   */
  useEffect(() => {
    if (!session.sessionRequested) return;
    const timer = setInterval(() => {
      if (inactivityExpired(sessionRef.current, nowMs())) {
        sessionDispatch({ type: "INACTIVITY_TIMEOUT" });
        releaseMic();
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [session.sessionRequested, sessionDispatch, releaseMic]);

  /* Le micro doit suivre la session, y compris quand elle se ferme toute seule. */
  useEffect(() => {
    if (!session.sessionRequested && mic.current) releaseMic();
  }, [session.sessionRequested, releaseMic]);

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
    const t = turn.current;
    if (!t || t.buffered === 0) return;
    const samples = new Float32Array(t.buffered);
    let at = 0;
    for (const chunk of t.pending) {
      samples.set(chunk, at);
      at += chunk.length;
    }
    t.pending = [];
    t.buffered = 0;
    const pcm = toPcm16(samples, ctx.sampleRate, SAMPLE_RATE);
    send({
      type: "audio",
      turnId: t.turnId,
      seq: t.seq++,
      encoding: "pcm16",
      sampleRate: SAMPLE_RATE,
      data: bytesToBase64(new Uint8Array(pcm.buffer)),
    });
  };

  /**
   * LE CŒUR DE LA SESSION CONTINUE. Le tap audio appelle ceci en permanence tant que la
   * session est ouverte ; c'est le VAD LOCAL qui décide où commence et où finit un tour.
   *
   * Aucun octet ne part tant qu'une parole n'a pas commencé : les trames de silence sont
   * poussées dans le VAD et jetées. Ce qui est envoyé, c'est un énoncé, pas le micro.
   */
  const onSamples = (ctx: AudioContext, samples: Float32Array) => {
    if (!micIsCapturing(sessionRef.current)) return;
    const event = vad.current.push(samples, ctx.sampleRate);

    if (event === "SPEECH_START") beginTurn(ctx, samples);
    else if (turn.current) {
      turn.current.pending.push(samples);
      turn.current.buffered += samples.length;
      if (turn.current.buffered >= (ctx.sampleRate * FRAME_MS) / 1000) sendFrame(ctx);
    }

    if (event === "SPEECH_END") endTurn(ctx);
  };

  /**
   * Début d'énoncé. Si ICOS parle, c'est un BARGE-IN : on coupe sa voix localement et tout
   * de suite (sans attendre l'aller-retour serveur), puis on lui dit de s'arrêter.
   */
  const beginTurn = (ctx: AudioContext, first: Float32Array) => {
    const turnId = newTurnId();
    sessionDispatch({ type: "SPEECH_START", at: nowMs() });
    if (speakingRef.current) {
      silenceCurrent();
      send({ type: "interrupt" });
      dispatch({ type: "interrupt" });
      /* La coupure est effective : la machine peut passer de INTERRUPTED à la capture. */
      sessionDispatch({ type: "PLAYBACK_STOPPED" });
    }
    turn.current = { turnId, pending: [first], buffered: first.length, seq: 0 };
    dispatch({ type: "talk", turnId });
    send({ type: "turn", turnId, signal: "VOICE_ACTIVITY_START" });
  };

  /** Fin d'énoncé : on vide le tampon pour ne pas couper le dernier mot, puis on valide. */
  const endTurn = (ctx: AudioContext) => {
    const t = turn.current;
    sessionDispatch({ type: "SPEECH_END", at: nowMs() });
    if (!t) return;
    sendFrame(ctx);
    turn.current = null;
    dispatch({ type: "stop_talking" });
    send({ type: "turn", turnId: t.turnId, signal: "VOICE_ACTIVITY_END" });
    send({ type: "turn", turnId: t.turnId, signal: "TURN_COMMIT" });
  };

  /** Silence whatever ICOS is saying, locally and at once. */
  const silenceCurrent = () => {
    const active = activeTurn(stateRef.current)?.id ?? lastAudioTurn.current;
    if (active) silenced.current.add(active);
    stopPlayback();
  };

  /**
   * OUVRE LA SESSION : le micro s'ouvre UNE fois et reste ouvert. Tout ce qui suit —
   * détection de parole, tours, barge-in, retour à l'écoute — se fait sans un geste de plus.
   *
   * `ensureAudio()` est appelé SYNCHRONEMENT dans le geste : iOS ne débloque l'audio que là,
   * donc un `await` avant lui rendrait la lecture muette sur iPhone.
   */
  const openMic = async () => {
    try {
      const { ctx, tap } = ensureAudio(); // partie synchrone du geste
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Micro indisponible : ouvrez ICOS en HTTPS (origine sécurisée).");
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          /* L'annulation d'écho est ce qui permet le barge-in : sans elle, la voix d'ICOS
             dans le haut-parleur réveillerait le VAD et ICOS se couperait lui-même. */
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (!sessionRef.current.sessionRequested) {
        /* Fermée pendant que la permission s'affichait : on ne laisse pas une piste ouverte. */
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const source = ctx.createMediaStreamSource(stream);
      source.connect(await tap);
      vad.current.reset();
      mic.current = { stream, source };
      sessionDispatch({ type: "MIC_OPENED", at: nowMs() });
      /*
       * SURVEILLANCE DE LA PERMISSION. Une permission révoquée en cours de session termine
       * la piste sans erreur : sans cet écouteur, l'écran continuerait d'afficher une écoute
       * qui n'existe plus — exactement le mensonge que ce lot interdit.
       */
      for (const track of stream.getTracks()) {
        track.onended = () =>
          sessionDispatch({ type: "MIC_DENIED", message: "micro coupé ou permission retirée" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "micro refusé";
      sessionDispatch({ type: "MIC_DENIED", message });
      dispatch({
        type: "local_error",
        code: window.isSecureContext ? "MICROPHONE" : "INSECURE_CONTEXT",
        message,
      });
    }
  };

  /** LE BOUTON UNIQUE. Un appui ouvre, un appui ferme. Il n'y en a pas d'autre. */
  const toggleSession = () => {
    const wasOpen = sessionRef.current.sessionRequested;
    sessionDispatch({ type: "TOGGLE_SESSION", at: nowMs() });
    if (wasOpen) {
      /* Fermeture : la voix d'ICOS s'arrête avec le micro, sinon elle parlerait seule. */
      silenceCurrent();
      send({ type: "cancel" });
      releaseMic();
      return;
    }
    void openMic();
  };

  const resend = (turnId: string) => send({ type: "turn", turnId, signal: "TURN_COMMIT" });

  const interrupt = () => {
    silenceCurrent();
    dispatch({ type: "interrupt" });
    send({ type: "interrupt" });
  };

  /* LA phase affichée vient de la machine pure : elle seule connaît micro et transport. */
  const phase = voicePhase(session);
  const meta = PHASE[phase];
  const sessionOpen = session.sessionRequested;
  const canInterrupt = speaking || !!activeTurn(state);
  const wakeWord = wakeWordStatus(session.wakeWord, NO_WAKE_WORD_DETECTOR);
  const [diagnostics, setDiagnostics] = useState(false);
  const diagnosticsButton = useRef<HTMLButtonElement>(null);
  const diagnosticsClose = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (diagnostics) diagnosticsClose.current?.focus();
  }, [diagnostics]);
  const closeDiagnostics = () => {
    setDiagnostics(false);
    diagnosticsButton.current?.focus();
  };
  const blocking = state.error && isBlocking(state.error.code) ? state.error : null;
  // Any current, non-blocking problem is said in the dock, whatever the phase.
  const notice = state.error && !blocking ? userMessage(state.error.code) : null;
  const hint = notice ?? (meta.hint || " ");
  const shownMissions = latestMissionEvents(state.turns);
  const lastAnswer = state.turns.findLast((t) => t.state === "done" && t.icos)?.icos;

  const micLabel = sessionOpen
    ? "Fermer la conversation vocale"
    : "Ouvrir une conversation vocale avec ICOS";

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
        <span className={styles.chip} data-tone={meta.tone} aria-hidden="true">
          {PHASE_ICON[phase]}
          {meta.label}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          ref={diagnosticsButton}
          onClick={() => setDiagnostics((d) => !d)}
          aria-expanded={diagnostics}
          aria-controls="voice-diagnostics"
          aria-label="Diagnostics techniques"
        >
          <Info aria-hidden />
        </button>
      </header>

      <section className={styles.feed} aria-label="Conversation avec ICOS">
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
          const events = turn.events.flatMap((raw, i) => {
            const event = operationalEvent(raw);
            const key = `${turn.id}:${i}`;
            if (!event || (event.kind === "mission" && !shownMissions.has(key))) return [];
            return [{ event, key }];
          });
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
              {events.map(({ event, key }) =>
                event.kind === "mission" ? (
                  <Mission
                    key={key}
                    mission={event.mission}
                    label={event.label}
                    tone={event.tone}
                  />
                ) : (
                  <p key={key} className={styles.event} data-tone={event.tone}>
                    {TONE_ICON[event.tone]}
                    {event.label}
                  </p>
                ),
              )}
            </article>
          );
        })}
        {proposals.length > 0 && (
          <>
            <h2 className={styles.srOnly}>Missions et actions proposées</h2>
            {proposals.map((card) => (
              <Proposal
                key={card.refId}
                card={card}
                busy={deciding === card.refId}
                onDecide={(decision) => void decide(card.refId, decision)}
              />
            ))}
          </>
        )}
        <div ref={turnsEnd} />
      </section>
      <p className={styles.srOnly} aria-live="polite">
        {lastAnswer ? `ICOS : ${plainText(lastAnswer)}` : ""}
      </p>

      {/*
        MOT-CLÉ « ICOS » — OFF par défaut, et honnête sur ce qu'il fait.
        Aucun moteur local n'est fourni dans cette version : l'interrupteur existe, l'état
        est réel, et l'explication dit qu'il ne détecte rien plutôt que de le laisser croire.
        Il est désactivé tant qu'aucun moteur n'est installé — un interrupteur qu'on peut
        armer sans effet est un mensonge d'interface.
      */}
      <section className={styles.wakeWord} aria-label="Activation par mot-clé">
        <label className={styles.wakeWordRow}>
          <span className={styles.wakeWordLabel}>Mot-clé « {wakeWord.phrase} »</span>
          <input
            type="checkbox"
            checked={wakeWord.enabled}
            disabled={!wakeWord.available}
            onChange={(event) =>
              sessionDispatch({
                type: "WAKE_WORD_MODE",
                mode: event.target.checked ? "ARMED" : "OFF",
              })
            }
          />
          <span aria-hidden="true">{wakeWord.enabled ? "ON" : "OFF"}</span>
        </label>
        <p className={styles.wakeWordHint} role="status" aria-live="polite">
          {wakeWord.explanation}
        </p>
      </section>

      <footer className={styles.dock} data-tone={meta.tone}>
        <div className={styles.phase} role="status" aria-live="polite">
          <span className={styles.phaseLabel}>
            {PHASE_ICON[phase]}
            {meta.label}
          </span>
          <span className={styles.phaseHint} data-notice={notice !== null}>
            {hint}
          </span>
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
        {/*
          LE BOUTON UNIQUE. Un appui ouvre la conversation, un appui la ferme. Il n'y a plus
          de bouton « parler » : entre deux tours, il n'y a rien à toucher. Grand, centré,
          et au pouce — c'est la cible principale sur un téléphone tenu d'une main.
        */}
        <button
          type="button"
          className={styles.mic}
          data-phase={phase}
          data-open={sessionOpen}
          onClick={toggleSession}
          aria-pressed={sessionOpen}
          aria-label={micLabel}
        >
          {phase === "ICOS_SPEAKING" || phase === "USER_SPEAKING" ? (
            <span className={styles.bars} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
          ) : sessionOpen ? (
            <Square aria-hidden />
          ) : (
            <Mic aria-hidden />
          )}
        </button>
        <div className={`${styles.side} ${styles.sideEnd}`}>
          {/*
            L'ÉTAT DU MICRO, TOUJOURS VISIBLE, et dérivé du fait que la piste est réellement
            ouverte — jamais de l'intention de l'ouvrir. Une capture invisible est impossible
            à produire : `micIsCapturing` est la même source que la phase.
          */}
          <span className={styles.secondary} role="status" aria-live="polite">
            <Mic aria-hidden />
            {micIsCapturing(session) ? "Micro ouvert" : "Micro fermé"}
          </span>
        </div>
      </footer>

      {diagnostics && (
        <section
          id="voice-diagnostics"
          className={styles.diagnostics}
          aria-label="Diagnostics techniques"
          onKeyDown={(event) => {
            if (event.key === "Escape") closeDiagnostics();
          }}
        >
          <div className={styles.missionHead}>
            <h2>Diagnostics</h2>
            <button
              type="button"
              className={styles.iconButton}
              ref={diagnosticsClose}
              onClick={closeDiagnostics}
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
