import type { ServerMessage, TurnLatency } from "@/core/voice/contracts";

/**
 * Browser-side voice state (decision 0061): a pure reducer over server
 * messages and local actions, plus PCM helpers. No DOM, no audio APIs —
 * those live in the React component.
 */

export type VoiceLink = "connecting" | "ready" | "reconnecting" | "offline" | "unavailable";

export type VoiceTurnView = {
  id: string;
  you: string;
  youFinal: boolean;
  rev: number;
  icos: string;
  state: "listening" | "thinking" | "answering" | "done" | "interrupted" | "dropped" | "failed";
  /** Operational events the runtime attached to this turn (mission, approval, action). */
  events: { kind: "ACTION_EVENT" | "MISSION_EVENT" | "APPROVAL_EVENT"; payload: unknown }[];
};

export type VoiceUiState = {
  link: VoiceLink;
  sessionId: string | null;
  conversationId: string | null;
  /** Mic is open and frames are being sent for this turn. */
  talkingTurnId: string | null;
  turns: VoiceTurnView[];
  /** Audio for these turns must never play again (barge-in / cancel / stop). */
  silenced: string[];
  error: { code: string; message: string } | null;
  /** Last server-observed latencies, for the diagnostics panel only. */
  lastMetrics: TurnLatency | null;
};

export type VoiceAction =
  | { type: "server"; message: ServerMessage }
  | { type: "link"; link: VoiceLink }
  | { type: "talk"; turnId: string }
  | { type: "stop_talking" }
  | { type: "interrupt" }
  | { type: "local_error"; code: string; message: string }
  | { type: "clear_error" }
  /** A local utterance that never reached ICOS (mic refused, user cancelled). */
  | { type: "discard_turn"; turnId: string };

const MAX_TURNS = 20;

export const initialVoiceState: VoiceUiState = {
  link: "connecting",
  sessionId: null,
  conversationId: null,
  talkingTurnId: null,
  turns: [],
  silenced: [],
  error: null,
  lastMetrics: null,
};

export function mayPlay(state: VoiceUiState, turnId: string): boolean {
  return !state.silenced.includes(turnId);
}

/** The turn ICOS is currently answering (thinking or speaking), if any. */
export function activeTurn(state: VoiceUiState): VoiceTurnView | undefined {
  return state.turns.find((t) => t.state === "thinking" || t.state === "answering");
}

function upsert(state: VoiceUiState, id: string, patch: Partial<VoiceTurnView>): VoiceUiState {
  const existing = state.turns.find((t) => t.id === id);
  const turn: VoiceTurnView = {
    ...(existing ?? {
      id,
      you: "",
      youFinal: false,
      rev: 0,
      icos: "",
      state: "listening",
      events: [],
    }),
    ...patch,
  };
  const turns = existing
    ? state.turns.map((t) => (t.id === id ? turn : t))
    : [...state.turns, turn].slice(-MAX_TURNS);
  return { ...state, turns };
}

function silence(state: VoiceUiState, ...ids: string[]): VoiceUiState {
  return { ...state, silenced: [...new Set([...state.silenced, ...ids])].slice(-MAX_TURNS) };
}

export function voiceReducer(state: VoiceUiState, action: VoiceAction): VoiceUiState {
  switch (action.type) {
    case "link":
      return {
        ...state,
        link: action.link,
        talkingTurnId: action.link === "ready" ? state.talkingTurnId : null,
      };
    case "talk": {
      // Speaking over ICOS: whatever it was saying is silenced locally at once.
      const speaking = activeTurn(state);
      let next = upsert({ ...state, talkingTurnId: action.turnId, error: null }, action.turnId, {
        state: "listening",
      });
      if (speaking)
        next = silence(upsert(next, speaking.id, { state: "interrupted" }), speaking.id);
      return next;
    }
    case "stop_talking":
      return { ...state, talkingTurnId: null };
    case "interrupt": {
      const speaking = activeTurn(state);
      return speaking
        ? silence(upsert(state, speaking.id, { state: "interrupted" }), speaking.id)
        : state;
    }
    case "local_error":
      return { ...state, error: { code: action.code, message: action.message } };
    case "clear_error":
      return { ...state, error: null };
    case "discard_turn": {
      const turn = state.turns.find((t) => t.id === action.turnId);
      if (!turn || turn.youFinal || turn.icos) return state; // it reached ICOS: keep it
      return {
        ...state,
        talkingTurnId: state.talkingTurnId === action.turnId ? null : state.talkingTurnId,
        turns: state.turns.filter((t) => t.id !== action.turnId),
      };
    }
    case "server":
      return onServer(state, action.message);
  }
}

function onServer(state: VoiceUiState, m: ServerMessage): VoiceUiState {
  switch (m.type) {
    case "ready":
      return {
        ...state,
        link: "ready",
        sessionId: m.sessionId,
        conversationId: m.conversationId ?? state.conversationId,
        error: null,
      };
    case "transcript": {
      const turn = state.turns.find((t) => t.id === m.turnId);
      if (turn && (m.rev <= turn.rev || turn.youFinal)) return state; // stale partial
      return upsert(state, m.turnId, { you: m.text, youFinal: m.final, rev: m.rev });
    }
    case "turn_accepted":
      return upsert({ ...state, conversationId: m.conversationId }, m.turnId, {
        state: "thinking",
      });
    case "response_delta": {
      const turn = state.turns.find((t) => t.id === m.turnId);
      if (turn?.state === "interrupted") return state;
      return upsert(state, m.turnId, { icos: (turn?.icos ?? "") + m.text, state: "answering" });
    }
    case "response_final": {
      const turn = state.turns.find((t) => t.id === m.turnId);
      if (turn?.state === "interrupted") return state;
      return upsert(state, m.turnId, { icos: m.text, state: "answering" });
    }
    case "playback_stop":
      return silence(state, m.turnId);
    case "turn_metrics": {
      const withMetrics = { ...state, lastMetrics: m.metrics };
      const turn = state.turns.find((t) => t.id === m.metrics.turnId);
      return turn?.state === "answering" || turn?.state === "thinking"
        ? upsert(withMetrics, turn.id, { state: "done" })
        : withMetrics;
    }
    case "error": {
      let next: VoiceUiState = { ...state, error: { code: m.code, message: m.message } };
      if (m.turnId) {
        if (m.code === "TURN_DROPPED" || m.code.startsWith("STT_")) {
          next = upsert(next, m.turnId, { state: "dropped" });
        } else if (m.code.startsWith("COGNITIVE_") && m.text !== undefined) {
          // Only the submission path carries the text: the turn was not accepted.
          next = upsert(next, m.turnId, { state: "failed" });
          if (m.code === "COGNITIVE_ERROR") {
            next = { ...next, error: { code: "COGNITIVE_REJECTED", message: m.message } };
          }
        }
      }
      if (m.code === "PROVIDER_NOT_CONFIGURED" || m.code === "SESSION_FORBIDDEN") {
        next = { ...next, link: "unavailable" };
      }
      if (m.code === "SESSION_EXPIRED") next = { ...next, sessionId: null };
      return next;
    }
    case "response_event": {
      const turn = state.turns.find((t) => t.id === m.turnId);
      const events = [...(turn?.events ?? []), { kind: m.kind, payload: m.payload }].slice(-10);
      return upsert(state, m.turnId, { events });
    }
    case "audio":
    case "heartbeat_ack":
      return state;
  }
}

/**
 * Float32 mono samples at `inputRate` → 16-bit PCM at `outputRate` (box-filter
 * decimation: averages the input samples that fall into each output sample).
 */
export function toPcm16(input: Float32Array, inputRate: number, outputRate = 16_000): Int16Array {
  const ratio = inputRate / outputRate;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / (end - start)));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Client-generated turn id matching the protocol's id rule. */
export function newTurnId(): string {
  return `t-${crypto.randomUUID()}`;
}

/** Reconnect backoff: 0.5 s, 1 s, 2 s … capped at 10 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(10_000, 500 * 2 ** attempt);
}
