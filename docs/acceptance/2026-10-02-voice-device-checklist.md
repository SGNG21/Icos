# Voice — real-device acceptance checklist (Xiaomi / Android Chrome)

**Status: NOT EXECUTED.** Nothing below has been run on a device. Every line is a step for
Geoffrey to perform; this file is the protocol, not the result. `VOICE_DEVICE_VERIFIED=NO`
until the result column is filled in by someone holding the phone.

The reason this file exists rather than a claim: the continuous session is proven as a pure
state machine (26 tests) and the mic/VAD/barge-in path is proven by construction, but
nothing in a test harness can tell you whether echo cancellation on _this_ handset stops
ICOS from interrupting himself, or whether the browser keeps the mic open when the screen
dims. Those are device facts.

## Preconditions

| #   | Requirement                                                   | Why it is load-bearing                                                                                                                                                                                   |
| --- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Served over **HTTPS** (or `localhost`)                        | `getUserMedia` is unavailable on an insecure origin. The UI says so explicitly (`INSECURE_CONTEXT`), but the session simply cannot open.                                                                 |
| P2  | Logged in, `tasks.write` permission                           | The voice socket authorises at upgrade; a 403 closes the link and the screen shows DEGRADED.                                                                                                             |
| P3  | STT **and** TTS providers configured                          | Without them the server closes with 1011 and a reason, and the phase is ERROR with that reason shown. A simulated provider makes every latency number meaningless — check the diagnostics panel says so. |
| P4  | `ICOS_CONVERSATION_MAX_TOTAL_TOKENS` sized for a real session | Conversation has its own budget. Exhausting it denies the next turn; that is correct, and it will look like ICOS going quiet.                                                                            |

## Acceptance A — continuous session, no intermediate tap

| #   | Step                                               | Expected                                                                                                   | Result |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------ |
| A1  | Open ICOS on the phone, `/voice`                   | Phase **OFF**, "Micro fermé", one large button                                                             |        |
| A2  | Tap the button **once**                            | Permission prompt, then **CONNECTING** → **LISTENING**, "Micro ouvert"                                     |        |
| A3  | Say "Bonjour ICOS"                                 | **USER_SPEAKING** while talking, **THINKING** ~0.7 s after you stop (that is the VAD hangover, not lag)    |        |
| A4  | Wait                                               | **ICOS_SPEAKING**, audio plays                                                                             |        |
| A5  | Wait for him to finish                             | **LISTENING** again, **without touching the screen**                                                       |        |
| A6  | Ask a second question, still not touching          | Full turn completes                                                                                        |        |
| A7  | **Interrupt him mid-sentence**                     | Audio stops **immediately**; **INTERRUPTED** → **USER_SPEAKING**; your new utterance becomes the next turn |        |
| A8  | Pause ~30 s without speaking                       | Session stays **LISTENING**. It must NOT close.                                                            |        |
| A9  | Tap the button once                                | **OFF**, "Micro fermé", phone mic indicator off                                                            |        |
|     | **PASS requires zero mic taps between A2 and A9.** |                                                                                                            |        |

## Acceptance B — text ↔ voice continuity

| #   | Step                                                                                                      | Expected                 | Result |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------ | ------ |
| B1  | Type a message in the same conversation                                                                   | Answer arrives           |        |
| B2  | Switch to voice, refer to what you typed ("et pour le point précédent ?")                                 | ICOS has the context     |        |
| B3  | Type again, referring to what you said                                                                    | Context still continuous |        |
|     | Proven server-side on real PostgreSQL (`V6`), so a failure here is a UI/session-id bug, not a memory bug. |                          |        |

## Acceptance C — "Améliore ICOS" reaches the canonical path

| #   | Step                      | Expected                                                                    | Result |
| --- | ------------------------- | --------------------------------------------------------------------------- | ------ |
| C1  | Say "ICOS, améliore-toi." | Spoken reply, **no raw JSON**                                               |        |
| C2  | If it implies work        | An **approval card** appears; ICOS explains in words why approval is needed |        |
| C3  | Approve                   | A SELF_IMPROVEMENT goal is created, Chief delegates to **brain-evolution**  |        |
| C4  | Ask "où en est LDS ?"     | Answered as **conversation**. No goal, no mission, no approval card.        |        |

## Acceptance D — wake word

**Expected result: the toggle is visible and DISABLED, reading "Aucun moteur local installé".**
No engine ships. If the toggle can be armed, that is a defect — an armed switch that detects
nothing is the interface lie this design exists to prevent. `WAKE_WORD_PROVEN=NO`.

## Device-specific things to watch, and what they would mean

| Observation                                    | Likely cause                                                                                           | Where to look                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| ICOS interrupts himself constantly             | Echo cancellation not applied; his own voice wakes the VAD                                             | `getUserMedia` constraints in `voice-client.tsx`; try headphones to confirm         |
| Turns fire on background noise                 | `startThreshold` too low for this room                                                                 | `DEFAULT_VAD` in `features/voice/vad.ts`                                            |
| Words clipped at the start                     | `minSpeechMs` too long                                                                                 | same                                                                                |
| Turn ends mid-sentence                         | `hangoverMs` too short for your speaking rhythm                                                        | same                                                                                |
| Session dies when the screen dims              | Android suspended the tab                                                                              | Expected on Android; keep the screen on. No code change can override it from a tab. |
| **LISTENING shown with the mic indicator off** | **A real defect — report it.** The phase is derived from the live track, so this should be impossible. | `voice-session-machine.ts`                                                          |

## Latency, if you want numbers

The diagnostics panel shows the server-observed per-turn timings. Four of the five the spec
asks for are measured (`voiceStartToFirstPartialMs`, `speechEndToFinalMs`,
`finalToFirstCognitiveEventMs`, `speechEndToFirstAudioMs`). There is **no single
turn-total** figure, and `simulated: true` means the numbers describe a fake provider, not a
real one.
