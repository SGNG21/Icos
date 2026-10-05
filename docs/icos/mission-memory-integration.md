# Mission memory: integration design

**Status:** designed and the writer is implemented and tested; the one call site is NOT wired.
**Date:** 2026-10-05 · **Lane:** `feat/fable5-product-layer` · **Decision:** 0067 item 8, 0069.

## The gap, measured

Conversation turns write memory (`memory.written` on every completed turn). Mission settlement
does not: on the live database, every mission that reached a terminal state on 2026-10-04 left
**zero** `memory_records` rows with its `mission_id`. ICOS can run work, review it, settle it,
and then not remember having done it. Asked "qu'as-tu fait hier ?", it answers from
conversation turns about the *proposal*, never from the *result*.

## What exists (reuse, do not rebuild)

| Need | Already there |
|---|---|
| A durable, scoped, governed memory store | `PostgresCognitiveMemoryStore.write` (`src/server/cognitive/memory-store.ts`) |
| A `mission_id` column and a `mission` provenance source | `memory_records.mission_id`, `MemoryProvenance.sourceType: "mission"` |
| Idempotency | `decideAgainstExisting`: same subject + same normalized content + same scope ⇒ `duplicate` |
| Epistemic labelling | `SYSTEM_OBSERVED` ⇒ `active`, `statementKind: fact`, confidence capped by the store |
| A terminal-mission seam on the critical path | `chiefRelease(container)` is already passed to `SupervisorService` and invoked once when a mission reaches a terminal state (`src/server/system/production-services.ts`) |
| The client the mission belongs to | `goals.metadata.clientId` / `projectId`, written by `CanonicalGoalLauncher` |

## The delta

One writer, one call.

### Writer (implemented): `src/server/cognitive/mission-memory.ts`

`recordMissionSettlement(memory, tenantId, userId, fact)` turns a `MissionSettlementFact`
into one `episodic`, `SYSTEM_OBSERVED`, `long_term` record:

- `subjectKey = mission.<missionId>.outcome` — one subject per mission;
- `content = renderMissionOutcome(fact)` — a pure function of the fact, so a replayed settlement
  produces byte-identical content and the store answers `duplicate`;
- `provenance = { sourceType: "mission", sourceId: missionId }`, `missionId` set;
- scope = tenant + the goal's `clientId` / `projectId`, so a client's mission lands in that
  client's memory and nowhere else (decision 0063 isolation);
- the result REFERENCE only (branch, artifact id), never the result content — content is a
  retrieved artefact and would need the `untrusted` path;
- a store failure is returned as `rejected`, never thrown: memory must not un-settle a mission.

Tested: `mission-memory.test.ts` pins the shape, the `active` classification, the duplicate
decision on replay, the scope, and the non-throwing failure.

### Call site (NOT wired — critical path, owned by the settlement worker)

Where `chiefRelease` is called for a terminal mission, add one call beside it:

```ts
// production-services.ts, next to chiefRelease — same seam, same facts
await recordMissionSettlement(cognitiveMemory, tenantId, mission.userId, {
  missionId: mission.id,
  goalId: mission.goalId,
  title: mission.title,
  outcome: mission.status,            // succeeded | failed | cancelled
  reviewVerdict: lastReview?.verdict ?? null,
  resultRef: workspace?.branch ?? null,
  clientId: goal?.metadata.clientId ?? null,
  projectId: goal?.metadata.projectId ?? null,
  settledAt: now.toISOString(),
});
```

`cognitiveMemory` is `new PostgresCognitiveMemoryStore(container.db, clock)` — the same class
the runtime composes; no second store. The call runs AFTER the settlement transaction commits
(it is a consequence of settlement, not part of it) and its outcome is logged, never awaited
by the lock.

### Why not a trigger, a sweeper, or a conversation turn

- A DB trigger would write memory with no scope resolution and no secret check.
- A sweeper would be a second settlement authority (decision 0066: no plane gets two).
- Routing the fact through a synthetic conversation turn would label it `MODEL_INFERRED`
  and make it a candidate; it is an observation and must be `active`.

## Invariants preserved

- The reviewer stays independent; the memory records its verdict, it does not create one.
- One goal ⇒ at most one mission ⇒ at most one outcome record (`missions_goal_id_unique` plus
  the subject key).
- Spend is untouched: a memory write is not a model call.
- The model never grants itself authority: the record is observed, not proposed.

## Verification once wired

1. Settle one mission on an isolated test DB; assert one `memory_records` row with
   `mission_id = <id>`, `epistemic = SYSTEM_OBSERVED`, `status = active`.
2. Replay the settlement (recovery sweep); assert the row count is unchanged and the writer
   returned `duplicate`.
3. Ask ICOS, in a conversation scoped to that client, what happened to the mission; the
   assembled context must contain `memory:<row id>` (the `goals` stage, score ≥ episodic).
