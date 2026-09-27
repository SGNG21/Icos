# ICOS Self-Build Bootstrap — Durable State

Updated: 2026-09-27
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag
Branch: feat/autonomy-core3-goal-planner-dag

## CURRENT_MILESTONE
M1 — immutable plan lineage (in progress, uncommitted)
M0 — repository recovery: COMPLETE, see M0-RECOVERY-REPORT.md

## CURRENT_HEAD
ec5dcf5113f5f3a30bd99663a3b0c61edd2dbc96
(all M0/M1 work below is still UNCOMMITTED in the working tree)

## CERTIFIED_MILESTONES
none yet — nothing has been committed or certified by this session

## TEST_BASELINE
Pre-repair (at session start):
- typecheck: FAIL, 5 errors
- integration: 112 failed / 69 passed / 99 skipped (25 files failed)

Current:
- `pnpm run typecheck`: PASS
- `pnpm run test` (unit): PASS — 129 files, 1525 tests
- integration: 7 failed / 196 passed / 77 skipped (3 files failed)
- test DB `icos_test` rebuilt from the full migration ledger; `autonomous_plans`
  and `missions.goal_id` / `missions.plan_id` verified present in Postgres

## OPEN_DEFECTS

### MUST_NOW
1. `PostgresMissionRepository.replacePlan` deletes ALL mission_tasks, including
   `succeeded` ones. The in-memory implementation correctly preserves succeeded
   history and marks the rest superseded. Pre-existing at HEAD; it was masked by
   the `MISSION_HAS_NO_GOAL_ID` throw, which M1 removed. Breaks
   `mission-replace-plan.integration.test.ts` and
   `phase6-autonomous-e2e-postgres.integration.test.ts` SCENARIO 4.
   => Fix Postgres to match in-memory semantics. Do NOT weaken the tests.

2. `durable-scheduler.integration.test.ts` — 5 failures, not yet diagnosed.
   Must be classified as pre-existing vs caused before M1 can be committed.

### SHOULD_NEXT
3. Duplicate authority: TWO Postgres mission repositories exist —
   `src/server/repositories/postgres/mission-repository.ts` (wired in
   container.ts, the real one) and `src/server/mission/postgres-mission-repository.ts`.
   Only one may be canonical (mission N2). Needs an ADR + consolidation.

4. `applyPlan` fingerprint-retry reuse (the crash-window path where a plan row
   exists but tasks do not) is NOT yet covered by a Postgres integration test.
   In-memory cannot prove durability. Required for PLAN_LINEAGE PROVEN.

5. `UNIQUE(mission_id, plan_fingerprint)` means replanning to byte-identical
   earlier plan content is rejected. Believed correct (a no-op replan should not
   create a lineage node) but not yet explicitly decided/documented.

### LATER
6. drizzle-kit meta snapshots stop at 0009; migrations are hand-written and the
   journal is appended manually. `drizzle-kit generate` is effectively unusable.
7. `goals` / `goal_previews` use quoted camelCase columns ("goalId") while the
   rest of the schema is snake_case. Mixed convention.

## IMPORTANT_INVARIANTS (do not regress)
- planId != planFingerprint. planId is identity, fingerprint is content.
  Never use a digest as an id. Never set goalId = missionId or planId = missionId.
- predecessorPlanId references autonomous_plans(plan_id), NEVER the surrogate id.
- Previous AutonomousPlan versions are immutable: a replan INSERTs a new version,
  it never UPDATEs the old row.
- The mission current-plan pointer only advances; it never moves back to a
  superseded plan.
- A mission with no goalId is generic, not autonomous: skip plan lineage rather
  than fake it. `taskSchema` has goalId/planId optional by design;
  `autonomousTaskSpecSchema` is the strict autonomous contract (mission N11).
- Canonical fingerprint lives in ONE place: `fingerprintMissionPlan()` in
  `src/server/mission/mission-plan.ts`. Both repositories must use it.
- NEVER `JSON.stringify(plan, Object.keys(plan).sort())` — the second argument is
  a replacer whitelist applied at every depth and makes the hash blind to
  content. Regression test exists in `mission-plan.test.ts`.

## FILES_IN_PROGRESS (all uncommitted)
- src/server/mission/mission-plan.ts            (+ canonical fingerprint)
- src/server/mission/mission-plan.test.ts       (+ fingerprint tests, incl. D1 guard)
- src/server/mission/ports.ts                   (+ listPlanLineage)
- src/server/database/schema.ts                 (plan_fingerprint, predecessor FK, missions snake_case)
- src/core/contracts/autonomous-plan.ts         (planFingerprint, predecessorPlanId nullish)
- src/server/repositories/postgres/mission-repository.ts   (restored from HEAD + surgical lineage)
- src/server/services/in-memory/mission-repository.ts      (lineage parity)
- src/server/services/in-memory/__tests__/mission-repository-lineage.test.ts (rewritten, real proofs)
- drizzle/0040_autonomous_plan_lineage.sql      (hardened, additive, rollback notes)
- drizzle/meta/_journal.json                    (idx 37 / 0040)
- src/server/usecases/*.test.ts                 (goalId added — legitimate)

## NEXT_ACTION
1. Fix MUST_NOW #1 (replacePlan succeeded-history preservation in Postgres).
2. Diagnose MUST_NOW #2 (durable-scheduler failures); classify pre-existing vs caused.
3. Add the Postgres lineage integration test (OPEN_DEFECT #4).
4. Re-run typecheck + unit + integration, then commit M0+M1 atomically.
5. Do NOT drop stash@{0} until M1 is committed (it holds the only other copy of
   the schema FK work).

## STASH POLICY
- stash@{0} da52faa03d0b93fffba45410b8cfa0eeffb7b315 — harvested into M1, keep until commit.
- stash@{1}, stash@{2} — belong to feat/phase-7a-scheduler, DO NOT TOUCH.
