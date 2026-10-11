# 0074: Premium voice is an ICOS TTS router above OmniRoute, behind the existing TTS port

## Status

Proposed (branch `feat/tts-router-fish-elevenlabs`, base `dec9fcb`). Numbering note: authored as 0074
because 0072 and 0073 are already referenced elsewhere; integration assigns the final number, as it
did for 0061.

## Context

Voice works end to end (decision 0061): mic → STT → Cognitive Runtime → text → TTS → browser. Audit of
`dec9fcb`:

- **One canonical TTS port already exists**: `TtsProvider.start() → TtsStream { text, finish, cancel }`
  in `src/core/voice/contracts.ts`. `VoiceSession` drives it per response and already owns barge-in,
  `playback_stop`, a generation guard (a stopped response's TTS output is dropped), a TTS tail
  watchdog, and "TTS failed → `TTS_UNAVAILABLE`, the answer continues as text".
- **One adapter**: `OmniRouteTts` → OmniRoute `/v1/audio/speech`, model `ICOS_VOICE_TTS_MODEL`
  (deployed example `gtts/fr`), `voice` = 2-letter session language, MP3, one request per sentence,
  sequential. No fallback, no circuit breaker, no TTS-specific metrics beyond `TurnLatency`.
- **OmniRoute 3.8.49 (installed on the VPS)** has a speech registry that includes `fishaudio`,
  `elevenlabs`, `edgetts` and `gtts`. It resolves ONE provider per request from `provider/model`, has
  no TTS fallback or circuit breaking, maps `voice` to Fish's `reference_id` / ElevenLabs' path voice id,
  and forwards no ElevenLabs `voice_settings`, `language_code` or `output_format`, and no Fish `latency`.
- Decision 0071 makes OmniRoute the only routing authority for **compute** (LLM workers). Speech
  synthesis is not a compute candidate: no worker, no ledger stage. Decision 0061 put voice providers
  behind OmniRoute because it was the only gateway at hand.

## Decision

1. **Option B — an ICOS TTS router above OmniRoute; OmniRoute is one adapter below it.** OmniRoute does
   not own speech fallback, so there is no router to extend; ICOS already owns an explicit TTS port.
   `TtsRouter` (`src/server/voice/tts/tts-router.ts`) **implements that same `TtsProvider` port** —
   there is no second TTS abstraction above the session, and nothing above the router names a vendor.
2. **Below the router, a per-chunk `SpeechSynthesizer` port** (`synthesizer.ts`): `synthesize(text,
language, signal) → { mime, body: AsyncIterable<bytes> }`, optional `probe()`. Adapters:
   - `fish` — `FishAudioSynthesizer`, direct, `POST https://api.fish.audio/v1/tts` (streaming);
   - `elevenlabs` — `ElevenLabsSynthesizer`, direct, `POST …/v1/text-to-speech/{voice}/stream`;
   - `edge` and `gtts` — `OmniRouteSpeech` through the existing gateway.
     Premium vendors are called directly because the gateway drops the controls a premium voice needs
     (voice settings, latency mode, output format). Base URLs are constants; keys are server-side env;
     the provider set is an allowlist (`fish | elevenlabs | edge | gtts`).
3. **Routing** — configured order (default `fish,elevenlabs,edge,gtts`; `ICOS_VOICE_TTS_PROVIDER`
   moves a primary to the head). Per chunk: first provider whose circuit admits a request and returns
   audio wins. **Fallback by failure class**:

   | class                                       | from        | retry same provider                     | fall back                           | circuit                                 |
   | ------------------------------------------- | ----------- | --------------------------------------- | ----------------------------------- | --------------------------------------- |
   | `ABORTED` (barge-in, stale turn, hangup)    | cancel      | never                                   | **never**                           | not counted                             |
   | `AUTH_FAILED` (401/403/402)                 | HTTP        | no                                      | yes                                 | opens at once, long cooldown            |
   | `CONFIG_INVALID` (404 voice/model)          | HTTP        | no                                      | yes                                 | opens at once, long cooldown            |
   | `RATE_LIMITED` (429)                        | HTTP        | no                                      | yes                                 | counted; Retry-After honoured (bounded) |
   | `TIMEOUT` (no first byte / total / 408/504) | timer, HTTP | no                                      | yes                                 | counted                                 |
   | `UPSTREAM` (5xx, non-audio 200, empty body) | HTTP        | bounded (`ICOS_TTS_RETRIES`, default 1) | yes                                 | counted                                 |
   | `UNAVAILABLE` (network)                     | fetch       | bounded                                 | yes                                 | counted                                 |
   | `INVALID_REQUEST` (400/422)                 | HTTP        | no                                      | **no** — not resent to every vendor | counted                                 |

   Once a fallback provider has spoken, the rest of that answer stays on it (one answer, one voice);
   the next answer starts again at the primary. All providers failing on a chunk loses THAT chunk
   only (a non-fatal `error`, `fatal: false`): the stream goes on, in order, and never flushes the
   client queue. The session gives one verdict when the answer ends — `TTS_DEGRADED` if something
   was spoken, `TTS_UNAVAILABLE` if nothing was; the text answer is unaffected. No loop: each chunk
   visits each provider once.

4. **Circuit breaker per provider** (closed → open after N counted failures → half-open single trial
   after cooldown → closed on success). It only removes one provider for a while; it never disables
   TTS. Abort is neutral.
5. **Health is evidence, not configuration.** States `NOT_CONFIGURED | UNVERIFIED | READY | DEGRADED |
RATE_LIMITED | AUTH_FAILED | UNAVAILABLE | TIMEOUT`. A key alone is `UNVERIFIED`. Evidence comes from
   real requests and a bounded probe (Fish `GET /model/{reference_id}`, ElevenLabs
   `GET /v1/voices/{id}` — no synthesis, no billed characters; 5 s timeout; cached 60 s). The voice host
   probes once at start-up. A probe never opens a circuit: only real requests route traffic away.
6. **Streaming** — provider HTTP bodies are consumed as streams (TTFB measured on the first byte,
   abort stops the download), and the answer is synthesized progressively by semantic chunk while the
   LLM is still streaming. Each chunk reaches the browser as ONE independently decodable audio message
   (the existing wire contract: the browser decodes each message with `decodeAudioData`). Byte-level
   streaming to the browser (MSE / AudioWorklet PCM) is deliberately not part of this change.
7. **Speech rendering** (`speech-text.ts`) — one answer, two renderings: the displayed text is
   untouched; the spoken copy drops code blocks, URLs, markdown, machine ids and `SCREAMING_SNAKE`
   codes, turns lists into enumerations, and collapses punctuation. `SpeechChunker` cuts at sentence
   boundaries (abbreviation-, decimal- and URL-safe), merges to `minChars` (40; first chunk 20 for
   earlier first audio), splits beyond `maxChars` (220) at `, ; :` or a space, and holds an open code
   fence until it closes.
8. **Stale audio** — every `audio` / `playback_stop` message carries `generation` (monotonic per
   session, one per response) next to `turnId` and `seq`. The browser's `PlaybackGate` plays a chunk
   only if its turn is not silenced, its generation is current, its seq is new and in order, and no
   newer turn has started speaking. `TtsStream.cancel(reason)` aborts synthesis; nothing falls back.
9. **Observability & cost** — events `tts.requested | tts.provider.selected | tts.first_audio |
tts.completed | tts.chunk_lost | tts.failed | tts.fallback | tts.aborted` as JSON lines (typed allowlist: ids,
   provider/model/voice, circuit state, timings, raw usage; never text, audio, keys, URLs or bodies).
   `TurnLatency` gains `ttsProvider` / `ttsFallbackUsed` (beside `tts` / `ttsSentencesLost`); `speechEndToFirstAudioMs` already is
   END_OF_USER_TO_FIRST_AUDIO. Usage (requests, characters, bytes, retries, fallbacks) is raw; no price
   is computed — the pricing registry (decision 0067) holds no verified TTS prices.

## Consequences

- Without Fish/ElevenLabs configuration the router contains only the OmniRoute provider(s): the
  current voice path keeps working (chunks are now merged to ≥ 40 characters, so fewer gTTS requests).
- Two new outbound vendors receive assistant text. Under `AI-DATA-001` (provider must be approved for
  the data class) the owner's request is the approval for voice output; operators must not enable them
  for tenants whose data class forbids it. This is the main governance item for integration review.
- Fish/ElevenLabs request shapes match OmniRoute's own adapters (same endpoints and fields) plus the
  documented premium knobs; they and both probe endpoints still need one live verification with real
  credentials — not done here (no credentials in this lane).

## Not done (explicit)

- Browser-reported `first_audio_played_at` (no client→server metric message exists yet).
- Generated-audio duration (needs MP3 frame parsing; bytes are recorded instead).
- Byte-level streaming playback in the browser.
- Persisted TTS usage (in-memory per process + log lines only; no migration).
