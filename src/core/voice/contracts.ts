import { z } from "zod";

/**
 * Voice realtime contracts (decision 0061).
 *
 * The voice layer is a transport/session adapter around the Cognitive Runtime.
 * A VoiceSession is ephemeral transport state; conversation identity, turn
 * durability, memory and reasoning belong to the Cognitive Runtime.
 * Nothing here depends on a transport (WebSocket, SSE…) or a STT/TTS vendor.
 */

// ---------------------------------------------------------------------------
// Wire protocol — transport-neutral JSON messages.
// ---------------------------------------------------------------------------

/** Client-generated id: idempotency key for a speech segment / user turn. */
const Id = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** 64 KiB of base64 per frame: ~2 s of 16 kHz PCM16, far above a 20–100 ms frame. */
const MAX_AUDIO_FRAME_B64 = 87_384;

export const DeviceKindSchema = z.enum(["browser", "pwa", "native", "dedicated_device"]);
export const TurnModeSchema = z.enum(["push_to_talk", "auto_vad"]);
export const AudioEncodingSchema = z.enum(["pcm16", "opus"]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    /** Present to resume an existing voice session after a reconnect. */
    sessionId: Id.optional(),
    /** Cognitive Runtime conversation to continue; the runtime owns it. */
    conversationId: z.string().min(1).max(128).optional(),
    device: DeviceKindSchema,
    turnMode: TurnModeSchema.default("push_to_talk"),
    language: z.string().min(2).max(35).optional(),
  }),
  z.object({
    type: z.literal("audio"),
    turnId: Id,
    /** Monotonic per turn; a replayed (turnId, seq) is ignored. */
    seq: z.number().int().nonnegative(),
    encoding: AudioEncodingSchema,
    sampleRate: z.number().int().min(8_000).max(48_000),
    data: z.string().max(MAX_AUDIO_FRAME_B64),
  }),
  /** Turn signals from any detector: push-to-talk button, client VAD, wake word. */
  z.object({
    type: z.literal("turn"),
    turnId: Id,
    signal: z.enum(["VOICE_ACTIVITY_START", "VOICE_ACTIVITY_END", "TURN_COMMIT"]),
  }),
  z.object({ type: z.literal("interrupt") }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("heartbeat") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const VoiceErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "TURN_DROPPED",
  "NOT_READY",
  "SESSION_EXPIRED",
  "SESSION_FORBIDDEN",
  "PROVIDER_NOT_CONFIGURED",
  "STT_UNAVAILABLE",
  "STT_TIMEOUT",
  "TTS_UNAVAILABLE",
  "TTS_TIMEOUT",
  "COGNITIVE_UNAVAILABLE",
  "COGNITIVE_ERROR",
  "COGNITIVE_TIMEOUT",
]);
export type VoiceErrorCode = z.infer<typeof VoiceErrorCodeSchema>;

export type PlaybackStopReason = "BARGE_IN" | "USER_CANCEL" | "TTS_FAILED" | "DETACHED" | "TIMEOUT";

export type ServerMessage =
  | {
      type: "ready";
      sessionId: string;
      conversationId: string | null;
      resumed: boolean;
      /** Turns the Cognitive Runtime has durably accepted in this session. */
      acceptedTurnIds: string[];
      retention: RetentionPolicy;
    }
  | {
      type: "transcript";
      turnId: string;
      final: boolean;
      /** Monotonic per turn; a stale partial never overwrites a newer one. */
      rev: number;
      text: string;
      language?: string;
      confidence?: number;
    }
  /** The Cognitive Runtime durably accepted the turn: it is no longer ours to lose. */
  | { type: "turn_accepted"; turnId: string; conversationId: string }
  | { type: "response_delta"; turnId: string; text: string }
  | {
      type: "response_event";
      turnId: string;
      kind: "ACTION_EVENT" | "MISSION_EVENT" | "APPROVAL_EVENT";
      payload: unknown;
    }
  | { type: "response_final"; turnId: string; text: string }
  | { type: "audio"; turnId: string; seq: number; mime: string; data: string }
  | { type: "playback_stop"; turnId: string; reason: PlaybackStopReason }
  | {
      type: "error";
      code: VoiceErrorCode;
      retryable: boolean;
      turnId?: string;
      /** For COGNITIVE_UNAVAILABLE: the committed text, so the client can resend it. */
      text?: string;
      /** True when un-committed audio of the turn was discarded. */
      audioLost?: boolean;
      message: string;
    }
  | { type: "turn_metrics"; metrics: TurnLatency }
  | { type: "heartbeat_ack" };

// ---------------------------------------------------------------------------
// Provider ports — STT, TTS, Cognitive Runtime.
// ---------------------------------------------------------------------------

export type SttEvent =
  | {
      type: "partial" | "final";
      text: string;
      language?: string;
      confidence?: number;
      /** Offsets in ms from the start of the segment, when the provider gives them. */
      startMs?: number;
      endMs?: number;
    }
  | { type: "error"; message: string; timeout?: boolean };

/**
 * Partials may come any time; exactly one "final" (the whole utterance) comes
 * after finish(). Events after the final are ignored.
 */
export interface SttStream {
  write(frame: Uint8Array): void;
  /** End of speech: the provider must flush a final transcript. */
  finish(): void;
  cancel(): void;
}

export interface SttProvider {
  readonly id: string;
  /** True for fakes: latency measured through it is not a real measurement. */
  readonly simulated: boolean;
  open(
    options: {
      encoding: z.infer<typeof AudioEncodingSchema>;
      sampleRate: number;
      language?: string;
    },
    onEvent: (event: SttEvent) => void,
  ): SttStream;
}

export type TtsEvent =
  /** `data` is one independently decodable chunk (e.g. one sentence of audio/mpeg). */
  | { type: "audio"; data: Uint8Array; mime: string }
  | { type: "done" }
  | { type: "error"; message: string; timeout?: boolean };

export interface TtsStream {
  text(chunk: string): void;
  finish(): void;
  cancel(): void;
}

export interface TtsProvider {
  readonly id: string;
  readonly simulated: boolean;
  start(options: { language?: string }, onEvent: (event: TtsEvent) => void): TtsStream;
}

/** A user turn committed by the voice layer, submitted to the Cognitive Runtime. */
export type CommittedTurn = {
  conversationId: string | null;
  /**
   * Authenticated user, from server-side auth — never from the client. The
   * runtime must refuse a conversationId this user does not own.
   */
  userId: string;
  voiceSessionId: string;
  /** Idempotency key: submitting the same turnId twice must not create two turns. */
  turnId: string;
  text: string;
  language?: string;
  speechStartedAt: number;
  speechEndedAt: number;
  /** The previous response this turn barged into, so the runtime keeps context. */
  interruptedTurnId?: string;
};

export type CognitiveEvent =
  | { type: "TEXT_DELTA"; text: string }
  | { type: "ACTION_EVENT" | "MISSION_EVENT" | "APPROVAL_EVENT"; payload: unknown }
  | { type: "FINAL_RESPONSE"; text: string }
  | { type: "ERROR"; message: string };

export type CognitiveInterruptReason = "BARGE_IN" | "USER_CANCEL" | "SESSION_CLOSED" | "TIMEOUT";

export interface CognitiveRuntimePort {
  readonly simulated: boolean;
  /**
   * Resolves once the turn is DURABLY accepted (idempotent on turnId) and
   * returns the response event stream. Rejects with CognitiveUnavailableError
   * when the turn could not be accepted. `signal` aborts the response
   * (reason: CognitiveInterruptReason); it never un-accepts the turn.
   */
  submitTurn(
    turn: CommittedTurn,
    signal: AbortSignal,
  ): Promise<{ conversationId: string; events: AsyncIterable<CognitiveEvent> }>;
}

export class CognitiveUnavailableError extends Error {
  constructor(message = "cognitive runtime unavailable") {
    super(message);
    this.name = "CognitiveUnavailableError";
  }
}

// ---------------------------------------------------------------------------
// Retention & latency.
// ---------------------------------------------------------------------------

/**
 * Retention is explicit and minimal. Raw audio is never persisted: frames go to
 * the STT stream and are dropped. Durable audio would need a policy + decision.
 */
export const DEFAULT_RETENTION = Object.freeze({
  audio: "none",
  /** Transcripts are durable only as conversation turns, in the Cognitive Runtime. */
  transcript: "cognitive_runtime",
  /** Diagnostics: timings and ids only, never audio or transcript text. */
  diagnostics: "metadata_only",
} as const);
export type RetentionPolicy = typeof DEFAULT_RETENTION;

/**
 * Server-observed latencies in ms for one turn; null = not observed.
 * `simulated` is true when any provider on the path was a fake — those numbers
 * describe the fake, not a real STT/TTS.
 */
export type TurnLatency = {
  turnId: string;
  simulated: boolean;
  firstAudioToVoiceStartMs: number | null;
  voiceStartToFirstPartialMs: number | null;
  speechEndToFinalMs: number | null;
  finalToFirstCognitiveEventMs: number | null;
  firstCognitiveEventToFirstTtsAudioMs: number | null;
  speechEndToFirstAudioMs: number | null;
};
