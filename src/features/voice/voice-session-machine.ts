import type { VoiceLink } from "./voice-client";

/**
 * LA MACHINE À ÉTATS D'UNE SESSION VOCALE CONTINUE (P0-P). Pure : ni DOM, ni WebSocket, ni
 * AudioContext, ni horloge. La même suite d'évènements donne toujours le même état.
 *
 * ── CE QUI EXISTAIT, ET POURQUOI ÇA NE SUFFISAIT PAS ────────────────────────────────────
 * `voice-client.ts` réduit déjà les messages SERVEUR en tours de conversation. Il ne décrit
 * pas de SESSION : le micro s'ouvrait et se fermait à chaque tour, il fallait donc recliquer
 * pour parler. Ce fichier ajoute la couche manquante — « le micro reste ouvert, les tours
 * s'enchaînent tout seuls » — et rien d'autre : il ne duplique aucun état de tour.
 *
 * ── LA PHASE EST DÉRIVÉE, JAMAIS AFFECTÉE ───────────────────────────────────────────────
 * Les dix phases ne sont pas stockées : elles sont CALCULÉES à partir de faits observés
 * (le micro est-il réellement ouvert, le transport est-il réellement prêt, que fait-on).
 * C'est ce qui rend les deux règles de véracité STRUCTURELLES et non déclaratives :
 *
 *   « ne jamais afficher LISTENING si la capture micro est indisponible »
 *   « ne jamais afficher CONNECTED si le transport temps réel est tombé »
 *
 * Une transition écrite à la main pourrait poser `LISTENING` en oubliant un cas ; ici
 * `LISTENING` n'est RETOURNABLE que si `micOpen && link === "ready"`. Le mensonge est
 * inexprimable, pas seulement évité.
 */

export const VOICE_PHASES = [
  "OFF",
  "CONNECTING",
  "LISTENING",
  "USER_SPEAKING",
  "THINKING",
  "ICOS_SPEAKING",
  "INTERRUPTED",
  "RECONNECTING",
  "DEGRADED",
  "ERROR",
] as const;
export type VoicePhase = (typeof VOICE_PHASES)[number];

/** Ce que la session est en train de faire, QUAND micro et transport sont tous deux bons. */
type Activity = "idle" | "user_speaking" | "thinking" | "icos_speaking" | "interrupted";

/**
 * Le mode d'activation par mot-clé. OFF PAR DÉFAUT, et ce défaut est dans le type : un
 * microphone qui écoute en permanence doit être un choix explicite de Geoffrey, jamais un
 * état par omission.
 */
export type WakeWordMode = "OFF" | "ARMED";

export interface VoiceSessionState {
  /** Le bouton unique. `true` entre le clic d'ouverture et le clic de fermeture. */
  readonly sessionRequested: boolean;
  readonly link: VoiceLink;
  /** Le micro est RÉELLEMENT ouvert (piste active), pas « on l'a demandé ». */
  readonly micOpen: boolean;
  readonly activity: Activity;
  /** Panne non récupérable : la session est finie et on dit pourquoi. */
  readonly fatal: string | null;
  /** Fonctionne, mais amoindri (voix muette, reconnexion épuisée). Lisible par l'humain. */
  readonly degraded: string | null;
  readonly wakeWord: WakeWordMode;
  /** Tentatives de reconnexion consommées, pour une relance bornée. */
  readonly reconnectAttempts: number;
  /** Horodatage de la dernière activité vocale, pour la politique d'inactivité. */
  readonly lastActivityAt: number;
}

export const MAX_RECONNECT_ATTEMPTS = 5;

/** Une pause entre deux phrases n'arrête JAMAIS la session ; vingt minutes de silence, si. */
export const DEFAULT_INACTIVITY_MS = 20 * 60 * 1_000;

export const initialSessionState: VoiceSessionState = {
  sessionRequested: false,
  link: "connecting",
  micOpen: false,
  activity: "idle",
  fatal: null,
  degraded: null,
  wakeWord: "OFF",
  reconnectAttempts: 0,
  lastActivityAt: 0,
};

export type VoiceSessionEvent =
  /** Le bouton unique. Un seul évènement pour les deux sens : c'est un seul bouton. */
  | { type: "TOGGLE_SESSION"; at: number }
  | { type: "LINK"; link: VoiceLink }
  | { type: "MIC_OPENED"; at: number }
  | { type: "MIC_CLOSED" }
  /** Permission refusée ou RÉVOQUÉE : la session ne peut pas continuer. */
  | { type: "MIC_DENIED"; message: string }
  | { type: "SPEECH_START"; at: number }
  | { type: "SPEECH_END"; at: number }
  /** L'audio d'ICOS a été réellement coupé après une interruption : on peut capturer. */
  | { type: "PLAYBACK_STOPPED" }
  | { type: "RESPONSE_STARTED" }
  | { type: "ICOS_AUDIO_STARTED" }
  | { type: "ICOS_AUDIO_ENDED"; at: number }
  | { type: "DEGRADED"; message: string }
  | { type: "RECOVERED" }
  | { type: "FATAL"; message: string }
  | { type: "WAKE_WORD_MODE"; mode: WakeWordMode }
  | { type: "WAKE_WORD_DETECTED"; at: number }
  | { type: "INACTIVITY_TIMEOUT" };

/** Une session qui s'arrête repart d'une ardoise propre, sauf le mode mot-clé choisi. */
function stopped(state: VoiceSessionState, fatal: string | null = null): VoiceSessionState {
  return {
    ...initialSessionState,
    wakeWord: state.wakeWord,
    link: state.link,
    fatal,
  };
}

export function reduceVoiceSession(
  state: VoiceSessionState,
  event: VoiceSessionEvent,
): VoiceSessionState {
  switch (event.type) {
    case "TOGGLE_SESSION":
      return state.sessionRequested
        ? stopped(state)
        : /* Un nouveau départ efface l'erreur précédente : c'est ce que « réessayer » veut dire. */
          {
            ...state,
            sessionRequested: true,
            fatal: null,
            degraded: null,
            activity: "idle",
            reconnectAttempts: 0,
            lastActivityAt: event.at,
          };

    case "WAKE_WORD_DETECTED":
      /* Le mot-clé n'OUVRE une session que s'il est armé, et n'autorise RIEN d'autre. */
      if (state.wakeWord !== "ARMED" || state.sessionRequested) return state;
      return { ...state, sessionRequested: true, fatal: null, lastActivityAt: event.at };

    case "WAKE_WORD_MODE":
      return { ...state, wakeWord: event.mode };

    case "LINK": {
      /*
       * Une reconnexion est BORNÉE. Au-delà, on ne prétend plus reconnecter : on passe en
       * DEGRADED avec une explication, parce qu'une roue qui tourne indéfiniment est un
       * mensonge plus coûteux qu'un aveu.
       */
      if (event.link === "reconnecting") {
        const attempts = state.reconnectAttempts + 1;
        return attempts > MAX_RECONNECT_ATTEMPTS
          ? {
              ...state,
              link: "offline",
              reconnectAttempts: attempts,
              degraded: `reconnexion abandonnée après ${MAX_RECONNECT_ATTEMPTS} tentatives`,
            }
          : { ...state, link: event.link, reconnectAttempts: attempts };
      }
      if (event.link === "ready") {
        /* Le compteur ne repart qu'à une VRAIE reprise, sinon la borne ne borne rien. */
        return { ...state, link: "ready", reconnectAttempts: 0, degraded: null };
      }
      return { ...state, link: event.link };
    }

    case "MIC_OPENED":
      return { ...state, micOpen: true, lastActivityAt: event.at };

    case "MIC_CLOSED":
      /* Le micro se ferme aussi à l'arrêt volontaire : ce n'est pas une erreur en soi. */
      return { ...state, micOpen: false, activity: "idle" };

    case "MIC_DENIED":
      /* Permission refusée ou révoquée en cours de session : il n'y a plus de session. */
      return stopped(state, event.message);

    case "SPEECH_START":
      if (!state.sessionRequested) return state;
      /*
       * BARGE-IN. Pendant qu'ICOS parle, la parole de Geoffrey prime : on passe par
       * INTERRUPTED, qui dit « on a coupé la voix et on n'a pas encore commencé à capturer ».
       * On n'attend JAMAIS qu'ICOS ait fini.
       */
      if (state.activity === "icos_speaking") {
        return { ...state, activity: "interrupted", lastActivityAt: event.at };
      }
      return { ...state, activity: "user_speaking", lastActivityAt: event.at };

    case "PLAYBACK_STOPPED":
      /* La coupure est effective : la nouvelle parole est maintenant capturée. */
      return state.activity === "interrupted" ? { ...state, activity: "user_speaking" } : state;

    case "SPEECH_END":
      /* Fin d'énoncé : le tour part. On ne revient pas à l'écoute, on attend la réponse. */
      return state.activity === "user_speaking" || state.activity === "interrupted"
        ? { ...state, activity: "thinking", lastActivityAt: event.at }
        : state;

    case "RESPONSE_STARTED":
      return state.activity === "thinking" ? state : state;

    case "ICOS_AUDIO_STARTED":
      /* Si Geoffrey a déjà repris la parole, sa parole gagne : on ne repasse pas en lecture. */
      return state.activity === "thinking" ? { ...state, activity: "icos_speaking" } : state;

    case "ICOS_AUDIO_ENDED":
      /*
       * RETOUR AUTOMATIQUE À L'ÉCOUTE. C'est la boucle qui rend la session continue : aucun
       * clic entre deux tours. On ne le fait QUE depuis la lecture — si Geoffrey a barge-in,
       * l'état est déjà le sien et l'écraser lui volerait son tour.
       */
      return state.activity === "icos_speaking"
        ? { ...state, activity: "idle", lastActivityAt: event.at }
        : state;

    case "DEGRADED":
      return { ...state, degraded: event.message };

    case "RECOVERED":
      return { ...state, degraded: null };

    case "FATAL":
      return stopped(state, event.message);

    case "INACTIVITY_TIMEOUT":
      return state.sessionRequested ? stopped(state) : state;
  }
}

/**
 * LA PHASE OBSERVABLE. Dérivée, dans cet ordre de priorité, pour que l'état le plus
 * contraignant l'emporte toujours sur l'état le plus flatteur.
 */
export function voicePhase(state: VoiceSessionState): VoicePhase {
  if (state.fatal !== null) return "ERROR";
  if (!state.sessionRequested) return "OFF";
  /* Transport définitivement indisponible ou reconnexion épuisée : amoindri, pas « prêt ». */
  if (state.link === "unavailable" || state.link === "offline") return "DEGRADED";
  if (state.link === "reconnecting") return "RECONNECTING";
  if (state.link === "connecting") return "CONNECTING";
  /* Transport prêt mais micro pas encore ouvert : on CONNECTE, on n'ÉCOUTE pas. */
  if (!state.micOpen) return "CONNECTING";
  if (state.degraded !== null) return "DEGRADED";
  switch (state.activity) {
    case "user_speaking":
      return "USER_SPEAKING";
    case "thinking":
      return "THINKING";
    case "icos_speaking":
      return "ICOS_SPEAKING";
    case "interrupted":
      return "INTERRUPTED";
    case "idle":
      return "LISTENING";
  }
}

/** Le micro capture-t-il RÉELLEMENT en ce moment ? Ce que l'indicateur doit refléter. */
export const micIsCapturing = (state: VoiceSessionState): boolean =>
  state.sessionRequested && state.micOpen;

/** La session doit-elle fermer faute d'activité ? Une pause entre phrases n'y suffit pas. */
export const inactivityExpired = (
  state: VoiceSessionState,
  now: number,
  afterMs: number = DEFAULT_INACTIVITY_MS,
): boolean =>
  state.sessionRequested && state.activity === "idle" && now - state.lastActivityAt >= afterMs;
