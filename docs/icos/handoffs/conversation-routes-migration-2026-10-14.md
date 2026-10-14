# Conversation routes — operator migration (2026-10-14)

Branch `feat/fable-safe-conversation-routes`. **Nothing live changes with this branch**: no env,
no service, no OmniRoute setting was touched. This note says what to set BEFORE deploying it.

Owner decision: no fallback to a possibly paid model without explicit authorisation and budget;
do not break the conversation paths arbitrarily; plan a migration and a safe fallback.

## The two conversation paths

| Path                                                           | Code                                                                  | Model before                                                                                                                                                          | Model after                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CEO chat (`CeoApplicationService`, `/api/ceo`)                 | `src/server/services/omniroute-ceo-client.ts`                         | `ICOS_CEO_MODEL` ?? `ICOS_REVIEWER_MODEL`; if neither, `auto/best-chat` if listed by `GET /v1/models`, else **the first listed id**; on any error, `auto/nvidia-chat` | `ICOS_CONVERSATION_MODELS` (ordered list); else `ICOS_CEO_MODEL` ?? `ICOS_REVIEWER_MODEL` **alone**; else the measured free default `nvidia/nvidia/nemotron-3-super-120b-a12b` → `nvidia/nvidia/nemotron-3-ultra-550b-a55b`                          |
| Cognitive runtime, text and voice (`OmniRouteCognitionEngine`) | `src/server/cognitive/cognition.ts`, `src/core/cognitive/workload.ts` | `ICOS_COGNITIVE_MODEL[_FAST/_DEEP/_VOICE]` ?? `ICOS_CEO_MODEL`; no fallback; nothing set = NOT_CONNECTED                                                              | same per-class model first, then **only** the entries of `ICOS_CONVERSATION_MODELS`; if `ICOS_COGNITIVE_MODEL` and `ICOS_CEO_MODEL` are unset, the first entry of `ICOS_CONVERSATION_MODELS` is the default; nothing set = NOT_CONNECTED (unchanged) |

Fallback happens **only** on HTTP 429, HTTP 5xx or a timeout, and only to the next listed model.
A 4xx, a budget refusal (`BudgetDeniedError`) or a user cancellation is surfaced at once. When the
list is spent the call throws `ConversationModelsExhaustedError`
(`CONVERSATION_MODELS_EXHAUSTED: <model> → <failure> | …`), which the existing layers already
report: the CEO chat answers "Le cerveau ICOS est indisponible : …", the cognitive runtime marks
the turn failed with that reason. Every fallback logs `CONVERSATION_MODEL_FALLBACK` on stderr.

Time budgets are not extended: CEO 60 s per attempt, 120 s in total (the old primary + fallback
pair); cognition 90 s in total (the voice transport waits 130 s), 45 s per attempt when a fallback
exists, 90 s when there is none.

## What is refused at startup

`loadEnv()` (and the clients themselves) refuse a meta-route — `auto`, `auto/*`, their
`no-think/` / `claude/` aliases, `claude/combo/*`, and the provider-side automatic models such as
`openrouter/auto` (see `src/core/workers/meta-route.ts`) — in:

`ICOS_CONVERSATION_MODELS`, `ICOS_CEO_MODEL`, `ICOS_COGNITIVE_MODEL`, `ICOS_COGNITIVE_MODEL_FAST`,
`ICOS_COGNITIVE_MODEL_DEEP`, `ICOS_COGNITIVE_MODEL_VOICE` (and, already, `ICOS_REVIEWER_MODEL`,
`ICOS_PLANNER_MODEL`, `ICOS_AUTONOMY_ALLOWED_MODELS`).

`ICOS_CONVERSATION_MODELS` also refuses an empty entry (`a,,b`) and a duplicate. Errors are named:
`AUTO_COMBO_NOT_ADMISSIBLE:<VAR>` from the env schema, `CONVERSATION_MODEL_NOT_ADMISSIBLE:<VAR>`
from the clients.

**Risk to check before deploying**: if the live environment sets any of these variables to an
`auto/*` id today, the process will refuse to start until it is changed. That is intended (a loud
stop instead of a silent paid fallback), but it must be fixed in the env first.

## Operator steps

1. Read (without printing secrets) the conversation variables of the live env file:
   `grep -E '^(ICOS_(CEO|COGNITIVE|CONVERSATION)_MODEL|ICOS_COGNITIVE_MODEL_|ICOS_REVIEWER_MODEL)' <env file> | cut -d= -f1,2`.
2. Replace any meta-route value by a concrete id.
3. Set the explicit ordered list — recommended, free, measured 2026-10-14:

   ```
   ICOS_CONVERSATION_MODELS=nvidia/nvidia/nemotron-3-super-120b-a12b,nvidia/nvidia/nemotron-3-ultra-550b-a55b
   ```

   A paid model (`cc/…`, `codex/…`) is used only if the operator lists it here (or names it in
   `ICOS_CEO_MODEL` / `ICOS_COGNITIVE_MODEL*`), and its cost then lands in the conversation spend
   window (`spend.conversation`), capped per conversation.

4. Compatibility notes:
   - an explicitly configured `ICOS_CEO_MODEL` (or, failing it, `ICOS_REVIEWER_MODEL`) keeps being
     the CEO chat's model, but **alone**: the hidden `auto/nvidia-chat` fallback is gone. Set
     `ICOS_CONVERSATION_MODELS` to get a fallback;
   - when `ICOS_REVIEWER_MODEL` is set and nothing else is, the CEO chat keeps running on the
     reviewer's model, as before. Setting `ICOS_CONVERSATION_MODELS` decouples them;
   - a per-class `ICOS_COGNITIVE_MODEL_*` still wins for its class; the list only adds fallbacks.
5. Re-probe the listed models before relying on them (`pnpm compute:probe` or one manual call):
   the 2026-10-14 measurement ages (OpenRouter `:free` and Groq answered 502/429 that day).
6. Deploy, then check one CEO message and one cognitive turn; a `CONVERSATION_MODEL_FALLBACK` line
   on stderr means the first model failed and the second answered.

Rollback: revert the branch; the variables added here are ignored by the previous build (the old
`auto/best-chat` discovery comes back with it).

## Not covered here

- A gateway-side combo, pattern mapping or routing override bound to a concrete-looking id is not
  visible to a static rule. The metered proxy now logs `SPEND_MODEL_SUBSTITUTED` when the served
  model differs from the requested one (see the budget commit); it reports, it does not refuse.
- Which model actually answered a cognitive turn is not yet recorded in the turn's provenance
  (the engine label names the chain); the spend ledger records the served model per call.
