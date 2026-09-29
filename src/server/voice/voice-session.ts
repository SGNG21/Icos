import {
  ClientMessageSchema,
  CognitiveUnavailableError,
  DEFAULT_RETENTION,
  type ClientMessage,
  type CognitiveEvent,
  type CognitiveInterruptReason,
  type CognitiveRuntimePort,
  type PlaybackStopReason,
  type ServerMessage,
  type SttEvent,
  type SttProvider,
  type SttStream,
  type TtsEvent,
  type TtsProvider,
  type TtsStream,
  type TurnLatency,
} from "@/core/voice/contracts";

/**
 * Voice session engine (decision 0056): transport-neutral, provider-neutral.
 * A transport (WebSocket…) authenticates the user, then feeds raw client
 * messages to `VoiceConnection.receive` and forwards `send` output.
 *
 * Holds only ephemeral state: audio frames are handed to STT and dropped;
 * conversation durability belongs to the Cognitive Runtime.
 */

export type VoiceDeps = {
  stt: SttProvider;
  /** Absent = text-only responses. */
  tts?: TtsProvider;
  cognitive: CognitiveRuntimePort;
  now?: () => number;
  newId?: () => string;
  /** A detached session can be resumed for this long after its last activity. */
  idleTtlMs?: number;
  timeouts?: Partial<VoiceTimeouts>;
  /** Injectable for tests; returns a cancel function. */
  setTimer?: (fn: () => void, ms: number) => () => void;
};

/** Watchdogs: a hung provider or runtime never blocks later turns. */
export type VoiceTimeouts = {
  /** STT must deliver the final transcript this long after end of speech. */
  sttFinalMs: number;
  /** The runtime must durably accept a turn within this. */
  acceptMs: number;
  /** Maximum silence between two runtime events of one response. */
  responseIdleMs: number;
  /** TTS must finish (or produce audio) this long after the text is complete. */
  ttsTailMs: number;
};

export const DEFAULT_VOICE_TIMEOUTS: VoiceTimeouts = {
  sttFinalMs: 15_000,
  acceptMs: 15_000,
  responseIdleMs: 90_000,
  ttsTailMs: 20_000,
};

type ResolvedDeps = Required<Omit<VoiceDeps, "tts" | "timeouts">> & {
  tts?: TtsProvider;
  timeouts: VoiceTimeouts;
};

class AcceptTimeout extends Error {}

type Send = (message: ServerMessage) => void;

type Turn = {
  id: string;
  phase: "capturing" | "committing" | "accepted" | "failed" | "discarded";
  lastSeq: number;
  stt: SttStream | null;
  sttFinished: boolean;
  rev: number;
  text: string | null;
  language?: string;
  commitRequested: boolean;
  bytes: number;
  /** Resent after a failed submission: end-to-end timings would include the user's wait. */
  retried: boolean;
  interruptedTurnId?: string;
  cancelSttTimer?: () => void;
  t: {
    firstAudio?: number;
    voiceStart?: number;
    firstPartial?: number;
    speechEnd?: number;
    final?: number;
    firstCognitive?: number;
    firstTtsAudio?: number;
  };
};

type Response = {
  turn: Turn;
  abort: AbortController;
  tts: TtsStream | null;
  audioSeq: number;
  /** Once true, nothing from this response reaches the client as audio. */
  stopped: boolean;
  textDone: boolean;
  cancelTimer?: () => void;
};

const MAX_METRICS = 50;
/** Turn ids remembered per session (replay dedupe); the runtime is idempotent beyond that. */
const MAX_TURNS = 200;
/** ~5 min of 16 kHz PCM16. */
const MAX_TURN_BYTES = 10_000_000;

export class VoiceSession {
  readonly id: string;
  conversationId: string | null;
  private send: Send | null = null;
  private readonly turns = new Map<string, Turn>();
  private response: Response | null = null;
  private lastInterruptedTurnId: string | undefined;
  private lastActivity: number;
  /** Submissions are serialized so turns reach the runtime in order, on one conversation. */
  private acceptance: Promise<unknown> = Promise.resolve();
  private closed = false;
  readonly metrics: TurnLatency[] = [];

  constructor(
    private readonly deps: ResolvedDeps,
    readonly ownerUserId: string,
    id: string,
    private readonly hello: Extract<ClientMessage, { type: "hello" }>,
  ) {
    this.id = id;
    this.conversationId = hello.conversationId ?? null;
    this.lastActivity = deps.now();
  }

  get expired(): boolean {
    // An attached session lives as long as its transport; liveness is the transport's job.
    if (this.closed) return true;
    return this.send === null && this.deps.now() - this.lastActivity > this.deps.idleTtlMs;
  }

  get acceptedTurnIds(): string[] {
    return [...this.turns.values()].filter((t) => t.phase === "accepted").map((t) => t.id);
  }

  /** Transport-free snapshot for diagnostics: ids, phases and timings only. */
  snapshot() {
    return {
      id: this.id,
      conversationId: this.conversationId,
      attached: this.send !== null,
      speaking: this.response !== null && !this.response.stopped,
      turns: [...this.turns.values()].map((t) => ({
        id: t.id,
        phase: t.phase,
        lastSeq: t.lastSeq,
      })),
      metrics: this.metrics,
    };
  }

  isAttachedTo(send: Send): boolean {
    return this.send === send;
  }

  attach(send: Send, resumed: boolean): void {
    this.send = send;
    this.touch();
    this.emit({
      type: "ready",
      sessionId: this.id,
      conversationId: this.conversationId,
      resumed,
      acceptedTurnIds: this.acceptedTurnIds,
      retention: DEFAULT_RETENTION,
    });
  }

  /** Network loss: nobody is listening, so audio stops; accepted turns and the response text live on downstream. */
  detach(send: Send): void {
    if (this.send !== send) return;
    this.send = null;
    this.stopAudio("DETACHED");
    for (const turn of this.turns.values()) {
      if (turn.phase === "capturing") this.discard(turn); // uncommitted audio may be lost
    }
  }

  /** Session expiry / shutdown. Never touches what the Cognitive Runtime accepted. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.send) this.detach(this.send);
    this.interrupt("SESSION_CLOSED");
  }

  handle(message: ClientMessage): void {
    this.touch();
    switch (message.type) {
      case "hello":
        return;
      case "heartbeat":
        return this.emit({ type: "heartbeat_ack" });
      case "audio":
        return this.onAudio(message);
      case "turn":
        return this.onTurnSignal(message.turnId, message.signal);
      case "interrupt":
        return this.interrupt("BARGE_IN");
      case "cancel":
        this.interrupt("USER_CANCEL");
        for (const turn of this.turns.values()) {
          if (turn.phase === "capturing") this.discard(turn);
        }
        return;
    }
  }

  // --- input side ----------------------------------------------------------

  private turn(turnId: string): Turn {
    let turn = this.turns.get(turnId);
    if (!turn) {
      // One utterance is captured at a time: a new segment drops any older one
      // the user did not commit (its audio buffer goes with it).
      for (const other of this.turns.values()) {
        if (other.phase === "capturing" && !other.commitRequested) {
          this.discard(other, "superseded by a newer utterance");
        }
      }
      for (const [id, old] of this.turns) {
        if (this.turns.size < MAX_TURNS) break;
        if (old.phase !== "capturing" && old.phase !== "committing") this.turns.delete(id);
      }
      turn = {
        id: turnId,
        phase: "capturing",
        lastSeq: -1,
        stt: null,
        sttFinished: false,
        rev: 0,
        text: null,
        commitRequested: false,
        bytes: 0,
        retried: false,
        t: {},
      };
      this.turns.set(turnId, turn);
    }
    return turn;
  }

  private onAudio(message: Extract<ClientMessage, { type: "audio" }>): void {
    const turn = this.turn(message.turnId);
    // A replayed frame (reconnect, retransmit) or a frame for a turn already
    // past capture never reaches STT twice.
    if (turn.phase !== "capturing" || turn.sttFinished || message.seq <= turn.lastSeq) return;
    turn.lastSeq = message.seq;
    turn.t.firstAudio ??= this.deps.now();
    const frame = Buffer.from(message.data, "base64");
    turn.bytes += frame.length;
    if (turn.bytes > MAX_TURN_BYTES) return this.discard(turn, "utterance too long");
    if (!turn.stt) {
      try {
        const stt = this.deps.stt.open(
          {
            encoding: message.encoding,
            sampleRate: message.sampleRate,
            language: this.hello.language,
          },
          (event) => this.onStt(turn, event),
        );
        // The provider may have failed synchronously while opening.
        if (turn.phase !== "capturing") return quietly(() => stt.cancel());
        turn.stt = stt;
      } catch (error) {
        return this.onStt(turn, { type: "error", message: errorText(error) });
      }
    }
    try {
      turn.stt.write(frame);
    } catch (error) {
      this.onStt(turn, { type: "error", message: errorText(error) });
    }
  }

  private onTurnSignal(
    turnId: string,
    signal: "VOICE_ACTIVITY_START" | "VOICE_ACTIVITY_END" | "TURN_COMMIT",
  ): void {
    const turn = this.turn(turnId);
    const now = this.deps.now();
    if (signal === "VOICE_ACTIVITY_START") {
      turn.t.voiceStart ??= now;
      // Barge-in: the human speaks over ICOS (a replayed old turn id does not count).
      if (turn.phase === "capturing" && this.response) this.interrupt("BARGE_IN");
      return;
    }
    if (signal === "TURN_COMMIT" && turn.phase === "failed") {
      return void this.submit(turn); // client retry after COGNITIVE_UNAVAILABLE
    }
    if (turn.phase !== "capturing") return;
    if (signal === "VOICE_ACTIVITY_END") {
      turn.t.speechEnd ??= now;
      if (this.hello.turnMode === "auto_vad") turn.commitRequested = true;
    } else {
      turn.t.speechEnd ??= now;
      turn.commitRequested = true;
    }
    if (!turn.stt) {
      if (turn.commitRequested) this.discard(turn, "nothing was heard");
      return;
    }
    if (!turn.sttFinished) {
      turn.sttFinished = true;
      turn.cancelSttTimer = this.deps.setTimer(
        () => this.onStt(turn, { type: "error", message: "no final transcript", timeout: true }),
        this.deps.timeouts.sttFinalMs,
      );
      try {
        turn.stt.finish();
      } catch (error) {
        return this.onStt(turn, { type: "error", message: errorText(error) });
      }
    }
    this.maybeCommit(turn);
  }

  private onStt(turn: Turn, event: SttEvent): void {
    if (turn.phase !== "capturing" || turn.text !== null) return; // late or post-final
    if (event.type === "error") {
      this.discard(turn);
      return this.emit({
        type: "error",
        code: event.timeout ? "STT_TIMEOUT" : "STT_UNAVAILABLE",
        retryable: true,
        turnId: turn.id,
        audioLost: true,
        message: event.timeout
          ? "speech recognition timed out; the uncommitted utterance was not kept"
          : "speech recognition failed; the uncommitted utterance was not kept",
      });
    }
    const now = this.deps.now();
    turn.rev += 1;
    if (event.type === "partial") {
      turn.t.firstPartial ??= now;
    } else {
      turn.t.final = now;
      turn.cancelSttTimer?.();
      turn.text = event.text.trim();
      turn.language = event.language;
    }
    this.emit({
      type: "transcript",
      turnId: turn.id,
      final: event.type === "final",
      rev: turn.rev,
      text: event.text,
      ...(event.language ? { language: event.language } : {}),
      ...(event.confidence !== undefined ? { confidence: event.confidence } : {}),
    });
    this.maybeCommit(turn);
  }

  private maybeCommit(turn: Turn): void {
    if (turn.phase !== "capturing" || !turn.commitRequested || turn.text === null) return;
    if (!turn.text) return this.discard(turn, "nothing was heard");
    turn.stt = null;
    // Utterance order: an older committed turn still waiting for its final
    // transcript would otherwise reach ICOS after this one.
    for (const older of this.turns.values()) {
      if (older === turn) break;
      if (older.phase === "capturing") this.discard(older, "a newer utterance was sent first");
    }
    void this.submit(turn);
  }

  /** Uncommitted audio may be lost — but never silently when a reason is given. */
  private discard(turn: Turn, why?: string): void {
    const stt = turn.stt;
    turn.stt = null;
    turn.phase = "discarded";
    turn.cancelSttTimer?.();
    if (stt) quietly(() => stt.cancel());
    if (why) {
      this.emit({
        type: "error",
        code: "TURN_DROPPED",
        retryable: false,
        turnId: turn.id,
        audioLost: true,
        message: `the utterance was not kept: ${why}`,
      });
    }
  }

  // --- cognitive + output side ---------------------------------------------

  private async submit(turn: Turn): Promise<void> {
    turn.retried ||= turn.phase === "failed";
    turn.phase = "committing";
    // A new turn supersedes whatever ICOS was still saying.
    if (this.response) this.interrupt("BARGE_IN");
    turn.interruptedTurnId ??= this.lastInterruptedTurnId;
    this.lastInterruptedTurnId = undefined;
    const response: Response = {
      turn,
      abort: new AbortController(),
      tts: null,
      audioSeq: 0,
      stopped: false,
      textDone: false,
    };
    this.response = response;
    let events: AsyncIterable<CognitiveEvent>;
    // Wait for the previous turn's acceptance: it may create the conversation.
    const attempt = this.acceptance.then(() =>
      this.withAcceptTimeout(
        response,
        this.deps.cognitive.submitTurn(
          {
            conversationId: this.conversationId,
            userId: this.ownerUserId,
            voiceSessionId: this.id,
            turnId: turn.id,
            text: turn.text ?? "",
            language: turn.language ?? this.hello.language,
            speechStartedAt: turn.t.voiceStart ?? turn.t.firstAudio ?? 0,
            speechEndedAt: turn.t.speechEnd ?? turn.t.final ?? 0,
            ...(turn.interruptedTurnId ? { interruptedTurnId: turn.interruptedTurnId } : {}),
          },
          response.abort.signal,
        ),
      ),
    );
    this.acceptance = attempt.catch(() => {});
    try {
      const accepted = await attempt;
      events = accepted.events;
      this.conversationId = accepted.conversationId;
    } catch (error) {
      turn.phase = "failed";
      if (this.response === response) this.response = null;
      const unavailable = error instanceof CognitiveUnavailableError;
      return this.emit({
        type: "error",
        code: unavailable
          ? "COGNITIVE_UNAVAILABLE"
          : error instanceof AcceptTimeout
            ? "COGNITIVE_TIMEOUT"
            : "COGNITIVE_ERROR",
        retryable: true,
        turnId: turn.id,
        text: turn.text ?? "",
        message: unavailable
          ? "ICOS could not accept this turn; it was not recorded — resend it"
          : "ICOS did not confirm this turn; resending it is safe (idempotent)",
      });
    }
    turn.phase = "accepted";
    this.emit({ type: "turn_accepted", turnId: turn.id, conversationId: this.conversationId! });
    if (response.abort.signal.aborted) return; // interrupted while being accepted

    let streamedText = false;
    const armIdle = () => {
      response.cancelTimer?.();
      response.cancelTimer = this.deps.setTimer(
        () =>
          this.timeOut(
            response,
            "COGNITIVE_TIMEOUT",
            "ICOS stopped answering; the turn itself is recorded",
          ),
        this.deps.timeouts.responseIdleMs,
      );
    };
    armIdle();
    try {
      for await (const event of events) {
        if (response.abort.signal.aborted) break;
        armIdle();
        turn.t.firstCognitive ??= this.deps.now();
        switch (event.type) {
          case "TEXT_DELTA":
            streamedText = true;
            this.emit({ type: "response_delta", turnId: turn.id, text: event.text });
            this.speak(response, event.text);
            break;
          case "ACTION_EVENT":
          case "MISSION_EVENT":
          case "APPROVAL_EVENT":
            this.emit({
              type: "response_event",
              turnId: turn.id,
              kind: event.type,
              payload: event.payload,
            });
            break;
          case "FINAL_RESPONSE":
            this.emit({ type: "response_final", turnId: turn.id, text: event.text });
            if (!streamedText) this.speak(response, event.text);
            response.textDone = true;
            this.finishTts(response);
            break;
          case "ERROR":
            this.emit({
              type: "error",
              code: "COGNITIVE_ERROR",
              retryable: false,
              turnId: turn.id,
              message: "ICOS failed while answering; the turn itself is recorded",
            });
            break;
        }
        if (response.textDone || event.type === "ERROR") break;
      }
    } catch {
      if (!response.abort.signal.aborted) {
        this.emit({
          type: "error",
          code: "COGNITIVE_ERROR",
          retryable: false,
          turnId: turn.id,
          message: "the response stream broke; the turn itself is recorded",
        });
      }
    }
    // After FINAL the timer is already the TTS tail watchdog: keep it.
    if (!response.textDone) response.cancelTimer?.();
    if (response.abort.signal.aborted) return;
    if (!response.textDone) {
      response.textDone = true;
      this.finishTts(response); // stream ended without FINAL_RESPONSE: speak what we have
    }
    if (!response.tts) this.endResponse(response); // otherwise TTS "done" ends it
  }

  private speak(response: Response, text: string): void {
    if (response.stopped || !this.deps.tts || !text) return;
    if (!response.tts) {
      try {
        const tts = this.deps.tts.start(
          { language: response.turn.language ?? this.hello.language },
          (e) => this.onTts(response, e),
        );
        if (response.stopped) return quietly(() => tts.cancel()); // failed while starting
        response.tts = tts;
      } catch (error) {
        return this.onTts(response, { type: "error", message: errorText(error) });
      }
    }
    try {
      response.tts.text(text);
    } catch (error) {
      this.onTts(response, { type: "error", message: errorText(error) });
    }
  }

  private finishTts(response: Response): void {
    if (!response.tts) return;
    this.armTtsTail(response);
    try {
      response.tts.finish();
    } catch (error) {
      this.onTts(response, { type: "error", message: errorText(error) });
    }
  }

  private onTts(response: Response, event: TtsEvent): void {
    // The generation guard: a cancelled/stale TTS stream never plays again.
    if (response.stopped || this.response !== response) return;
    if (event.type === "audio") {
      response.turn.t.firstTtsAudio ??= this.deps.now();
      if (response.textDone) this.armTtsTail(response);
      this.emit({
        type: "audio",
        turnId: response.turn.id,
        seq: response.audioSeq++,
        mime: event.mime,
        data: Buffer.from(event.data).toString("base64"),
      });
    } else if (event.type === "done") {
      if (response.textDone) this.endResponse(response);
    } else {
      this.emit({
        type: "error",
        code: event.timeout ? "TTS_TIMEOUT" : "TTS_UNAVAILABLE",
        retryable: true,
        turnId: response.turn.id,
        message: "speech synthesis failed; the answer continues as text",
      });
      this.stopAudio("TTS_FAILED", response);
      if (response.textDone) this.endResponse(response);
    }
  }

  /** Stop audio now: cancel TTS, tell the client to flush its playback buffer. */
  private stopAudio(reason: PlaybackStopReason, response = this.response): void {
    if (!response || response.stopped) return;
    response.stopped = true;
    response.cancelTimer?.();
    const tts = response.tts;
    response.tts = null;
    if (tts) quietly(() => tts.cancel());
    this.emit({ type: "playback_stop", turnId: response.turn.id, reason });
  }

  private interrupt(reason: CognitiveInterruptReason): void {
    const response = this.response;
    if (!response) return;
    this.stopAudio(
      reason === "SESSION_CLOSED" ? "DETACHED" : reason === "TIMEOUT" ? "TIMEOUT" : reason,
      response,
    );
    response.abort.abort(reason);
    this.lastInterruptedTurnId = response.turn.id;
    this.endResponse(response);
  }

  private armTtsTail(response: Response): void {
    response.cancelTimer?.();
    response.cancelTimer = this.deps.setTimer(() => {
      if (response.stopped || this.response !== response) return;
      this.emit({
        type: "error",
        code: "TTS_TIMEOUT",
        retryable: true,
        turnId: response.turn.id,
        message: "speech synthesis stalled; the answer is complete as text",
      });
      this.stopAudio("TIMEOUT", response);
      this.endResponse(response);
    }, this.deps.timeouts.ttsTailMs);
  }

  /** The runtime went silent mid-response: stop waiting, keep the session usable. */
  private timeOut(response: Response, code: "COGNITIVE_TIMEOUT", message: string): void {
    if (this.response !== response) return;
    this.emit({ type: "error", code, retryable: false, turnId: response.turn.id, message });
    this.stopAudio("TIMEOUT", response);
    response.abort.abort("TIMEOUT");
    this.endResponse(response);
  }

  private withAcceptTimeout<T>(response: Response, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const cancel = this.deps.setTimer(() => {
        // A later acceptance is harmless: resending the turn id is idempotent.
        response.abort.abort("TIMEOUT");
        reject(new AcceptTimeout("acceptance timed out"));
      }, this.deps.timeouts.acceptMs);
      work.then(
        (value) => (cancel(), resolve(value)),
        (error: unknown) => (cancel(), reject(error)),
      );
    });
  }

  private endResponse(response: Response): void {
    if (this.response !== response) return;
    this.response = null;
    response.cancelTimer?.();
    if (response.turn.phase !== "accepted") return; // no latency for a turn never accepted
    const t = response.turn.t;
    const retried = response.turn.retried;
    const d = (a?: number, b?: number) => (a === undefined || b === undefined ? null : b - a);
    const metrics: TurnLatency = {
      turnId: response.turn.id,
      simulated:
        this.deps.stt.simulated || this.deps.cognitive.simulated || !!this.deps.tts?.simulated,
      // Only a server-side detector sees audio before voice start; with client
      // VAD / push-to-talk the start precedes the frames and mic→VAD is a client number.
      firstAudioToVoiceStartMs:
        t.firstAudio !== undefined && t.voiceStart !== undefined && t.voiceStart >= t.firstAudio
          ? t.voiceStart - t.firstAudio
          : null,
      voiceStartToFirstPartialMs: d(t.voiceStart, t.firstPartial),
      speechEndToFinalMs: d(t.speechEnd, t.final),
      finalToFirstCognitiveEventMs: retried ? null : d(t.final, t.firstCognitive),
      firstCognitiveEventToFirstTtsAudioMs: d(t.firstCognitive, t.firstTtsAudio),
      speechEndToFirstAudioMs: retried ? null : d(t.speechEnd, t.firstTtsAudio),
    };
    this.metrics.push(metrics);
    if (this.metrics.length > MAX_METRICS) this.metrics.shift();
    this.emit({ type: "turn_metrics", metrics });
  }

  private emit(message: ServerMessage): void {
    const send = this.send;
    if (!send) return;
    try {
      send(message);
    } catch {
      this.detach(send); // a throwing transport is a dead transport
    }
  }

  private touch(): void {
    this.lastActivity = this.deps.now();
  }
}

/** One authenticated transport connection. The first message must be `hello`. */
export type VoiceConnection = {
  receive(raw: unknown): void;
  close(): void;
};

/**
 * In-process registry of live voice sessions, keyed by id and bound to the
 * authenticated user who opened them.
 * ponytail: single-process Map; a multi-instance deployment needs sticky
 * routing or a shared session store — sessions are cheap to lose by design.
 */
export class VoiceSessionRegistry {
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly deps: ResolvedDeps;

  constructor(deps: VoiceDeps) {
    this.deps = {
      now: Date.now,
      newId: () => crypto.randomUUID(),
      idleTtlMs: 120_000,
      setTimer: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return () => clearTimeout(handle);
      },
      ...deps,
      timeouts: { ...DEFAULT_VOICE_TIMEOUTS, ...deps.timeouts },
    };
  }

  get(sessionId: string): VoiceSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Drops expired sessions. Call periodically from the transport host. */
  sweep(): void {
    for (const [id, session] of this.sessions) {
      if (session.expired) {
        session.close();
        this.sessions.delete(id);
      }
    }
  }

  /** `userId` comes from the transport's server-side auth, never from the client. */
  connect(userId: string, send: Send): VoiceConnection {
    let session: VoiceSession | null = null;
    return {
      receive: (raw) => {
        const parsed = ClientMessageSchema.safeParse(raw);
        if (!parsed.success) {
          return send(protocolError("INVALID_MESSAGE", "malformed voice message"));
        }
        const message = parsed.data;
        if (message.type === "hello") {
          const previous = session;
          session = this.open(userId, message, send);
          // This connection abandoned its previous session: don't leave it lingering.
          if (previous && previous !== session) previous.close();
          return;
        }
        if (!session?.isAttachedTo(send))
          return send(protocolError("NOT_READY", "send hello first"));
        session.handle(message);
      },
      close: () => session?.detach(send),
    };
  }

  private open(
    userId: string,
    hello: Extract<ClientMessage, { type: "hello" }>,
    send: Send,
  ): VoiceSession | null {
    this.sweep();
    if (hello.sessionId) {
      const existing = this.sessions.get(hello.sessionId);
      if (existing && existing.ownerUserId !== userId) {
        send(protocolError("SESSION_FORBIDDEN", "not your voice session"));
        return null;
      }
      if (existing) {
        existing.attach(send, true);
        return existing;
      }
      send({
        type: "error",
        code: "SESSION_EXPIRED",
        retryable: false,
        message: "voice session expired; a new one was opened — send conversationId to continue",
      });
    }
    const mine = [...this.sessions.values()].filter((s) => s.ownerUserId === userId);
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER + 1))) {
      old.close();
      this.sessions.delete(old.id);
    }
    const session = new VoiceSession(this.deps, userId, this.deps.newId(), hello);
    this.sessions.set(session.id, session);
    session.attach(send, false);
    return session;
  }
}

function protocolError(
  code: "INVALID_MESSAGE" | "NOT_READY" | "SESSION_FORBIDDEN",
  message: string,
): ServerMessage {
  return { type: "error", code, retryable: false, message };
}

/** Oldest sessions of a user beyond this are closed (Map keeps insertion order). */
const MAX_SESSIONS_PER_USER = 5;

/** Provider cleanup must never break the state machine. */
function quietly(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignored: the stream is being abandoned anyway
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
