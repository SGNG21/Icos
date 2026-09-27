# ICOS Self-Build Bootstrap — Durable State

Updated: 2026-09-27
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag
Branch: feat/autonomy-core3-goal-planner-dag

## CURRENT_MILESTONE
M3 — durable dependency/readiness engine (NEXT, not started)
M2 — canonical plan contract + task planning metadata: COMPLETE, committed 71ee3aa
M1 — immutable plan lineage: FROZEN, see M1-FREEZE.md
M0 — repository recovery: COMPLETE, see M0-RECOVERY-REPORT.md

## CURRENT_HEAD
71ee3aaa29d06dce305ea838fecefef104c9905f  (M2)
M1 freeze facts: M1-FREEZE.md §1. M1 implementation: 8b93ab2.

## CERTIFIED_MILESTONES
- M0 repository recovery — evidence in M0-RECOVERY-REPORT.md
- M1 immutable plan lineage — FROZEN, evidence in M1-FREEZE.md (commit 8b93ab2)
- M2 canonical plan contract + task planning metadata — commit 71ee3aa,
  audit in M2-POST-PHASE-AUDIT.md

### M2 proofs
PARALLEL_ROOTS_PROVEN        PROVEN (planExecutionOrder roots + levels)
DETERMINISTIC_ORDER_PROVEN   PROVEN (shuffled input -> identical order)
VALID_DAG / CYCLE_REJECTED / MISSING_REFERENCE_REJECTED /
DUPLICATE_KEY_REJECTED / SELF_DEPENDENCY_REJECTED   PASS (pre-existing validator)
UNKNOWN_RISK_FAILS_CLOSED    PROVEN (validator + DB CHECK)
PLANNER_METADATA_ORIGIN      PROVEN (planner parses + forwards envelope)
METADATA_PERSISTED           PROVEN (postgres round-trip)
SURVIVES_RESTART             PROVEN (container closed, values reread)
SURVIVES_REPLAN              PROVEN (P1 task keeps its own envelope + planId)
MIGRATION_0041_RERUNNABLE    PROVEN (exit 0 twice)
MIGRATION_0041_LEGACY_SAFE   PROVEN (populated pre-0041 tasks table upgraded)

### NOT proven by M2 (do not overclaim — M2-POST-PHASE-AUDIT S1)
The envelope is persisted but NOT yet honored at runtime: attemptBudget bounds
nothing, reviewPolicy branches nothing, requiredCapabilities does not route, and
the worker prompt still uses `task.description || task.title`. Those belong to
M4/M5 and to bounded repair.

## RUNTIME WIRING (verified, M1-FREEZE.md §8)
AUTHORITATIVE: src/server/repositories/postgres/mission-repository.ts
               (PostgresMissionRepository, container.ts:440)
IN-MEMORY:     src/server/services/in-memory/mission-repository.ts (container.ts:249)
DEAD:          src/server/mission/postgres-mission-repository.ts — zero importers,
               never touches autonomous_plans. SHOULD_NEXT, not removed in M1.

## CERTIFICATION WORK FROM SKIPPED TESTS (M1-FREEZE.md §5)
77 integration tests in 10 files are SKIPPED — all via
describe.skipIf(!dockerAvailable) (Testcontainers; Docker daemon not running
here). Skipped tests are NOT pass evidence. No M1 proof depends on Docker.

CERT-1 BLOCKS CORE3 — capability-schema (7) + postgres-capability-uow (4):
        must pass before CAPABILITY_ROUTING is PROVEN in M4.
CERT-2 BLOCKS CORE3 — append-only (3): must pass before claiming audit/evidence
        immutability (mission N18/N31).
CERT-3 SHOULD      — repositories (14) + container.postgres (5) +
        postgres-action-decision-uow (6): broad persistence regression cover.
CERT-4 NOT CORE3   — auth-application (15), auth-foundation (7),
        user-agent-administration (13), auth-bootstrap-cli (3).

Cheapest fix for CERT-1..3: start Docker, re-run the integration suite.

### M1 proofs (all factual, re-runnable) — full table in M1-FREEZE.md §9
PLAN_ID_NOT_FINGERPRINT      PROVEN (unit + postgres)
APPLYPLAN_IDEMPOTENT         PROVEN (postgres crash-window retry reuses P1)
REPLAN_NEW_IDENTITY          PROVEN (postgres: P2 planId != P1 planId)
PREDECESSOR_IS_PLAN_ID       PROVEN (postgres, + mutation-tested)
P1_IMMUTABLE                 PROVEN (postgres: row byte-identical after replan)
LINEAGE_CHAIN_P1_P2_P3       PROVEN (postgres, versions [1,2,3])
UNIQUE_PLAN_ID               PROVEN (postgres constraint rejects)
UNIQUE_MISSION_VERSION       PROVEN (postgres constraint rejects)
PREDECESSOR_FK_ENFORCED      PROVEN (postgres rejects dangling predecessor)
FINGERPRINT_CONTENT_SENSITIVE PROVEN (unit, + mutation-tested)
FINGERPRINT_SCOPED_PER_MISSION PROVEN (postgres)
GENERIC_MISSION_NO_LINEAGE   PROVEN (postgres)
SUPERSEDED_NEVER_RUNNABLE    PROVEN (unit, + mutation-tested)
MIGRATION_RERUNNABLE         PROVEN (applied twice via psql, exit 0)
MIGRATION_LEGACY_UPGRADE     PROVEN (pre-0040 table + row upgraded, no loss)
CORE1_REGRESSION             PASS (integration 0 failures)
CORE2_REGRESSION             PASS (integration 0 failures)
TYPECHECK                    PASS
TESTS                        PASS (1560 unit + 219 integration)
DIFF_CHECK                   PASS

## TEST_BASELINE
Pre-repair (session start, at ec5dcf5):
- typecheck: FAIL, 5 errors
- integration: 112 failed / 69 passed / 99 skipped (25 of 47 files failed)
- format:check: FAIL, 243 files (PRE-EXISTING, repo is not prettier-formatted)
- lint: 0 errors, ~290 warnings (PRE-EXISTING)

Current (at 71ee3aa):
- `pnpm run typecheck`: PASS
- `pnpm run test` (unit): PASS — 129 files, 1525 tests
- integration: PASS — 38 files / 212 tests, 0 failed, 10 files / 77 tests skipped
- `git diff --check`: PASS
- lint: 0 errors, 290 warnings (unchanged, all pre-existing)
- format:check: still FAIL on 243 files — PRE-EXISTING, NOT addressed. Running
  prettier --write would reformat the whole repository; that needs its own
  decision, not a drive-by commit.
- test DB `icos_test` rebuilt from the full migration ledger; autonomous_plans
  structure, 3 UNIQUE indexes and the predecessor FK verified via psql

How to reproduce:
  pnpm run test:db:setup
  pnpm run typecheck && pnpm run test
  npx vitest run --config vitest.integration.config.ts

## OPEN_DEFECTS

### MUST_NOW
NONE.

(Resolved in 8b93ab2: replacePlan destroying succeeded history -> decision 0029;
durable-scheduler failures -> the start_mission handler hard-required a goalId,
added by ec5dcf5, while igniteAutonomousMission already declared it optional.)

### SHOULD_NEXT
3. Duplicate authority: TWO Postgres mission repositories exist —
   `src/server/repositories/postgres/mission-repository.ts` (wired in
   container.ts, the real one) and `src/server/mission/postgres-mission-repository.ts`.
   Only one may be canonical (mission N2). Needs an ADR + consolidation.

4. RESOLVED in 8b93ab2 — see mission-plan-lineage.integration.test.ts.

5. `UNIQUE(mission_id, plan_fingerprint)` means replanning to byte-identical
   earlier plan content is rejected. Believed correct (a no-op replan should not
   create a lineage node) but not yet explicitly decided/documented. No test
   currently pins this behavior either way.

8. RESOLVED as a record — the 77 skips are enumerated and classified in
   M1-FREEZE.md §5 and tracked above as CERT-1..CERT-4. Still unrun.

9. `SchedulerService` has its own private `canonical()` JSON serializer for
   payload hashing, separate from `fingerprintMissionPlan`'s canonicalize().
   Two canonicalization implementations for the same concept.

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

## FILES_IN_PROGRESS
None — M0/M1 fully committed in 8b93ab2. The list below is what that commit
touched, kept for orientation.


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

## REPLAN SEMANTIC — LOCKED (M1-FREEZE.md §6)
Historical MissionTasks stay durable as `superseded`; replan deletes no rows.
Verified that computeReadyTasks, readyDraftTasks, hasActiveWork, hasDraftTasks
and the dispatch ledger all refuse superseded work, and that a superseded
DEPENDENCY does not unlock downstream tasks (fail closed).
supervisor-service.ts already treats succeeded|superseded as mission success —
pre-existing, and independent confirmation that supersede-don't-delete is the
real contract.
Locked by src/server/supervisor/readiness-superseded.test.ts, mutation-verified.
Do NOT add `superseded` to any readiness/ready/active set.

## NEXT_ACTION — M3 (durable dependency / readiness engine, mission N13)

M3 must resolve M2 audit finding S2 FIRST: the task DAG has two
representations. `mission_tasks.depends_on` holds the real edges and drives
`computeReadyTasks`; `tasks.dependencies` is persisted but every writer passes
`[]`, so the canonical Task's own edge list is permanently empty. Mission N13
requires readiness to derive from CANONICAL dependency completion, so decide
which is authoritative and stop writing the other. Do not backfill one from the
other (audit R1).

Then:
1. exactly-once DAG advancement — a dependency must be canonically completed,
   never merely claimed by a worker;
2. wire `planExecutionOrder().levels` into the readiness/parallelism path
   instead of recomputing readiness ad hoc;
3. prove: C depends on A+B advances ONLY when both are canonically succeeded;
   a superseded dependency never advances it (already locked by
   readiness-superseded.test.ts); concurrent advancement cannot double-advance.

## SUPERSEDED SECTION — M2 (kept for orientation)
`validateMissionPlan()` in src/server/mission/mission-plan.ts ALREADY rejects:
duplicate keys, unknown dependency refs, self-dependencies, duplicate edges and
cycles. M2 therefore starts from a real base. Still missing per mission N11/N12:

1. a planning-layer AutonomousTaskSpec carrying objective, instructions,
   successCriteria, requiredCapabilities, riskClass, allowedFileScope,
   expectedArtifacts, priority, attemptBudget, reviewPolicy, integrationPolicy.
   `autonomousTaskSpecSchema` already exists in src/core/contracts/task.ts —
   REUSE it, do not create a second contract. MissionPlanTask currently carries
   only key/title/description/dependsOn/workerKind/capability, and
   applyPlan hardcodes riskClass 'reversible', priority 3, attemptBudget 3,
   reviewPolicy 'if_risky' for EVERY task — that is the real M2 gap.
2. reject unsupported capabilities, invalid policies, unknown risk class,
   malformed success criteria; unknown safety-critical structure fails closed.
3. deterministic topological ordering + roots + runnable-task derivation.
4. proofs required: VALID_DAG, CYCLE_REJECTED, MISSING_REFERENCE_REJECTED,
   DUPLICATE_KEY_REJECTED, SELF_DEPENDENCY_REJECTED, PARALLEL_ROOTS_PROVEN,
   DETERMINISTIC_ORDER_PROVEN.

Then M3 durable readiness/dependency gating (mission N13).

## STASH POLICY
- stash@{0} da52faa03d0b93fffba45410b8cfa0eeffb7b315 — fully harvested into
  8b93ab2. Deliberately NOT dropped: the stash stack is shared with other
  worktrees and other sessions, so dropping is riskier than leaving it.
- stash@{1}, stash@{2} — belong to feat/phase-7a-scheduler, DO NOT TOUCH.

## WORKING RULES LEARNED THIS SESSION
- Never trust a green test until it has been mutation-tested. Two of the
  invariants in this milestone were only provable because deliberately breaking
  the implementation made the tests fail.
- Distinguish "pre-existing failure" from "failure I caused" with git evidence
  BEFORE fixing. `git log -p --follow -- <file>` found the exact commit that
  introduced the goalId regression.
- A Drizzle schema column with no migration is a silent, total persistence
  failure. Always verify against a real database with psql \d, never against
  the schema file.
