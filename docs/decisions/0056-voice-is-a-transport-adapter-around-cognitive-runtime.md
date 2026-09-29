# 0056: Voice is a transport adapter around the Cognitive Runtime

## Status

Accepted (foundation). The transport binding and real providers are pending; see Gaps.

## Context

ICOS should be spoken to naturally: mic → VAD/turn detection → streaming STT → Cognitive Runtime
→ streamed events → streaming TTS → playback, with barge-in, cancellation, reconnect and low
latency.

Audit of committed code at `e652469`:

- **No realtime transport.** There is no WebSocket, SSE or `ReadableStream` response anywhere in
  `src/`. Next.js 16 route handlers cannot accept a WebSocket upgrade without an added dependency
  (`ws`, `@vercel/functions`) or a custom server.
- **No audio.** No `getUserMedia`, `AudioContext`, `MediaRecorder`, speech API, PWA manifest or
  service worker.
- **"Ask ICOS" is blocking.** `POST /api/conversation` → `CeoApplicationService.handleUserMessage`
  → OmniRoute, one JSON reply. There is no streaming, no turn idempotency key and no cancellation.
- **Reusable:** `protectRoute` (server-side auth + audit), zod contracts, `AbortController`
  cancellation (already used by execution/review), the conversation repositories.
- The Cognitive Runtime lane (`feat/cognitive-runtime`) has no committed code yet.

## Decision

1. **The voice layer is an adapter, not a brain.** `VoiceSession` holds ephemeral transport state
   only. Conversation identity, turn durability, memory and reasoning belong to the Cognitive
   Runtime, behind `CognitiveRuntimePort` (`src/core/voice/contracts.ts`).
2. **One transport-neutral protocol** (`ClientMessageSchema` / `ServerMessage`): hello (new or
   resume), audio frames, turn signals, interrupt, cancel, heartbeat; transcripts, turn accepted,
   response deltas/events/final, audio chunks, playback stop, classified errors, turn metrics.
   It names no STT/TTS vendor. The target transport is a WebSocket authenticated by
   `protectRoute` at upgrade; the engine only needs `receive(raw)` and `send(message)`.
3. **The client owns the turn id.** Every speech segment carries a client-generated `turnId`
   and per-turn frame `seq`. That id is the idempotency key end to end: replayed frames are
   ignored, a turn commits once, and `submitTurn` must be idempotent on it. This is what makes
   reconnect safe.
4. **Committed means accepted downstream.** A turn is committed when the Cognitive Runtime
   resolves `submitTurn` (durable). Before that, audio may be lost (reported with
   `audioLost`). If the runtime is unavailable the client gets `COGNITIVE_UNAVAILABLE` with the
   turn id and text, and can resend with `TURN_COMMIT`; it is never dropped silently.
5. **Turn detection is signals, not a detector.** `VOICE_ACTIVITY_START/END` and `TURN_COMMIT`
   come from whatever detects them: a push-to-talk button (V1 default), client-side VAD
   (`auto_vad`: end-of-activity commits), a future server-side VAD or wake word. No wake word in V1.
6. **Barge-in** = `VOICE_ACTIVITY_START` of a new turn (or `interrupt`/`cancel`, or a new
   commit) while ICOS is responding: TTS is cancelled, `playback_stop` tells the client to flush
   its buffer, the response `AbortSignal` fires (`BARGE_IN` / `USER_CANCEL`), and the next
   turn carries `interruptedTurnId` so the runtime keeps context. A generation guard drops any
   TTS output from a stopped response.
7. **Failures are classified**: `STT_UNAVAILABLE` (uncommitted audio lost),
   `TTS_UNAVAILABLE` (the answer continues as text), `COGNITIVE_UNAVAILABLE` / `COGNITIVE_ERROR`,
   `SESSION_EXPIRED` (a new session on the same conversation), `SESSION_FORBIDDEN`. Network loss
   detaches the session: audio stops, capture in progress is dropped, the response continues
   downstream; a resume within the idle TTL (120 s) reattaches.
8. **Retention**: raw audio `none` (frames go to STT and are dropped), transcripts durable only
   as runtime turns, diagnostics = ids and timings. Session state never holds audio.
9. **Latency** is measured server-side with an injected clock per turn; a number is `null`
   when not observed, and `simulated: true` when any provider on the path is a fake.
10. **Sessions are bound to the authenticated user**; resuming someone else's session is refused.
    Every `CommittedTurn` carries that `userId`; the runtime must refuse a `conversationId` the
    user does not own (the client-supplied id is a claim, not an authority).
11. **Submissions are serialized** per session: a turn waits for the previous acceptance, so turns
    reach the runtime in order on one conversation.
12. **Nothing is dropped silently**: a superseded, empty or oversized utterance gets
    `TURN_DROPPED` (`audioLost`). A throwing transport detaches the session; a throwing provider
    is classified, never allowed to break the state machine.
13. **Bounds**: 200 remembered turn ids per session, ~10 MB of audio per turn, 5 sessions per
    user. Only _detached_ sessions expire; an attached session lives as long as its transport.

## Consequences

- Any transport, any STT/TTS and the real Cognitive Runtime plug in without touching the
  state machine. Deterministic SIMULATED providers (`src/server/voice/simulated-providers.ts`)
  prove the behaviour; they measure nothing real.
- The Cognitive Runtime must provide: idempotent durable acceptance per `turnId`, a streamed
  event iterable, and abort handling that never un-accepts a turn.

## Real path (second increment)

- **Transport**: `ws` added — Next.js 16 route handlers cannot accept an upgrade and Node has
  no WebSocket server. `pnpm voice:serve` (`scripts/voice-server.ts`) hosts the same Next app
  and adds `/api/voice/ws`; other upgrades (HMR) pass through to Next. Auth at upgrade through
  `protectRoute` (`tasks.write` + same origin — the gate of `POST /api/conversation`); ping/pong
  liveness; 128 KiB frame cap. `pnpm dev` / `pnpm start` are unchanged.
- **Providers**: OmniRoute (the gateway ICOS already uses). STT `/v1/audio/transcriptions`,
  request/response — partials are re-transcriptions of the growing utterance. TTS
  `/v1/audio/speech`, one request per completed sentence, MP3 chunks. Models are configuration
  (`ICOS_VOICE_STT_MODEL`, `ICOS_VOICE_TTS_MODEL`); unset = `NOT_CONFIGURED`, the client is told.
  Audited 2026-09-29: `groq/whisper-large-v3-turbo` works (0.3–0.5 s); OpenRouter models have no
  credits; NVIDIA ASR/TTS return 404; OpenAI/ElevenLabs have no credentials; of the TTS
  providers only `gtts/fr` answers (Google Translate TTS through OmniRoute: free, unofficial,
  modest quality — replace when a paid voice is budgeted).
- **Cognitive Runtime**: no committed API exists (`feat/cognitive-runtime` has no commits;
  Cockpit's BR-28 `POST /api/ask/turns` is a proposal). `ConversationCognitiveAdapter` is a
  **temporary** bridge over the existing conversation store + OmniRoute CEO brain. Honest limits:
  idempotency per process, one shared CEO conversation (no ownership column — same as the text
  path), a single FINAL event (no streaming), interrupt stops the voice but the brain's answer is
  still stored. Replace it with the runtime's adapter; the session engine does not change.
- **Watchdogs**: STT final after end of speech (15 s), runtime acceptance (15 s), silence between
  runtime events (90 s; 130 s for the CEO brain), TTS tail after the text is complete (20 s);
  provider requests time out at 20 s. Each is classified (`STT_TIMEOUT`, `COGNITIVE_TIMEOUT`,
  `TTS_TIMEOUT`); an acceptance timeout releases the serialized queue, so a hung request never
  blocks later turns, and a later acceptance is harmless (turn ids are idempotent).
- **Review hardening**: the socket re-checks authorization every heartbeat (logout, revocation
  or a lost permission closes it with 4403); 100 messages/s per connection (1008); a socket reset
  during auth is not an uncaught error; a new utterance drops older uncommitted captures (and
  their audio buffers); turns commit in utterance order (an older turn whose final arrives late
  is `TURN_DROPPED`, never answered after a newer one); partials stop after 15 s of speech (each
  re-uploads the utterance); the adapter keys idempotency on user + turn id.
- **Client**: `/voice`, mobile-first, tap to talk / tap to send, AudioWorklet capture → 16 kHz
  PCM16 frames, ordered MP3 playback, local stop on barge-in plus server `playback_stop`,
  reconnect with backoff and session resume. The audio context is created inside the tap (iOS
  unlock); the mic stream lives for one utterance only; the worklet is a same-origin file
  (`public/icos-voice-tap.js`), not a `blob:` URL; a refused upgrade is diagnosed over HTTP
  (401 → login, 403 → voice unavailable) instead of retrying forever; failed turns can be resent.

## Gaps (not done here)

- **Phone reachability**: a phone grants the microphone only to a secure origin. The host
  supports TLS (`ICOS_VOICE_TLS_CERT` / `ICOS_VOICE_TLS_KEY`) or a TLS proxy such as
  `tailscale serve` (installed on the host, stopped). Not done here: it needs the owner's
  account or certificate.
- **Real Cognitive Runtime** adapter (streaming, durable turn ids, ownership).
- **PWA** manifest / service worker: app-wide files owned by the Cockpit lane.
- **Scale**: the registry is in-process; multiple instances need sticky routing.
- **Rate limiting** of messages per connection belongs to the transport.
- **Tenancy**: identity has no tenant key yet; sessions are keyed by user.
