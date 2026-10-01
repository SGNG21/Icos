# 0062: ICOS's self-model is measured, not declared

## Status

Accepted. Implemented on `feat/phone-live-proof` in the same pass that fixed the phone cognition
and French-voice defects. Numbering follows 0061 (central integration order).

## Context

Live evidence from a real Xiaomi 13T over Tailscale, 2026-10-01. Asked what it was and what it
could do, ICOS answered that it is a persistent AI assistant which can answer, summarize, write
and suggest ideas; that it has **no external real-time access**; that it **cannot execute any
action itself**; and that **every action must be human-validated**.

Three of those are false or misleading as stated, and none of them was a measurement:

1. **The source was static prose.** `SYSTEM_PROMPT` in `src/server/cognitive/cognition.ts`
   contained `"Tu n'exécutes jamais rien toi-même"` and, of a mission proposal, `"Ce n'est qu'une
   proposition soumise à approbation humaine"`. ICOS was instructed to describe itself that way.
2. **No capability information reached the model at all.** A grep for capability/tool/worker terms
   in the prompt and in `context-assembler.ts` returned zero. With no capability context, the model
   filled the gap with a generic-assistant template — including "no external access", which nothing
   in ICOS had told it.
3. **The real approval policy is not "everything".** `decideExecution`
   (`src/core/authorization/decide.ts`) allows `read_only` and `reversible` actions with sufficient
   `authorizationLevel` and `approvalStatus: "not_required"` to proceed with **no** human approval;
   only `sensitive` always requires explicit human approval, and policy beats the declarative flag.
   The Tool Gateway adds the same floor: `effectiveApproval` forces human approval for `HIGH` and
   `CRITICAL` only (`src/core/tool-gateway/policy.ts`). Saying every action needs validation
   understates ICOS's autonomy and misrepresents its governance.

A second, related defect from the same session: after cognition was repaired, ICOS kept answering
"oui, je ne suis toujours pas connecté" for eight minutes. Its ContextSnapshot carried two pre-fix
assistant turns as `episodic` / `MODEL_INFERRED` items (score 0.70) and **nothing describing current
runtime state**. Stale self-description was the only self-knowledge available, so the model reported
it faithfully. Verified by a controlled A/B on the same question: in a conversation whose snapshot
contained zero NOT_CONNECTED items, the answer became "Oui, je fonctionne correctement."

Measured capability state of that same runtime, which is why honesty matters in both directions:
cognition, conversation, durable turns, memory, context assembly and the mission-proposal path were
all connected; `tool_grants`, `tool_connector_health`, `tool_executions`, `workers`, `agents`,
`skills` and `capabilities` were **all empty**, and `ICOS_TOOL_GATEWAY_CONFIG` was unset. So "I have
no external real-time access" was, in that runtime, **true** — not because of architecture, but
because nothing was registered. A fixed, optimistic capability list would have made ICOS overclaim.

## Decision

Capability is a property of the runtime, so the self-description is assembled from the runtime on
every turn and handed to the model as context. The prompt stops asserting capability.

1. **Five explicit states** (`src/core/cognitive/self-model.ts`): `AUTONOMOUS` (allowed now, no
   human approval), `GOVERNED` (executable only through Tool Gateway / Workforce / CORE3),
   `APPROVAL_REQUIRED` (policy really requires approval), `NOT_CONNECTED` (architecturally
   supported, unavailable in this runtime), `NOT_SUPPORTED` (genuinely absent).
2. **Measured, and fail-closed.** `RuntimeCapabilityProbe` fields are measurements; `undefined`
   means "could not be determined" and yields `NOT_CONNECTED`, never an optimistic claim. A probe
   that throws returns `undefined`, not `0`. Tool capability requires a connector **and** a live
   grant, because `grantCovers` means no grant → no execution.
3. **A new `runtime` context stage, weighted above every other stage** (0.9 vs `goals` 0.5 …
   `episodic` 0.2), and a new `runtime_state` context item kind. Current measurement therefore
   always outscores recalled self-description. The epistemic label is `TOOL_CONFIRMED`: observed
   from the system, not inferred by the model.
4. **Never keyword-gated.** The capability items are always offered to selection, because a question
   like "de quoi es-tu capable ?" shares no vocabulary with the capability lines and relevance
   scoring would otherwise drop exactly the turn that needs them.
5. **Rendered as current.** `renderContext` prefixes a `runtime_state` item with
   "ÉTAT ACTUEL DU SYSTÈME (mesuré maintenant, prévaut sur tout propos antérieur)", so historical
   prose cannot be read as present truth.
6. **The prompt describes the turn, not the system.** "Dans un tour de conversation tu n'exécutes
   rien directement : tu PROPOSES" is precise and true; an approved mission then runs durably
   without continuous human supervision, which the prompt now states. Capability questions are
   directed to the `[runtime:capability.*]` lines, claiming anything absent or `NOT_CONNECTED` is
   forbidden, asserting that *all* actions need approval is forbidden, and with no capability lines
   ICOS must say it cannot establish its current state.

This grants no authority. It only describes what the runtime already permits, so the description
cannot drift from the permission — and registering a worker or a connector changes the answer with
no code change.

## Consequences

- ICOS's self-description tracks deployment. In the audited runtime it reports tools, external
  real-time access and delegation as `NOT_CONNECTED` — the honest answer, and the opposite of a
  marketing template.
- Stale assistant prose about operational state can no longer be mistaken for current truth.
- Two core contracts grew additively: `ContextStage` gained `runtime`, `CONTEXT_ITEM_KINDS` gained
  `runtime_state`. Existing snapshots stay valid; `policyVersion` already records assembly policy.
- Cost: ~9 extra context lines per turn (~360 tokens against a 2000 budget), and four `count(*)`
  queries per turn. Measured snapshots used 20–80 tokens before, so the budget is ample.
- Conversation turns still carry no temporal validity of their own: `memory_records` has
  `valid_from` / `valid_until` / `expires_at` and a `superseded` status, turn items have none. This
  decision does not fix that asymmetry; it makes it harmless for self-state by giving current state
  strictly higher precedence. A general temporal-validity model for turns remains open.

## Gaps

- `client_id` / `project_id` are `NULL` on voice conversations (the voice adapter creates with only
  `{title: "Voice"}`), so client/project capability is not represented. Out of scope here.
- The `self` memory type exists with zero rows; a learned self-model is not attempted.
- Capability counts are tenant-wide, not per-caller: "is any connector installed" decides
  `NOT_CONNECTED`. A per-agent capability view would need the caller's grants.
