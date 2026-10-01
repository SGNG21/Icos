# Ownership map — context / memory / client knowledge (pre-implementation audit)

Baseline: `016f4e1` on `feat/context-memory-client-knowledge`.
Read first: `README.md`, `docs/icos/constitution/ICOS_CONSTITUTION.md`, `.claude/rules/*`,
decisions 0056 (cognitive runtime + memory V1), 0061 (voice is a transport adapter),
ADR-0001 (business/client/RGPD domain), `docs/architecture/client-context-model.md`,
`docs/architecture/business-domain-model.md`.

## Who owns what today

| Concern | Canonical owner | State | This lane |
| --- | --- | --- | --- |
| Conversation, turns, events, proposals | `src/server/cognitive/conversation-store.ts` (+ migration 0050) | REAL | EXTEND (scope pointer, turn/ref scope stamping) |
| Turn orchestration (assembly → cognition → policy → writeback) | `src/server/cognitive/cognitive-runtime.ts` | REAL | EXTEND (resolution step before assembly) |
| Context assembly / ranking / budget | `src/server/cognitive/context-assembler.ts` + pure `src/core/cognitive/context-selection.ts` | REAL | EXTEND (live-state stage, temporal precedence) |
| Memory authority (8 types, writeback, review, provenance, supersede) | `src/server/cognitive/memory-store.ts` + pure `src/core/cognitive/writeback-rules.ts` | REAL | REUSE AS IS |
| Entity graph (client/project/objective + aliases + relations) | `memory_entities` / `memory_relations` via `PostgresCognitiveMemoryStore` | REAL | REUSE + one alias lookup |
| Memory/context contracts | `src/core/cognitive/contracts.ts` | REAL | EXTEND (additive fields only) |
| Mission/goal launch | `src/server/cognitive/mission-gateway.ts` → goal intake → `SchedulerService` → CORE3 | REAL | REUSE AS IS (no direct CORE3) |
| Policy / approval | `src/core/cognitive/turn-policy.ts` (`launchPolicy` = always approval_required) | REAL | UNCHANGED |
| Phase 7B operational memory (mission / procedural / business) | `src/core/memory`, `src/server/memory` (migration 0031) | REAL, holding-level, no client dimension | REUSE through `MemoryServiceOperationalSource` (unchanged) |
| Mission-execution context (hot/warm/cold, checkpoints, learned patterns) | `src/core/context/*` | Mission-scoped, separate concern | UNTOUCHED |
| CEO prototype conversation (`/api/conversation`) | `src/server/ceo/*` | Prototype, superseded by `/api/cognitive/*` for new clients | UNTOUCHED |
| Business client pages | `src/app/business/clients/**` | STATIC placeholder fixtures (hardcoded arrays) | SOURCE OF IDENTITY ONLY, never of operational state |

## Gaps that justify this lane (nothing else owns them)

1. **No resolution path.** A conversation's `client_id`/`project_id` are fixed at creation and
   there is no way to turn « LDS », « le Mécène », « reviens à LDS », « ça » into a scope.
2. **No current-context pointer / switch.** `cognitive_conversations.client_id` is never updated;
   there is no previous-context memory, so "reviens à LDS" cannot exist.
3. **Cross-client leakage through recent turns.** `recentTurns()` returns the last turns of the
   conversation with no scope predicate: after a switch, the previous client's turns would enter
   the new client's context. Turns carry no scope column to filter on.
4. **Proposal launches read the *current* pointer.** `launch()` passes `conversation.clientId`, so a
   proposal created under client A and approved after a switch would launch under client B.
5. **No live-state precedence.** The assembler has only durable memory; an old memory saying a
   mission is running cannot be outranked by its current state.
6. **No client/project directory.** No seeded `client` entities, so nothing to resolve against.

## Decisions taken from the audit

- **No new authority, no new tables.** CLIENT and PROJECT are `memory_entities` (kind
  `client`/`project`, `key`, `name`, `aliases`) plus `memory_records` (`project`/`semantic`/
  `decision` types, `client_id`/`project_id` scope) plus `memory_relations`
  (`CLIENT_OF`, `HAS_GOAL`, `HAS_BLOCKER`). Missions stay CORE3's, referenced by
  `cognitive_turn_refs.mission_id`.
- **Directory entities are tenant-level** (`client_id IS NULL`): the *existence and name* of a
  client must be resolvable before a scope exists. Its *knowledge* is client-scoped.
- Migration `0054` is additive columns only: conversation previous pointer, turn scope, ref scope.
