# 0030: One canonical authority for task dependency and readiness semantics

## Status
Accepted

## Context

CORE3 M2's post-phase audit (finding S2) recorded two representations of the same
DAG concept. A full read/write trace confirmed it, and found a second duplication
in the readiness engine itself.

### Duplication 1 — dependency edges

`mission_tasks.depends_on` (`MissionTask.dependsOn`)
- WRITTEN with real edges by `applyPlan`/`replacePlan`, which resolve planner
  keys to `MissionTask.id` values.
- READ by every readiness decision.
- De facto authority.

`tasks.dependencies` (`Task.dependencies`, added by migration 0041)
- WRITTEN by six call sites, every one of which passes `[]`:
  `postgres/mission-repository.ts` 103/324/577 and
  `in-memory/mission-repository.ts` 64/233/376.
- Also settable by an external caller: `POST /api/tasks` forwards
  `createTaskBodySchema.dependencies` into `TaskRepository.create`, so the column
  CAN be populated.
- READ only by `rowToTask()` hydration.
- Consulted by ZERO scheduling, readiness, unlock, completion-propagation,
  restart-recovery or replanning logic.

So it is an inert field that an external caller can fill, which looks
authoritative and is not. That is the dangerous shape: the next person to add
dependency logic has two plausible places to read from.

### Duplication 2 — the readiness engine itself

Two implementations with identical task-status semantics:
- `computeReadyTasks(mission, tasks)` in `src/server/supervisor/readiness.ts`,
  used by `supervisor-service.ts:140`.
- a private `readyDraftTasks(tasks)` inside
  `src/server/autonomy/autonomous-mission-runner.ts`, used at its cycle loop.

Proven equivalent: `MissionTaskStatusSchema` has exactly ten states, and
`computeReadyTasks`'s deny-list named nine of them, leaving only `draft` — which
is precisely `readyDraftTasks`'s allow-list. The only difference was that
`computeReadyTasks` additionally returns `[]` for a terminal mission.

Two engines computing readiness is worse than two columns storing edges: they can
drift silently while both look correct.

## Decision

**1. `mission_tasks.depends_on` is the single canonical authority for autonomous
DAG edges.** Readiness, unlock and DAG advancement derive from it and nothing
else.

**2. `Task.dependencies` / `tasks.dependencies` is explicitly
NON-AUTHORITATIVE.** It is advisory metadata for generic tasks. It is documented
as such in the Zod contract and in the Drizzle schema. It is never consulted for
readiness. The autonomous plan path always writes it empty.

It is DEMOTED rather than REMOVED because `POST /api/tasks` accepts it today;
dropping the column and the API field is a breaking external change that deserves
its own migration and deprecation, and it is not on the CORE3 critical path. The
demotion is proven by test, not merely asserted: a task row carrying contradictory
`dependencies` content produces an unchanged readiness result.

**3. `src/server/supervisor/readiness.ts` is the single readiness authority.**
`readyDraftTasks` is deleted. `AutonomousMissionRunner` calls
`computeReadyTasks`. There is one readiness engine in ICOS.

**4. A dependency is satisfied only at `CANONICAL_COMPLETION_STATUS`
(`succeeded`).** Exported as a named constant. Nothing else qualifies — not
`running`, not `review_pending`, not `superseded`. A worker asserting completion
does not advance the DAG; only canonical persisted completion does (mission N13).

**5. Ready-eligibility is an ALLOW-list, not a deny-list.**
`READY_ELIGIBLE_STATUSES = {draft}`. A status added to the MissionTask contract in
future is NOT runnable until deliberately listed. The previous deny-list would
have silently treated any new status as runnable — unsafe by omission.

**6. An unresolvable dependency blocks forever.** A `dependsOn` id not present in
the mission's task graph can never be observed complete, so it never unlocks.
Ignoring an edge that cannot be resolved would advance the DAG past work that does
not exist.

## Consequences

- Readiness is a pure derivation from persisted state with no internal
  bookkeeping. Calling it repeatedly is idempotent, and a restart recomputes the
  identical answer from the database. "Unlock" is therefore not an event that can
  fire twice; exactly-once DISPATCH remains the dispatch ledger's job, which is
  where fencing already lives.
- The runner and supervisor can no longer disagree about what is runnable.
- `tasks.dependencies` remains in the schema and the HTTP API, inert. Removing it
  is tracked as future work, not as a blocker.
- Anyone adding dependency semantics has exactly one correct place to do it.

## Alternatives rejected

- **Keep both synchronized.** Explicitly rejected. Synchronization is not one
  authority; it is two authorities plus a new failure mode when they diverge.
- **Promote `tasks.dependencies` to canonical.** It would mean rewriting both
  readiness paths, migrating data into a column nothing reads, and changing the
  meaning of an external API field, for no behavioral gain. The canonical edges
  already live where every consumer reads them.
- **Backfill `tasks.dependencies` from `mission_tasks.depends_on`.** Rejected in
  the M2 audit (R1) and again here: it entrenches the duplication it pretends to
  resolve.
- **Drop the column now.** Rejected for this milestone: breaking external API
  change, off the critical path. Demotion achieves the invariant; removal is
  cleanup.
