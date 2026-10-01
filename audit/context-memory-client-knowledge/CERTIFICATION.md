# Lane certification — context / memory / client knowledge

Branch `feat/context-memory-client-knowledge`. Decision 0063, migration `0054_client_context.sql`.
Ownership map: `OWNERSHIP-MAP.md` (written before any code change).

## What was built, and on top of what

Nothing in this lane is a new authority. The Cognitive Runtime (decision 0056) remains the only
owner of conversation, session, turns, context assembly, memory retrieval/writeback, intent and
goal-launch coordination. Six gaps were filled inside it:

| Gap | Fix | Where |
| --- | --- | --- |
| No way to turn « LDS » into a scope | pure precedence resolver | `src/core/cognitive/client-resolution.ts` |
| No current/previous context pointer | 2 columns + `setScope` under the conversation lock | `0054`, `conversation-store.ts` |
| Recent turns had no scope ⇒ cross-client leakage | `client_id`/`project_id` on turns + scope predicate in `recentTurns` | `0054`, `conversation-store.ts` |
| A launch read the *current* pointer | `client_id`/`project_id` on proposals; launch uses the proposal's scope | `0054`, `cognitive-runtime.ts` |
| No live-state precedence | `CurrentStateSource` + `applyTemporalPrecedence` | `current-state-source.ts`, `context-selection.ts` |
| Nothing to resolve against | repository-sourced seed + one scope-free directory read | `client-directory-seed.ts`, `memory-store.ts` |

CLIENT and PROJECT reuse the existing durable shapes: `memory_entities` (identity, aliases),
`memory_records` (`project`/`semantic`/`decision` under client/project scope) for objectives,
constraints, priorities, blockers, decisions and results, `memory_relations` for the graph, and
`cognitive_turn_refs.mission_id` for missions. **No new table. No field duplicating an existing
canonical memory field.**

## Evidence

Reproduce with a dedicated database:

```
ICOS_TEST_DATABASE_URL=postgres://$USER@localhost:5432/icos_ctxmem_test pnpm test:db:setup
npx vitest run src/core/cognitive/                       # pure
ICOS_TEST_DATABASE_URL=... npx vitest run --config vitest.integration.config.ts \
  src/server/cognitive/client-context.integration.test.ts
npx tsx scripts/seed-client-knowledge.ts postgres://$USER@localhost:5432/icos_ctxmem_test
```

Never run two integration suites against one database: each `beforeEach` truncates, and the
other run's stable proofs then fail as if the change had broken them.

### Acceptance cases

| Case | Proof |
| --- | --- |
| A. « Où en est LDS ? » | resolves `lds-renov` by alias, `context.resolved` event with `source: alias`, prompt contains the durable priority, `getContext` returns the memory id |
| B. « Et le Mécène ? » | scope moves to `editions-du-mecene`; prompt contains the Mécène fact and **neither** the LDS memory **nor** this conversation's LDS turns |
| C. « Reviens à LDS. » | restores LDS; `previous_client_id` is `editions-du-mecene` after the switch |
| D. « Occupe-toi de LDS. » | client resolved and inspected **before** the goal; proposal is `approval_required` with `clientId: lds-renov`; after approval the goal metadata carries `clientId` and exactly one `start_mission` job exists |
| E. restart between A and C | a second handle + second runtime resumes the pointer; and a real child process resolves, is killed, and the scope is still on every turn |

### Negative / safety proofs

- « Et le client de Cannes ? » → `CLARIFICATION`, **the cognition engine is never called**, no
  proposal, no episodic row written, pointer untouched, ambiguity reason on the event log.
- « occupe-toi de ça » with no active scope → `CLARIFICATION`, intent `context.no_current_context`.
- another tenant resolves nothing and sees nothing (`clientDirectory` is empty for it).
- a `restricted` client is unresolvable at any ceiling and its existence is not disclosed.
- a model suggestion lands as a `candidate`, `MODEL_INFERRED`/`inference`, scoped to the resolved
  client, with turn provenance and the engine label — and is invisible from the other client.
- a completed mission is reported as `completed` and the older memory claiming « en cours
  d'exécution » is excluded with reason `stale`.
- with nothing seeded, « Où en est LDS ? » puts **no** client knowledge in the prompt: the
  knowledge path is the Context/Memory path and nothing else.

## Business data

Seeded (identity only, provenance names the file that establishes it): the two clients exist,
their canonical names (`LDS Rénov'`, `Éditions du Mécène`), their canonical identifiers (the
route slugs `lds-renov`, `editions-du-mecene`), alias forms derived from those names, and one
`project`-type status observation each.

Not seeded, reported in `MISSING_BUSINESS_DATA`: legal entities, registration numbers,
addresses, cities, domains (placeholders inside « Example » blocks); objectives, constraints,
priorities; projects; current missions, blockers, recent decisions, recent results; module
enablement and autonomy level (documented as examples and contradicted between the docs and the
pages for LDS: `AUTONOMOUS` vs `AUTOMATED`); and the alias « le client de Cannes », which has no
basis anywhere in the repository.

## Independent review

An independent read-only reviewer (different model, no write access, forbidden from running
tests or touching the database) reviewed the diff against scope isolation, stale/current
precedence, duplicate authority, persistence/migration safety, mission handoff, fail-closed
behaviour, seed honesty and test honesty.

It confirmed no leak in `recentTurns`' predicate, `clientDirectory`, `entitiesInScope` /
`relationsOf`, `memoryExclusion`, the seed's `clientId = key` choice, tenant isolation, duplicate
authority (pointer is a column, launches still go through `CanonicalGoalLauncher`, no direct CORE3
call), mission handoff ordering, the unchanged approval policy, the fail-closed ambiguity branch,
and the migration (additive; the guard function is identical to 0050 apart from the added
terminal-scope block; schema mirror and journal correct).

Acted on, with a regression test for each:

| Finding | Verdict | Action |
| --- | --- | --- |
| Reply/proposal stamped from the conversation pointer rather than the turn's scope | premise (overlapping turns) is blocked by `cognitive_turns_one_inflight`, but the stamping was wrong on its own terms | stamp from the turn's resolved scope; proof asserts both turns carry the resolved client |
| `ça`/`cela`/`dessus`/`back` treated as references ⇒ every ordinary sentence in an unscoped conversation answered with a question | REAL availability defect | split strong vs weak deictics; weak ⇒ unscoped, not a question; `back`/`retourne` dropped |
| A degraded live reading (no status read) still claimed `live` and suppressed better memory | REAL | `live` only when a real status was read; proof asserts nothing is marked `stale` on that path |
| Naming the current client dropped the project scope | REAL | a confirming match preserves the project |
| `previous`/`recent` pointers adopted without checking visibility | REAL | a pointer is adopted only if its client is still resolvable by the actor |
| Seeded « client actif » supported only by a hardcoded badge; evidence path mismatched; `l'éditeur` not name-derived; bare `mécène` matches the common noun | REAL — the seed violated its own rule | fact restated as directory membership + route; evidence and provenance aligned; bare `mécène` removed; `l'éditeur` documented as a declared alias with rationale; the badge added to `MISSING_BUSINESS_DATA` |
| 0054 rollback order would break the turn guard | REAL | header now restores the function first |
| Precedence bounded (needs `mission_id`, 20-ref cap, runs before trimming); legacy proposals now launch unscoped; `context.resolved` best-effort on the unchanged path | REAL, accepted | documented in 0063 Consequences and below |
| P5 pinned with `resolveContext: false` no longer covers the default runtime | fair | added a default-runtime isolation proof with a question that names no client |

## Residual risks

1. **No per-user client ACL.** Any authenticated operator can move a conversation to any client
   by naming it. This is an unchanged limit of decision 0056, not introduced here; every move is
   recorded as a `context.resolved` event with its source.
2. **Resolution is lexical.** It matches identifiers, canonical names and declared aliases. An
   unlisted way of naming a client resolves to a clarification question rather than silently to
   the active client — correct, but it means aliases must be curated as the business grows.
3. **Temporal precedence is bounded.** A memory is outranked only when it carries `mission_id`;
   a free-text claim with no mission link is not. The live set is capped at the 20 newest
   proposals per client, and precedence runs before budget trimming.
4. **No automatic mission-outcome writeback.** The durable model supports it (`missionId` on
   `memory_records`) and the read path is covered by the live-state stage, but nothing in this
   lane observes a mission reaching a terminal state to record its outcome as memory. A
   conversation therefore learns a mission's result from live state, not from memory.
5. **A switch splits the thread.** By design, the previous client's turns are hidden from the new
   client's context, so a long mixed conversation reads as several threads.
6. **Live state covers conversational missions only.** `LaunchedMissionStateSource` reads
   proposals made in a conversation. A mission created outside the conversational path has no
   `client_id` anywhere (missions carry the client only in goal metadata), so it does not appear
   in the current-state stage.
7. **Proposals pending across the migration launch unscoped** (NULL `client_id`). Fails safe, but
   it is a behaviour change for anything approved after the upgrade.
