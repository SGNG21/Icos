# 0056: Cognitive Runtime + Memory V1 — durable conversations, governed memory, selective context

## Status

Accepted (lane C, branch `feat/cognitive-runtime`, baseline `e652469`). Numbered 0056 /
migration 0050 (central integration); the lane had chosen 0057 / 0051 because 0055/0056 and 0049/0050 are used by other lanes (see "Integration /
migration reconciliation").

## Context

ICOS must behave like a persistent employee: remember, retrieve relevant context, resume a
conversation after any restart, explain where a belief came from, and turn a request such as
« ICOS, analyse pourquoi LDS Renov perd des leads et corrige ce qui peut l'être » into governed
work — without depending on one model or one session.

Audit of the baseline:

| Existing                                                                                                                                                                                                               | State                                                                                              | Use in this lane                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/context/*` ContextEngine (mission hot/warm/cold layers)                                                                                                                                                      | STUB: `selectRelevant` returns `[]`, `compact` is a placeholder, not referenced by production code | Left untouched; it is mission-scoped. Conversation context is a separate, working assembler.                                                                                                                                     |
| Phase 7B operational memory (`src/core/memory`, `src/server/memory`, migration 0031): mission / procedural / business memory, tenant, provenance, visibility, secret rejection, append-only triggers, traced retrieval | REAL, not wired into the container                                                                 | REUSED: secret detection (`containsSecret`), error types, the append-only trigger function, and validated procedures + human-approved business facts read through `MemoryService` (every read traced in `memory_retrieval_log`). |
| CEO conversation (`conversations`/`messages`, `/api/conversation`, `CeoApplicationService`)                                                                                                                            | Prototype: no tenant, no owner, no ordering, no idempotency, "latest conversation" global          | Left untouched (still used by the cockpit). Superseded for new clients by `/api/cognitive/*`.                                                                                                                                    |
| Goal intake (`GoalNormalizer` → `GoalPlanner` → `GoalPreviewStore`/`GoalRepository`)                                                                                                                                   | REAL                                                                                               | The mission adapter's backend.                                                                                                                                                                                                   |
| Tenancy                                                                                                                                                                                                                | Single-tenant shim `CURRENT_SINGLE_TENANT_ID`                                                      | Used; every table carries `tenant_id`.                                                                                                                                                                                           |
| Clients/projects                                                                                                                                                                                                       | Documentation only (ADR-0001)                                                                      | Represented as text keys + `client`/`project` entities in the new graph.                                                                                                                                                         |

## Decision

1. **Durable conversation** (migration `0050_cognitive_runtime.sql`): `cognitive_conversations`
   (tenant, owner, optional client/project scope), `cognitive_participants`, `cognitive_turns`
   (per-conversation `seq`, structured `content`, lifecycle `received → processing →
completed|failed|cancelled`, outcome, intent), `cognitive_turn_refs` (proposals awaiting
   approval), `cognitive_context_snapshots`, `cognitive_events` (ordered, append-only). No model
   or session id anywhere. Database guarantees: `(conversation, idempotency_key)` unique; one
   in-flight user turn per conversation (partial unique index); turn content immutable and
   terminal statuses final (trigger); events and snapshots append-only.
2. **One normalized memory table** `memory_records` for the eight types (WORKING, EPISODIC,
   SEMANTIC, ENTITY, DECISION, PROCEDURAL, PROJECT, SELF) with subject, entity, content,
   provenance, confidence, validity, supersedes/contradicts, client/project/conversation/mission,
   tags, sensitivity, retention. Two separate axes: **epistemic** (who stands behind it:
   USER_ASSERTED, SYSTEM_OBSERVED, TOOL_CONFIRMED, MODEL_INFERRED, DERIVED) and **statement kind**
   (fact, inference, instruction, suggestion, observation), plus **origin trust** (untrusted =
   retrieved/tool text). CHECKs: a MODEL_INFERRED row is never a `fact`; untrusted text is never
   an `instruction`; one active row per subject and scope. Claims and provenance are immutable
   (trigger): a new value is a new row that supersedes; deletion is a tombstone (content erased,
   provenance kept).
3. **Entity graph in PostgreSQL** (`memory_entities`, `memory_relations`: OWNS, WORKS_ON,
   CLIENT_OF, DEPENDS_ON, HAS_GOAL, HAS_BLOCKER, RELATED_TO, SUPERSEDES). An entity belongs to at
   most one client; cross-client relations are refused. No graph database.
4. **Governed writeback** (`writeback-rules.ts`, applied by `PostgresCognitiveMemoryStore.write`
   under an advisory lock): classify → provenance → confidence caps (MODEL_INFERRED ≤ 0.6,
   DERIVED ≤ 0.8) → dedupe → contradiction check → accept / supersede / hold as
   `candidate` with `contradicts_id` / reject. Authority ranks USER_ASSERTED 5 > TOOL_CONFIRMED 4 > SYSTEM_OBSERVED 3 > DERIVED 2 >
   MODEL_INFERRED 1. Only a rank ≥ SYSTEM_OBSERVED that is at least as
   strong as the current truth supersedes it; a model never overwrites a human or a tool, and a tool never silently overrides a human
   (it becomes a conflict for review). The
   runtime — never the model — assigns epistemic status: model suggestions are always
   MODEL_INFERRED candidates; USER_ASSERTED only comes from an authenticated human
   (`POST /api/cognitive/memory`).
5. **Selective, deterministic context assembly** (`ContextAssembler` + pure
   `context-selection.ts`): scope → goals (objective entities) → entities + 1-hop relations →
   recent turns → durable facts → decisions/procedures (+ Phase 7B) → policy re-check
   (tenant/client/project/user/status/expiry/sensitivity, mirroring the SQL predicate) → rank
   (stage weight, keyword and entity overlap, scope anchoring, confidence, recency) with a
   relevance gate and a token budget → snapshot hashed (sha256) and persisted with every
   exclusion and its reason. Restricted memory never enters a prompt; sensitive only for
   operator+. Untrusted items are rendered fenced as data.
6. **Cognition is a port** (`CognitionEngine`): returns a zod-validated output (ANSWER_ONLY,
   CLARIFICATION, NO_ACTION, ACTION_REQUEST, MISSION_REQUEST + memory suggestions). Unparseable
   output degrades to a plain answer. `OmniRouteCognitionEngine` is the default when
   `OMNIROUTE_BASE_URL`, `OMNIROUTE_API_KEY` and `ICOS_COGNITIVE_MODEL` (or `ICOS_CEO_MODEL`) are
   set; otherwise an explicit `NotConnectedCognitionEngine` says so.
7. **Policy between cognition and the world** (`turn-policy.ts`): the engine never acts.
   ACTION_REQUEST becomes an action proposal; MISSION_REQUEST becomes a goal proposal. Proposal
   lifecycle: `PROPOSED → APPROVAL_REQUIRED → APPROVED → LAUNCHING → LAUNCHED | FAILED`, or
   `REJECTED`. The goal's risk level is asserted by the model (unverified), so the existing
   `humanApprovalPolicy` cannot be relaxed on its word: every conversational proposal is
   APPROVAL_REQUIRED (`launchPolicy`). The approval is given by the conversation's human
   (`missions.write`); it is a policy step, not an operator stage advancement: launch then
   happens automatically.
   **Canonical launch** (`CanonicalGoalLauncher`): goal intake (pending goal,
   `humanApprovalPolicy: "always"`, metadata `conversationId`/`turnId`/`proposalRefId`/
   `clientId`/`projectId`/`approvedBy`) → `SchedulerService.enqueue({ kind: "start_mission",
idempotencyKey: "cognitive-proposal:<refId>", payload: { title, objective, goalId } })`,
   which fixes the missionId at enqueue time → the production `DurableScheduler`
   (production-services.ts) runs `igniteAutonomousMission` with the governed supervisor and
   planner. This lane never constructs a supervisor and never calls
   `/api/missions/autonomous` (which builds its own). LAUNCHED means durably accepted by CORE3
   under a fixed missionId, never "mission succeeded"; `missionId`, `goalId` and
   `launchJobId` are persisted on the proposal. Idempotency: the goal is keyed by its
   (text-derived) id + `proposalRefId`, the job by its idempotency key, the proposal moves
   forward only (conditional updates), and `cognitive_turn_refs_mission_unique` forbids two
   proposals sharing a mission. Actions have no conversational backend yet: approval records
   `not_connected`.
   Cross-lane change: `enqueueScheduledJobSchema.start_mission.payload` gains an OPTIONAL
   `goalId` (3 lines in `scheduler-service.ts`), which the `start_mission` handler already
   honoured; existing callers are unchanged.
8. **Ask ICOS API** under `/api/cognitive/*` (create/list, resume, submit turn, cancel, SSE event
   stream from the durable log, context + memory provenance, proposal decision, remember /
   forget, memory candidates + review). PostgreSQL only: in memory mode the API answers 503.
   **Acceptance semantics** for Voice/phone: `POST …/turns?mode=accept` (or
   `Prefer: respond-async`) returns 202 as soon as the turn is durable; progress is the SSE
   event stream; cancellation is `POST …/cancel`. `CognitiveTurnStream` (voice-adapter.ts) is
   the in-process equivalent shaped for the Voice lane's `CognitiveRuntimePort`: accept fast,
   follow this turn's durable events, abort → `cancelTurn` (never un-accepts). The blocking
   submit is unchanged.
9. **Restart / disconnect semantics**: every step is committed before the next. No request
   signal is observed, so a dropped HTTP/SSE connection cancels nothing. `resume` closes turns
   in-flight for longer than 5 min as `failed: interrupted` (never silently re-run). An
   approval is committed before its launch; APPROVED/LAUNCHING proposals are relaunched
   idempotently by `resume` and by `recoverLaunches`, which runs when the runtime is composed
   after a restart. A transient launch error leaves the proposal LAUNCHING (retried); only a
   deterministic refusal (invalid goal, goal-id collision) is FAILED.
10. **Model-inferred memory review**: `MODEL_INFERRED → candidate → human review → active`.
    Review (`approvals.decide`) records `reviewed_by/at` and never rewrites the epistemic
    status, so an accepted inference stays distinguishable from USER_ASSERTED,
    TOOL_CONFIRMED and SYSTEM_OBSERVED facts. The database enforces it:
    `memory_records_reviewed_promotion_check` forbids an active MODEL_INFERRED or untrusted row
    without a review, and a recorded review is immutable.

## Consequences

- Tenant key: `tenant_id` everywhere. RLS strategy: application-enforced scope predicates in the
  single repository (as 0031); Postgres RLS waits for COMPLIANCE-1's TenantContext.
- Client/project access control per _user_ does not exist in ICOS yet: any authenticated
  operator may open a conversation scoped to any client. Isolation guarantees are between
  contexts (a client's memory never reaches another client's context), not between users —
  except conversations and `personal` memories, which are owner-only.
- Voice and Digital Workforce are separate lanes: `TurnContent` parts and the event stream are
  the extension points.
- Rollback: see the header of `0050_cognitive_runtime.sql` (additive; no existing table touched).

## Independent review (Nemotron 550B, M5) — outcome

Fixed: a restricted/sensitive entity could leak through a neighbour's relation line; a tool
could supersede a human assertion; USER_ASSERTED is now only accepted from the human API
channel; a concurrent resume could append a misleading second `proposal.submitted` event;
cross-tenant exclusions now have their own reason; index on `contradicts_id`. Rejected with
evidence: the "null client scope sees client rows" and "same idempotency key race" claims (the
SQL predicate is `client_id IS NULL`; the conversation row lock serializes — both proven by
the PostgreSQL proofs), and the fence break-out (`«»` are neutralised in untrusted text).
Known limits: no purge job for expired session memory; goal ids are text-derived by the
existing normalizer, so a different proposal with identical text fails closed
(`goal_id_collision`).

## Integration / migration reconciliation (for the integrator)

State of local branches on 2026-09-30 (all `drizzle/meta/_journal.json` tails are `idx` 46):

| Branch                       | Migration (`when`)                        | Decision |
| ---------------------------- | ----------------------------------------- | -------- |
| feat/tool-gateway-connectors | `0049_tool_gateway` (0048 + 1 d)          | 0055     |
| feat/proactive-supervisor    | `0049_proactive_supervisor` (0048 + 1 d)  | 0055     |
| feat/digital-workforce       | `0050_digital_workforce` (0048 + 1 d)     | 0056     |
| feat/voice-realtime          | —                                         | 0056     |
| **feat/cognitive-runtime**   | **`0050_cognitive_runtime` (0048 + 3 d)** | **0056** (final: 0056 / 0050) |

Required when merging this branch after the others:

1. Keep every SQL file; resolve `_journal.json` by concatenating entries in merge order and
   renumbering `idx` contiguously (the journal test requires it). Keep this lane's `when`
   last, or bump it above every earlier entry: drizzle skips a migration whose `when` is not
   greater than the last applied one.
2. Resolve the duplicate numeric prefixes (the journal test requires unique prefixes) by
   renaming the later-merged SQL file and its journal `tag` — never by editing a migration
   that has already been applied to a shared database.
3. Decision numbers are prose: renumber duplicate `0055`/`0056` files in merge order.
4. This migration is additive and independent of the other lanes' tables. It reuses
   `icos_forbid_memory_mutation()` from 0031 and does not touch `audit_event_type_check`
   (the tool gateway's 0049 hazard).
5. `scheduler-service.ts` (CORE3): 3 added lines (optional `goalId`); merge with any CORE3
   change to that schema.
