# 0069 — The product layer projects measured truth, and the model only narrows

- Status: accepted (lane `feat/fable5-product-layer`, prepared to land after the critical
  runtime E2E is green)
- Date: 2026-10-05
- Extends: 0062 (self-model is measured), 0066 (seven planes), 0067 (conversational delta)

## Numbering hazard

Central owned `..0068` when this lane was cut; no other worktree claimed `0069` at the time of
writing (checked across all worktrees). Re-check at integration.

## Context

Decision 0067 wrote down the conversational delta. Items 1–3 landed on the critical path
(cancellation, executor declaration, the autonomy classifier). This lane delivers the product
layer around them without touching mission settlement, the workforce lifecycle or CORE3:
items 4–9 of 0067 plus the cockpit, as separately revertible commits.

The live audit of 2026-10-04 found the cockpit honestly dark on four tiles whose sources now
exist, the self-model unable to tell "set one env var" from "nothing is wired", no realtime
access at all, one model for every turn, and a launch policy that refused every goal with a
reason that told the approving human nothing.

## Decisions

1. **Capability states are a measurement vocabulary, not an authority vocabulary.** Two
   additive states: `NOT_CONFIGURED` (reachable, a value is unset — the evidence names the
   variable) and `DEGRADED` (available, measurably impaired — the evidence names the part).
   The fleet is reported per provider from the registry's own probe evidence
   (`compute.providers`). Nothing grants: an unmeasurable probe still fails closed.

2. **Realtime access means a web or search connector, measured from deployment config and
   health evidence.** Two CONNECTED connectors, `web` (READ, LOW, no approval, read-only,
   private-network and credential refusals, redirect re-validation, body cap) and `search`
   (SEARCH, LOW, no approval, SearXNG-compatible endpoint named by config). A model provider is
   never realtime access. An instance is deployment configuration; this decision installs
   nothing.

3. **The conversational model is chosen per turn, before the model runs, from the transport
   and the text — never from the intent the model will produce.** `VOICE`,
   `CONVERSATION_DEEP`, `CONVERSATION_FAST`; per-class env overrides; `ICOS_COGNITIVE_MODEL`
   stays the mandatory fallback. Mission workloads keep their own models. Voice is the same
   path with `channel: "voice"` set by the transport.

4. **A proposal declares what it needs, from the classifier's closed vocabulary, and the
   model can only narrow.** `GoalProposal.capabilities` reaches intake as the goal's
   allowlist; `launchPolicy` writes `classifyMissionAutonomy`'s verdict on the proposal.
   **Every conversational goal and action still requires a human approval before launch.**
   Turning an `AUTO_ALLOWED` verdict into a launch without that step is a separate,
   owner-approved change (0067 item 7, second half) and is deliberately not taken here.

5. **The cockpit shows a value exactly when ICOS has a source for it, through the same
   measurement the conversation uses.** Memory, tokens, the durable backlog, provider health
   and the measured capabilities are projected; money is shown only when every call in the
   window is priced, otherwise `UNPRICED n/m` (0066). Latency and per-client cost stay dark.
   `measureRuntimeCapabilities` is the one function both the cockpit and the context assembler
   read, so screen and voice cannot disagree.

6. **Mission settlement leaves one durable, idempotent memory record** — designed, writer
   implemented and tested (`mission-memory.ts`), call site deliberately unwired because it
   sits beside `chiefRelease` on the settlement path (`docs/icos/mission-memory-integration.md`).

## Consequences

- Contracts grew additively: `CAPABILITY_STATES` (+2), `GoalProposal.capabilities`
  (optional), `SubmitTurnInput.channel` (defaulted), `ConnectorCategory` (+`WEB`, `SEARCH`;
  not persisted, no migration). No migration in this lane.
- Four env variables are new and optional: `ICOS_COGNITIVE_MODEL_FAST/_DEEP/_VOICE`, and a
  `web`/`search` instance in `ICOS_TOOL_GATEWAY_CONFIG`.
- The prompt learned two states and one vocabulary line; capability is still never prose.
- The twelve brains are audited as **not load-bearing** for a reason outside this lane
  (`docs/reports/2026-10-05-twelve-brain-load-bearing-audit.md`): Chief's stage task ids never
  match CORE3's mission task ids at `forTask`.

## Dependencies and conflicts, stated

- Depends on the critical-path worker's E2E going green; shares no file with mission
  settlement, the workforce lifecycle, the reviewer or the active-attempt guard.
- Touches `src/server/cognitive/index.ts`, `cognition.ts`, `contracts.ts`,
  `conversation-store.ts`, `cognitive-runtime.ts`, `mission-gateway.ts` — cognitive-lane files.
  A parallel lane editing the same files will conflict textually, not semantically.
- Two test strings changed (`policyReason` of an undeclared proposal); listed in the handoff
  commit.
