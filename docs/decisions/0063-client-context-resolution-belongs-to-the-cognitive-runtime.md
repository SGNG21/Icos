# 0063: Client/project context resolution belongs to the Cognitive Runtime

## Status

Accepted (lane `feat/context-memory-client-knowledge`, baseline `016f4e1`). Migration
`0054_client_context.sql`. Extends decision 0056; creates no new authority.

Renumbered 0062 -> 0063 during central integration: the parallel lane
`feat/phone-live-proof` had independently allocated 0062 off the same baseline
("ICOS's self-model is measured, not declared"), which landed first in the
integration order. Both decisions are real and both are kept; only this one's
number moved. The migration keeps the number `0054` (central was at `0053`, and
`0054` was claimed by no other lane). Evidence that renumbering the migration's
header was safe: on the live database the ledger held 51 applied rows against a
52-entry journal, with neither `client_directory` nor
`cognitive_conversations.previous_client_id` present -- i.e. `0054` had never
been applied outside test databases.

## Context

ICOS must understand and retain real business context across conversations and restarts:
« Où en est LDS ? », « Et le Mécène ? », « Reviens à LDS. », « Occupe-toi de LDS. »,
« Continue ce qu'on faisait. »

Audit of the baseline (full map in `audit/context-memory-client-knowledge/OWNERSHIP-MAP.md`):

| Existing                                                                   | State                                                        | Use here                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| `CognitiveRuntime`, `PostgresConversationStore` (0050)                     | REAL; `client_id` fixed at creation, never updated           | EXTENDED (pointer, scope stamping)     |
| `PostgresCognitiveMemoryStore`, `memory_records`, `memory_entities` (0050) | REAL; 8 memory types, aliases, relations, governed writeback | REUSED AS IS                           |
| `ContextAssembler` + pure `context-selection.ts`                           | REAL; deterministic stages, token budget, snapshot           | EXTENDED (live stage, precedence)      |
| `turn-policy.ts` / `CanonicalGoalLauncher`                                 | REAL; every conversational proposal is `approval_required`   | UNCHANGED                              |
| Phase 7B operational memory (0031)                                         | REAL, holding-level, no client dimension                     | UNCHANGED (read via `MemoryService`)   |
| `src/core/context/*` ContextEngine                                         | Mission-execution context (checkpoints, patterns), separate  | UNTOUCHED                              |
| `src/app/business/clients/**`                                              | STATIC UI fixtures (hardcoded arrays)                        | identity only, never operational state |

Six gaps had no owner: no resolution path, no current/previous context pointer, recent turns
carried no scope (cross-client leakage), launches read the _current_ pointer instead of the
proposal's, no live-state precedence, and no client directory to resolve against.

## Decision

1. **CLIENT and PROJECT are existing shapes, not new tables.** A client is a
   `memory_entities` row (`kind='client'`, `key`, `name`, `aliases`) scoped to itself
   (`client_id = key`), a project is `kind='project'` with `client_id` = its client and
   `project_id` NULL (so it is visible across that client's whole scope). Objectives,
   constraints, priorities, blockers, decisions and results are `memory_records`
   (`project` / `semantic` / `decision`) under the client/project scope; missions stay CORE3's
   and are referenced through `cognitive_turn_refs.mission_id`. **No field duplicates an
   existing canonical memory field.**

2. **Resolution is a pure function** (`src/core/cognitive/client-resolution.ts`) with explicit,
   testable precedence: canonical identifier → canonical name → alias → current conversation
   pointer → recent durable pointer → safe ambiguity. A tier that matched is decisive; inside a
   tier, a strictly longer match wins and an equal-length rival is **ambiguous**. Deictics
   (« ça », « ce client ») read the current pointer; « reviens » reads the previous one;
   « continue » falls back to the user's most recent durable scope. A _qualified_ reference to
   an unknown client (« le client de Cannes ») is ambiguous, never the active client.

3. **Fail closed on ambiguity.** The runtime answers `CLARIFICATION` with a concise question:
   the cognition engine is **not consulted**, no proposal is created and **nothing is written to
   memory**. A `restricted` client is never resolvable at any ceiling, and its existence is not
   disclosed in the question.

4. **The current context pointer is a column, not a cache.** `cognitive_conversations` gains
   `previous_client_id` / `previous_project_id`; `setScope` moves current → previous under the
   conversation lock and appends a `context.resolved` event. « Reviens à LDS » therefore
   survives any restart with no in-memory stack and no second context authority.

5. **Turns and proposals record the scope they happened under.** `cognitive_turns` and
   `cognitive_turn_refs` gain `client_id` / `project_id`. `recentTurns` applies the scope
   predicate, so a turn spoken under LDS can never re-enter the Mécène's context; the 0050
   turn guard is extended so a **terminal** turn's scope is immutable. A launch uses the
   **proposal's** scope, so approving an LDS mission after a switch still launches under LDS.
   A reply and any proposal are stamped from the scope **their own user turn** was resolved
   under, never from the conversation's pointer, so the guarantee does not depend on
   `cognitive_turns_one_inflight` serialising turns.

6. **Temporal precedence.** `CurrentStateSource` (`LaunchedMissionStateSource`) reads the
   client's live proposal/launch ledger joined with CORE3's current mission status and emits
   `live` candidates at stage `current` with a `subject`. `applyTemporalPrecedence` drops any
   durable memory about the same subject with reason `stale`. The memory row is untouched and
   still readable as history — it simply cannot present a finished mission as running.

7. **Mission integration through the canonical path only.** Resolution happens _before_
   assembly, cognition and goal creation; the resolved scope reaches CORE3 as goal metadata via
   the existing `CanonicalGoalLauncher` → goal intake → `SchedulerService`. Context resolution
   grants no authority and changes no approval semantics: `launchPolicy` still requires an
   explicit human approval for every conversational proposal.

8. **One scope-free read, deliberately.** `clientDirectory(tenantId, maxSensitivity)` is the
   only read that does not apply the client predicate, because a reference must be resolvable
   before a scope exists. It returns kind/key/name/aliases/owning client and **no knowledge**:
   no memory row, no objective, no relation. Tenant predicate and sensitivity ceiling still
   apply.

9. **Seeding reports instead of inventing.** `client-directory-seed.ts` seeds only what the
   repository establishes (the two clients exist, their canonical names and route-slug
   identifiers, plus alias forms derived from those names), as SYSTEM_OBSERVED observations
   whose provenance names the file that establishes them. Legal names, registration numbers,
   addresses, domains, module enablement, autonomy levels, missions and their statuses are
   **not** seeded: they exist only inside blocks labelled « Example » or as hardcoded UI
   fixtures. They are listed in `MISSING_BUSINESS_DATA`. « Le client de Cannes » has no basis
   in the repository and is not seeded; it resolves to a clarification question. The seeded
   observation claims only directory membership and the workspace route — **not** an operational
   status: the « Actif » badge on the client directory page is a hardcoded literal rendered
   identically for every row, so it establishes nothing about any individual client. Bare common
   nouns (« mécène », « éditeur ») are not aliases; only determined forms (« le Mécène »,
   « l'éditeur ») are, and « l'éditeur » is recorded as a _declared_ descriptive alias with its
   rationale rather than as a derivation of the canonical name.

## Consequences

- Any authenticated operator may still move a conversation to any client by naming it: ICOS has
  no per-user client ACL (a known limit of 0056, unchanged here). Every move is recorded as a
  `context.resolved` event with its source.
- A pre-0054 conversation has no previous pointer, so « reviens » answers « aucun périmètre
  précédent » rather than guessing. Pre-0054 turns and proposals have a NULL scope, read as
  "unscoped": visible only in an unscoped context, never inside a client's.
- A switch mid-conversation intentionally hides the previous client's turns from the new
  client's context. The conversation reads as two threads; that is the isolation guarantee.
- **Proposals pending across the migration** have a NULL scope, so they now launch unscoped where
  they previously inherited the conversation's pointer. This fails safe (no mission is attributed
  to a client it was not proposed for) but it is a behaviour change for anything approved after
  the upgrade. The strict read is deliberate: falling back to the current pointer would
  re-introduce the defect item 5 closes.
- **Temporal precedence is bounded.** It settles a memory against a live reading only when the
  memory carries `mission_id`; a free-text claim such as « la mission X est en cours » with no
  mission link is not outranked. The live set is the 20 newest proposals of the client in
  `approved`/`launching`/`launched`. Precedence runs before budget trimming, so in the pathological
  case where the live item is itself trimmed, neither statement is shown (the `current` stage
  carries the highest weight, which makes this unlikely rather than impossible).
- The `context.resolved` event is transactional on the path where the pointer moves. On the
  unchanged path it is best effort (`catch`), consistent with `memory.written`: an observability
  failure must never un-complete a turn.
- With no `CurrentStateSource` wired, the snapshot's `policyVersion` says
  `current_state:not_connected` and no stale claim can be outranked.
- Rollback: see the header of `0054_client_context.sql` (additive columns + one
  `CREATE OR REPLACE FUNCTION`; no table created, no row rewritten).

## Observability

Per contextual turn, from the durable log alone: `conversation_id`, `turn_id`, resolved
`client_id` / `project_id`, resolution `source`, matched `entityKey`, ambiguity reason and
candidate names (`context.resolved`); retrieved memory refs, exclusions and their reasons plus
`content_hash` (`context.assembled` + `cognitive_context_snapshots`); mission/goal reference
(`proposal.*`, with `goal_id` / `mission_id` / `launch_job_id`); writeback record ids with their
scope (`memory.written`). No secret and no raw sensitive content is logged: payloads carry ids,
names and reasons.

## Tests

Pure: `client-resolution.test.ts` (26), `temporal-precedence.test.ts` (6).
Real PostgreSQL: `client-context.integration.test.ts` (18) — seeding, LDS case, Mécène switch
with zero leakage, return to previous, cross-conversation continuation, ambiguity/fail-closed,
scope and tenant isolation, writeback provenance, temporal precedence, mission handoff under the
proposal's scope, restart durability (new runtime **and** a real `SIGKILL`-equivalent child
process).
