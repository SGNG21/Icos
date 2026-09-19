# Phase 7B (Operational Memory) — integration handoff

Branch `feat/phase-7b-memory` (worktree `/Users/coco/icos-worktrees/phase-7b-memory`). Design: `docs/icos/phase-7b-memory/DESIGN.md`.
Nothing here depends on the Phase 7A Scheduler contract. **No shared source file was modified** except
`drizzle/meta/_journal.json` (one appended entry). Everything below is for the integrator.

## 1. Migration renumbering (REQUIRED if 7A merges first — it will)

7A's working tree already holds `drizzle/0030_scheduled_jobs.sql` (journal `idx 27`, `when 1789700000000`).
7B ships `drizzle/0031_operational_memory.sql` (journal `idx 27` on this branch, `when 1789800000000`).

Merge steps:

1. Keep 7A's `0030_scheduled_jobs` entry as `idx 27`; re-add 7B's entry as `idx 28`, tag `0031_operational_memory`.
2. `when` MUST stay strictly increasing (Drizzle skips any migration whose `when` is <= the last applied one):
   7B's `when` (1789800000000) is already > 7A's. If 7A is renumbered/re-timestamped later, bump 7B's again.
3. If 7A ends up on `0031`, rename 7B's file to the next free number and change the `tag` in the journal to match;
   nothing else references the number (the SQL header comment mentions it — update it).
4. `pnpm test` (`migration-journal.test.ts`: file↔journal bijection, contiguous idx, increasing `when`, unique prefixes).

Verified: 7A's real `0030` + 7B's `0031` with a merged journal applies from a blank database through Drizzle's
`migrate()` (29 migrations, all 5 memory tables + `scheduled_jobs` present).

## 2. Shared-file patches (documented, NOT applied)

| File                                    | Patch                                                                                           | Needed?                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `drizzle.config.ts`                     | add `"./src/server/database/memory-schema.ts"` to the `schema` array                            | only for future `db:generate` (already unusable repo-wide, snapshots ≤0009) |
| `src/server/container.ts` (7A edits it) | build `MemoryService` when `PERSISTENCE=postgres` (snippet below)                               | when memory is wired into the runtime                                       |
| QC / mission runtime (7A-adjacent)      | call recorders after an execution result, review decision, plan and terminal transition (below) | when memory is wired into the runtime                                       |

```ts
// container wiring (postgres backend only — there is deliberately no in-memory backend)
const missionMemory = new PostgresMissionMemoryStore(db);
const proceduralMemory = new PostgresProceduralMemoryStore(db);
const businessMemory = new PostgresBusinessMemoryStore(db);
const memory = new MemoryService({
  mission: missionMemory,
  procedural: proceduralMemory,
  business: businessMemory,
  log: new PostgresRetrievalLogStore(db),
}); // traced READ path; writes go through the store instances
const runtimeActor = {
  tenantId: CURRENT_SINGLE_TENANT_ID,
  kind: "system",
  id: "icos-runtime",
  permissions: [],
} as const;

// after recording a task execution result (system actor, idempotent — safe on replay):
for (const e of executionResultToMissionMemory(missionId, missionTaskId, result))
  await missionMemory.append(runtimeActor, e);
for (const o of executionResultToObservations(missionId, result))
  await proceduralMemory.observe(runtimeActor, o);
```

Suggested hook points, all idempotent so a scheduler retry cannot duplicate memory: result recorded → `executionResultToMissionMemory`

- `executionResultToObservations`; review decision saved → `reviewDecisionToMissionMemory`; plan applied →
  `missionPlanToMemory`; mission reaches `succeeded|failed|cancelled` → `terminalStateToMemory`; mission created →
  `missionObjectiveToMemory`. Recorders take plain contract objects and return plain inputs (no I/O).

Tenant: all calls take `tenantId`. Until COMPLIANCE-1 lands, pass `CURRENT_SINGLE_TENANT_ID` (`"default"`) from `src/core/identity/tenant.ts`.

## 3. Dependencies on 7A

None. 7B imports only existing contracts (`TaskExecutionResult`, `ReviewDecisionRecord`) and the `missions` table
(FK `mission_memory_entries.mission_id`, `ON DELETE RESTRICT` — a mission with memory cannot be deleted).

## 4. Test database

7B's PostgreSQL tests run on a **dedicated** database, not the shared `icos_test`:

```
createdb icos_test_7b_memory   # name must contain a `test` token and no probe|live|prod
ICOS_TEST_DATABASE_URL=postgres://$USER@localhost:5432/icos_test_7b_memory pnpm test:integration
```

Why: two branches migrating the same DB with different journals is unsafe — Drizzle skips migrations by `when`
order, so whichever branch migrates second can be silently skipped. Re-run on the shared `icos_test` only after both
migrations are merged and the journal is final. Testcontainers suites (10 files) are skipped when Docker is down.

## 5. Risks

- R1 migration number / `when` collision (above). R2 `_journal.json` textual merge conflict (trivial, append-only).
- R3 shared `icos_test` (above). R4 no RLS anywhere in the repo yet: isolation is `tenant_id` predicates; `tenant_id` is the RLS key.
- R5 `decided_by/at` on business memory keeps only the last human decision (see DESIGN §9).
- R6 `learned_patterns` (Phase 5) overlaps procedural memory conceptually; both coexist, no data migrated.
