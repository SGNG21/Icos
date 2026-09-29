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

## Gaps (not done here)

- **WebSocket binding**: needs an authorised dependency (`ws`) or a custom server hosting
  `VoiceSessionRegistry` — the owner decides.
- **Real STT/TTS adapters**: none exists locally; provider choice is a budget/privacy decision.
- **Cognitive Runtime adapter**: `CeoApplicationService` is blocking and not idempotent on a
  turn id, so it cannot back the port honestly.
- **Client**: mic capture (AudioWorklet/PCM16 or Opus), playback buffer that honours
  `playback_stop`, PWA manifest/service worker, iOS Safari user-gesture audio unlock.
- **Scale**: the registry is in-process; multiple instances need sticky routing.
- **Timeouts**: no deadline yet on an STT final after commit, a TTS `done`, or a hung
  acceptance (which, being serialized, would block later turns). Needs a timer policy.
- **Rate limiting** of messages per connection belongs to the transport.
- **Tenancy**: identity has no tenant key yet; sessions are keyed by user.
