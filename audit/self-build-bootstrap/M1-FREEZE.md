# M1 FREEZE — Immutable Autonomous Plan Lineage

Frozen: 2026-09-27
Branch: feat/autonomy-core3-goal-planner-dag
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag

M1 was ALREADY committed before this freeze was requested. No new
implementation commit was created; this document records the facts and adds the
decision-0029 invariant lock (see section 6).

## 1. Git facts

```
$ git rev-parse HEAD
23f0591b72a72591b2e642532904e77c84ba8cf1

$ git status --short
(empty — working tree clean)

$ git show --stat --oneline HEAD
23f0591 docs(bootstrap): record M1 certification and M2 entry state
 audit/self-build-bootstrap/STATE.md | 132 +++++++++++++++++++-------
 1 file changed, 100 insertions(+), 32 deletions(-)
```

Commit chain:
```
23f0591  docs(bootstrap): record M1 certification and M2 entry state
8b93ab2  fix(core3): immutable autonomous plan lineage + repository recovery (M0/M1)   <-- M1 implementation
ec5dcf5  fix(core3): persist immutable autonomous plan lineage                        <-- pre-M1 baseline
```

## 2. Exact files included in M1 (commit 8b93ab2)

Implementation:
```
src/server/mission/mission-plan.ts                              +58   canonical fingerprintMissionPlan()
src/server/mission/ports.ts                                     +11   listPlanLineage() port method
src/server/database/schema.ts                                    29   plan_fingerprint, predecessor FK, missions snake_case
src/core/contracts/autonomous-plan.ts                           +11   planFingerprint, predecessorPlanId nullish
src/server/repositories/postgres/mission-repository.ts           322   lineage + replan history preservation
src/server/services/in-memory/mission-repository.ts              204   lineage parity
src/server/scheduler/scheduler-handlers.ts                        13   goalId made optional (CORE2 regression fix)
```

Migration:
```
drizzle/0040_autonomous_plan_lineage.sql                        +104
drizzle/meta/_journal.json                                        +7   idx 37 / tag 0040
```

Tests:
```
src/server/mission/mission-plan.test.ts                         +167  fingerprint unit proofs
src/server/services/in-memory/__tests__/mission-repository-lineage.test.ts  +280  (rewritten; replaced 4 fake empty tests)
src/server/repositories/postgres/mission-plan-lineage.integration.test.ts   +309  durable Postgres proofs
src/server/repositories/postgres/mission-replace-plan.integration.test.ts     24  superseded semantics (decision 0029)
src/server/usecases/ignite-autonomous-mission.test.ts             +6  goalId
src/server/usecases/phase6-autonomous-e2e.test.ts                +15  goalId
```

Governance:
```
docs/decisions/0029-replan-preserves-superseded-history.md       +68
audit/self-build-bootstrap/M0-RECOVERY-REPORT.md               +117
audit/self-build-bootstrap/STATE.md                            +104
```

Total: 18 files, 1689 insertions, 160 deletions.

Added by this freeze:
```
src/server/supervisor/readiness-superseded.test.ts                     decision-0029 invariant lock
audit/self-build-bootstrap/M1-FREEZE.md                               this document
```

## 3. Gate results (measured at freeze time)

| Gate | Command | Result |
|---|---|---|
| TYPECHECK | `pnpm run typecheck` | **PASS** (0 errors) |
| UNIT | `pnpm run test` | **PASS** — 130 files, 1530 tests |
| INTEGRATION | `npx vitest run --config vitest.integration.config.ts` | **PASS** — 38 files / 212 tests; 10 files / 77 tests SKIPPED (see §5) |
| DIFF_CHECK | `git diff --check` | **PASS** |
| LINT | `pnpm run lint` | 0 errors, 290 warnings (all pre-existing, see §7) |
| FORMAT | `pnpm run format:check` | **FAIL — 243 files. PRE-EXISTING, NOT part of M1.** See §7. |

Session-start baseline at ec5dcf5, for comparison:
- typecheck: FAIL, 5 errors
- integration: 112 failed / 69 passed (25 of 47 files failed)

Reproduce:
```
pnpm run test:db:setup
pnpm run typecheck && pnpm run test
npx vitest run --config vitest.integration.config.ts
```

## 4. PostgreSQL migration proof summary

Target: `icos_test` (guarded by src/server/database/test-database-guard.ts, which
refuses any database whose name lacks a `test` token or contains
probe/live/prod — the live database `icos_n23_probe` can never be reached).

**4.1 Ledger applies from empty.** `icos_test` was DROPped and rebuilt via
`pnpm run test:db:setup`, running the full migration ledger through 0040. Exit 0.

**4.2 Structure verified with `psql \d autonomous_plans`** (not inferred from the
schema file):
```
plan_fingerprint     | text | not null
predecessor_plan_id  | text |
...
"autonomous_plans_plan_id_unique"                        UNIQUE, btree (plan_id)
"autonomous_plans_mission_id_version_unique"             UNIQUE, btree (mission_id, version)
"autonomous_plans_mission_id_plan_fingerprint_unique"    UNIQUE, btree (mission_id, plan_fingerprint)
"autonomous_plans_mission_id_idx"                        btree (mission_id)
FOREIGN KEY (predecessor_plan_id) REFERENCES autonomous_plans(plan_id)
```
The FK targets `plan_id` (logical identity), NOT the surrogate `id`, as mission
N9 requires.

**4.3 missions lineage columns verified** with `psql \d missions`:
`goal_id | text` and `plan_id | text`, both nullable, plus
`missions_goal_id_idx`. Before M1 these existed ONLY in the Drizzle schema (as
quoted camelCase `"goalId"`/`"planId"`) with no migration creating them, so
autonomous plan lineage could not persist at all.

**4.4 Idempotent / re-runnable.** 0040 applied a second time via
`psql -v ON_ERROR_STOP=1 -f`: exit 0, only NOTICE "already exists, skipping".

**4.5 Legacy upgrade path proven with data.** A scratch database
`icos_test_migration` was created with `autonomous_plans` in its pre-0040 shape
(no plan_fingerprint, no predecessor_plan_id) plus one row. Applying 0040:
- exit 0;
- the existing row survived;
- `plan_fingerprint` backfilled to `legacy-unfingerprinted:plan-legacy-1` — a
  deliberately non-sha256 sentinel that cannot collide with a real fingerprint,
  so a legacy row can never be mistaken for a content match by applyPlan;
- `plan_fingerprint` then enforced NOT NULL (`attnotnull = t`),
  `predecessor_plan_id` left nullable (`f`).
Scratch database dropped afterwards.

**4.6 Rollback documented** in the migration header: additive only, no column
dropped/renamed/retyped, no row deleted or rewritten. Rolling back loses only
fingerprints and lineage pointers; plan identities and versions survive, so
CORE1/CORE2 behavior is unaffected.

## 5. Skipped integration tests — precise record

**Skipped tests are NOT pass evidence.**

All 10 files skip for ONE reason: `describe.skipIf(!dockerAvailable)`, where
`dockerAvailable` is `detectDocker()` in
`src/server/database/testing/pg-support.ts` (runs `docker info`). They use
Testcontainers to start `postgres:16-alpine`. The Docker daemon is not running
in this environment (`docker ps` -> "failed to connect to the docker API at
unix:///Users/coco/.docker/run/docker.sock"). This is an ENVIRONMENT gap, not a
code defect — no code change is needed to unlock them, only a running Docker.

| File | Skipped | Affects CORE3 certification? |
|---|---|---|
| `src/server/auth/auth-application.integration.test.ts` | 15 | NO — authentication |
| `src/server/repositories/postgres/repositories.integration.test.ts` | 14 | PARTIAL — generic repo/task persistence |
| `src/server/administration/user-agent-administration.integration.test.ts` | 13 | NO — human/agent admin links |
| `src/server/auth/auth-foundation.integration.test.ts` | 7 | NO — identity foundation |
| `src/server/database/capability-schema.integration.test.ts` | 7 | **YES — M4 capability routing** |
| `src/server/uow/postgres-action-decision-uow.integration.test.ts` | 6 | PARTIAL — UoW atomicity |
| `src/server/container.postgres.integration.test.ts` | 5 | PARTIAL — container wiring + task routes |
| `src/server/uow/postgres-capability-uow.integration.test.ts` | 4 | **YES — M4 capability routing** |
| `src/server/database/append-only.integration.test.ts` | 3 | **YES — audit/evidence immutability** |
| `src/server/auth/auth-bootstrap-cli.integration.test.ts` | 3 | NO — bootstrap CLI |
| **total** | **77** | |

**No M1 proof depends on Docker.** The lineage proofs in
`mission-plan-lineage.integration.test.ts` run against the local `icos_test`
database, so M1's PROVEN claims in §6 stand independently of these skips.

### Converted into explicit certification work
Carried into STATE.md as named certification items, NOT silently tolerated:

- **CERT-1 (blocks CORE3):** `capability-schema` + `postgres-capability-uow`
  (11 tests) must pass before CAPABILITY_ROUTING can be declared PROVEN in M4.
  Capability CHECK constraints and capability UoW atomicity are exactly the
  durable guarantees M4 depends on.
- **CERT-2 (blocks CORE3):** `append-only` (3 tests) must pass before any
  claim that evidence/audit is tamper-proof. Mission N18/N31 rest on
  append-only audit entries.
- **CERT-3 (should):** `repositories` + `container.postgres` +
  `postgres-action-decision-uow` (25 tests) are broad persistence/wiring
  regression cover; run before CORE3 certification.
- **CERT-4 (not CORE3):** the 4 auth/admin files (34 tests) are outside CORE3
  scope. Required for a release gate, not for CORE3 orchestration.

Cheapest resolution for CERT-1..3: start Docker and re-run the integration
suite. A code change (falling back to TEST_DATABASE_URL when Docker is absent,
as the lineage test does) would unlock them without Docker but touches many test
files and is NOT on the critical path — deliberately deferred.

## 6. Replan semantics preserved and verified

Semantic frozen by `docs/decisions/0029-replan-preserves-superseded-history.md`:
historical MissionTasks remain durable as `superseded`; no row is ever deleted
by a replan.

Verified that scheduler / readiness / evaluator paths cannot treat a
`superseded` task as runnable or current:

| Consumer | Mechanism | Superseded treated as runnable/current? |
|---|---|---|
| `src/server/supervisor/readiness.ts` `computeReadyTasks` | `superseded` is an explicit entry in the `nonReadyStates` deny-list | **NO** |
| same, dependency gating | deps must be in `succeededTaskIds`, built from `status === "succeeded"` only | **NO** — a superseded dependency blocks downstream (fail closed) |
| `autonomous-mission-runner.ts` `readyDraftTasks` | allow-list `status !== "draft"` -> excluded; deps must be `"succeeded"` | **NO** |
| `autonomous-mission-runner.ts` `hasActiveWork` | `ACTIVE_TASK_STATES` = {queued, running, review_pending, awaiting_approval} | **NO** |
| `autonomous-mission-runner.ts` `hasDraftTasks` | `status === "draft"` only | **NO** |
| `postgres/dispatch-attempt-repository.ts:179` | allow-list draft/review_pending/running/succeeded | **NO** |
| `supervisor-service.ts` completion | `tasks.every(t => t.status === "succeeded" \|\| t.status === "superseded")` -> mission succeeded | **Correctly tolerated** — history does not block success, and is not counted as work |

The supervisor completion line is PRE-EXISTING. It independently confirms that
supersede-don't-delete was the intended design all along and that the PostgreSQL
delete-everything behavior was the outlier, not the contract.

`superseded` is also already a first-class value in the
`mission_tasks_status_check` DB constraint and in `MissionTaskStatusSchema`.

**Locked by test:** `src/server/supervisor/readiness-superseded.test.ts` (5
tests). Mutation-verified: removing `"superseded"` from the deny-list AND
counting it as a satisfied dependency makes 4 of the 5 tests fail. The lock is
real, not vacuous.

## 7. Known-red gates that are NOT M1 regressions

- **`format:check` FAILS on 243 files.** The repository has never been
  prettier-formatted (`mission-repository.ts`'s narrow multi-line style is not
  prettier output). Running `prettier --write` would rewrite essentially the
  whole repository — the exact "rewrite mature code for convenience" churn the
  mission forbids. Needs its own decision. Unchanged by M1.
- **`lint`: 0 errors, 290 warnings.** All pre-existing. The warnings inside
  M1-touched files were verified pre-existing at HEAD: `isNull` and `or` are
  unused in `mission-repository.ts` at ec5dcf5 too (only the import line
  matches), and `HighLevelGoalSchema` was already unused in
  `autonomous-plan.ts`. M1 resolved one warning by giving `foreignKey` a real use.

## 8. Runtime wiring — which Postgres MissionRepository is authoritative

**Authoritative and wired:** `src/server/repositories/postgres/mission-repository.ts`
(class `PostgresMissionRepository`).

Evidence from `src/server/container.ts`:
```
 53: import { PostgresMissionRepository } from "@/server/repositories/postgres/mission-repository";
102: import { InMemoryMissionRepository } from "@/server/services/in-memory/mission-repository";
249:   const mission = new InMemoryMissionRepository(tasksRepository);   // in-memory container
440:   const mission = new PostgresMissionRepository(handle.db, tasks);  // postgres container
```

**Dead:** `src/server/mission/postgres-mission-repository.ts`. A repo-wide search
for importers returns nothing:
```
$ grep -rn "mission/postgres-mission-repository" src/ scripts/
>>> no matches
```
It also never touches `autonomous_plans`, so it carries none of the CORE3
lineage. It is a duplicate-authority violation of mission N2 ("one canonical
authority per concept").

**Kept as SHOULD_NEXT, deliberately NOT removed in M1.** It does not block the
critical path: it is unreferenced, so it cannot affect runtime behavior. Removing
it is a separate reversible change that needs its own ADR, and doing it here
would have mixed unrelated deletion into the lineage commit.

## 9. M1 certification status

```
PLAN_ID_NOT_FINGERPRINT         PROVEN   unit + postgres
APPLYPLAN_IDEMPOTENT            PROVEN   postgres crash-window retry reuses P1
REPLAN_NEW_IDENTITY             PROVEN   postgres, P2.planId != P1.planId
PREDECESSOR_IS_PLAN_ID          PROVEN   postgres + mutation-tested
P1_IMMUTABLE                    PROVEN   postgres, row byte-identical after replan
LINEAGE_CHAIN_P1_P2_P3          PROVEN   postgres, versions [1,2,3]
UNIQUE_PLAN_ID                  PROVEN   postgres constraint rejects
UNIQUE_MISSION_VERSION          PROVEN   postgres constraint rejects
PREDECESSOR_FK_ENFORCED         PROVEN   postgres rejects dangling predecessor
FINGERPRINT_CONTENT_SENSITIVE   PROVEN   unit + mutation-tested
FINGERPRINT_SCOPED_PER_MISSION  PROVEN   postgres
GENERIC_MISSION_NO_LINEAGE      PROVEN   postgres
SUPERSEDED_NEVER_RUNNABLE       PROVEN   unit + mutation-tested (this freeze)
MIGRATION_RERUNNABLE            PROVEN   applied twice, exit 0
MIGRATION_LEGACY_UPGRADE        PROVEN   pre-0040 table + row upgraded, no loss
CORE1_REGRESSION                PASS     integration 0 failures
CORE2_REGRESSION                PASS     integration 0 failures
TYPECHECK                       PASS
TESTS                           PASS     1530 unit + 212 integration
DIFF_CHECK                      PASS
MUST_NOW                        NONE
```

M1_IMMUTABLE_PLAN_LINEAGE_FROZEN

Not claimed: CORE3 certification. M2-M7 remain, and CERT-1/CERT-2 must be
resolved before CAPABILITY_ROUTING or evidence-immutability can be declared.
