# ICOS Self-Build Bootstrap — Durable State

Updated: 2026-09-28
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag
Branch: feat/autonomy-core3-goal-planner-dag

## CURRENT_MILESTONE
M6 — non-interactive external workers: IN PROGRESS.
       M6.1 real runtime-keyed probe  — decision 0036, commit 9e808dc
       M6.2 autonomous probe sweep    — decision 0037, commit c1ca85c
       DEFECT 16 IS CLOSED: probing is real AND something calls it, durably.
       M6.3 EXECUTION ADAPTER — NOT STARTED, and it is the bulk of M6. See
       NEXT_ACTION. M6.1/M6.2 make a worker's HEALTH real; they do not yet make a
       worker DO a task. Do not read "M6 in progress" as "M6 nearly done".
M5 — multi-worker orchestration: COMPLETE and CERTIFIED (certification was
       WITHDRAWN by decision 0036 pending a scheduled prober; 0037 landed it, so
       M5 certification is RESTORED — the probe loop is no longer fake-only).
       M5.2 health probing            — decision 0033, commit a090bf0
       M5.3 durable distribution      — decision 0034, commit 7daf6c2
       M5.4 orchestration proofs      — decision 0035, commit 56a79ea
       M5.5 capacity model            — decision 0034, commit 7daf6c2
       audit in M5-POST-PHASE-AUDIT.md (15/15 certification requirements PASS)
M5.1 — worker registration + live routing: COMPLETE, decision 0032,
       audit in M5-1-POST-PHASE-AUDIT.md
M4 — capability routing: COMPLETE, decision 0031, audit in M4-POST-PHASE-AUDIT.md
M3 — canonical dependency/readiness authority: COMPLETE, committed 5bb5a2b
M2 — canonical plan contract + task planning metadata: COMPLETE, committed 71ee3aa
M1 — immutable plan lineage: FROZEN, see M1-FREEZE.md
M0 — repository recovery: COMPLETE, see M0-RECOVERY-REPORT.md

## CURRENT_HEAD
c1ca85c  M6.2 autonomous probe sweep as a durable job (defect 16 CLOSED)
  9e808dc  M6.1 real non-interactive worker probe, keyed by runtime
  a6cd8f9  M5 certification + post-phase audit + M6 entry state
  56a79ea  M5.4 concurrent multi-worker orchestration certification
  7daf6c2  M5.3 + M5.5 durable load distribution + capacity model
  a090bf0  M5.2 dated, expirable worker health evidence
  90649f3  M5.1 worker registration + live routing
  79c6c2e  M4 capability routing on durable worker state
Preceding milestones:
  716c6b8  CERT-1..CERT-4 Docker unblock (77 gated integration tests)
  5bb5a2b  M3 canonical dependency/readiness authority
  71ee3aa  M2 canonical plan contract + task planning metadata
  8b93ab2  M0/M1 immutable plan lineage
M1 freeze facts: M1-FREEZE.md §1. M1 implementation: 8b93ab2.

NOTE: this field goes STALE. It happened at M4 entry (it read 5bb5a2b while HEAD
was 716c6b8, and the M4 section still called CERT-1 a blocker that 716c6b8 had
cleared), and AGAIN at M6.2 entry: it read 56a79ea and CURRENT_MILESTONE said
"M6 NEXT, not started" while 9e808dc had already shipped M6.1 and 0036 had
WITHDRAWN M5 certification — none of which STATE.md recorded, because 9e808dc did
not touch this file. Verify CURRENT_HEAD against `git rev-parse HEAD` AND read the
HEAD commit message every phase; a commit that changes certification status but not
STATE.md leaves this file actively misleading.

## CERTIFIED_MILESTONES

### M6 PROGRESS (not a certification — M6.3 is unstarted)
- M6.1 real runtime-keyed probe — decision 0036, commit 9e808dc.
  PROVEN: adapters keyed by RUNTIME not kind; a real process is spawned
  (stdin `ignore`, killing timeout, no shell, bounded stderr); commands come from
  ICOS_WORKER_PROBE_COMMANDS with only `node` built in via process.execPath;
  malformed config REFUSES TO BOOT; `unsupported` (no adapter) stays distinct from
  `failed` (wired but unresolvable); the container WIRING is under test — the
  mutation "pass {}" fails a test.
- M6.2 autonomous probe sweep — decision 0037, commit c1ca85c.
  PROVEN (5 PostgreSQL proofs + 12 unit, 6 mutations verified):
  IGNITION_IS_DURABLE (seeded occurrence readable from another connection),
  CHAIN_RUNS_FOR_REAL (scheduler sweep really probes; verdict survives a new
  connection; successor lands ON the grid),
  RESTART_DOES_NOT_FORK_THE_CHAIN (boots 7s apart share ONE occurrence; exactly one
  link is claimable), ONCE_PER_FLEET (two processes race the real atomic PostgreSQL
  claim; the fleet is probed once), ALLOW_LIST_STILL_CLOSED ('probe_wrkers' rejected
  by scheduled_jobs_kind_check), INTERVAL_DERIVED_AND_BOUNDED (>= horizon refused at
  composition time), GRID_ALIGNMENT (unaligned now snaps to the bucket boundary),
  REPLAY_IS_HARMLESS, LOST_RECURRENCE_IS_A_DEAD_JOB, FAILING_SWEEP_IS_RETRIED (no
  successor scheduled), NO_PROBER_COMPOSED_IS_A_PERMANENT_ERROR,
  FAILED_IGNITION_ABORTS_STARTUP.
  NOT PROVEN by M6.2, do not overclaim: nothing here makes a worker EXECUTE a task.

- M5 multi-worker orchestration — decisions 0033/0034/0035,
  audit in M5-POST-PHASE-AUDIT.md. All 15 required certification items PASS:
  CAPABILITY_ROUTING_PRESERVED, HEALTH_PROBING_PROVEN, STALE_HEALTH_FAIL_CLOSED,
  DURABLE_WORKER_LOAD_PROVEN, MULTIWORKER_DISTRIBUTION_PROVEN,
  ATOMIC_MULTIWORKER_DISPATCH_PROVEN, SAFE_PARALLELISM_PROVEN,
  DEPENDENCY_GATING_PROVEN, EXACTLY_ONCE_DAG_ADVANCEMENT_PROVEN,
  PROCESS_RESTART_PROVEN, CORE1_REGRESSION_PASS, CORE2_REGRESSION_PASS,
  TYPECHECK_PASS, BUILD_PASS, DIFF_CHECK_PASS.
- M5.1 worker registration + live routing — decision 0032,
  audit in M5-1-POST-PHASE-AUDIT.md
- M4 capability routing — decision 0031, audit in M4-POST-PHASE-AUDIT.md
- M0 repository recovery — evidence in M0-RECOVERY-REPORT.md
- M1 immutable plan lineage — FROZEN, evidence in M1-FREEZE.md (commit 8b93ab2)
- M2 canonical plan contract + task planning metadata — commit 71ee3aa,
  audit in M2-POST-PHASE-AUDIT.md
- M3 canonical dependency/readiness authority — commit 5bb5a2b,
  decision 0030, audit in M3-POST-PHASE-AUDIT.md

### M5 proofs (all mutation-verified; 16 mutations applied and reverted)

M5.2 — HEALTH PROBING (defect 14 CLOSED, decision 0033)
HEALTH_PROBING_PROVEN               PROVEN (13 unit + 11 postgres: a registered
                                    worker is ineligible until probed; probing
                                    makes it routable; another process agrees
                                    from the durable rows alone)
EVIDENCE_IS_DATED                   PROVEN (last_probe_at stamped only by
                                    probe(); register() leaves it NULL. DB CHECK
                                    workers_probe_evidence_dated_check refuses
                                    any dated outcome without a timestamp)
STALE_HEALTH_FAIL_CLOSED            PROVEN at BOTH boundaries: the router refuses
                                    HEALTH_EVIDENCE_STALE at decision time, AND
                                    expireStaleEvidence() rewrites the row to
                                    unknown/unknown/stale so the STORED state
                                    converges. Either alone leaves a hole.
PROBE_FAILURE_DOES_NOT_PASS         PROVEN (a throwing adapter is recorded
                                    unhealthy/unavailable/failed — never as an
                                    absence of evidence)
UNPROBEABLE_FAILS_CLOSED            PROVEN (a worker kind with no adapter is
                                    `unsupported` and routes nothing)
RESTART_CANNOT_RESTORE_HEALTHY      PROVEN (postgres: a cold process reads the
                                    stored `healthy` and still refuses it once
                                    aged; a sweep then makes the row agree)
NO_PROVIDER_HARDWIRE                PROVEN (adapters are DATA keyed by worker
                                    kind; a novel kind becomes probeable with no
                                    code change in the prober)
DEACTIVATE_PRESERVES_AUDIT          STILL PROVEN (inactive workers are neither
                                    probed nor expired)
MIGRATION_0043_RERUNNABLE           PROVEN (psql exit 0 three times)
MIGRATION_0043_LEGACY_SAFE          PROVEN (a pre-0043 row reads back
                                    never-probed = fail closed)

M5.3 / M5.5 — DISTRIBUTION + CAPACITY (defects 15 and 12 CLOSED, decision 0034)
MULTIWORKER_DISTRIBUTION_PROVEN     PROVEN (postgres: 10 ready tasks + 3
                                    single-slot workers -> 3 distinct workers
                                    occupied, 7 tasks left ready. Before M5.3 all
                                    10 went to one worker.)
DURABLE_WORKER_LOAD_PROVEN          PROVEN (load DERIVED by counting
                                    non-terminal dispatch_attempts; a fresh
                                    process derives the identical tally. There is
                                    NO current_load column and no counter.)
DISTRIBUTION_IS_RESTART_SAFE        PROVEN (pure function of durable rows; a
                                    fresh process continues the same assignment
                                    instead of restarting a rotation)
AT_CAPACITY_ENFORCED                PROVEN (unit + postgres; maxConcurrency
                                    defaults to 1 — a worker is NOT an unlimited
                                    execution slot)
CAPACITY_POOL_ENFORCED              PROVEN (two DISTINCT workers sharing one
                                    quota cannot multiply it; an idle member of a
                                    saturated pool is refused)
POOL_CEILING_RESOLVES_DOWNWARDS     PROVEN (when members disagree the SMALLEST
                                    limit governs; one misdeclaring worker cannot
                                    raise its peers' ceiling)
ATOMIC_MULTIWORKER_DISPATCH_PROVEN  PROVEN (postgres: two concurrent prepares on
                                    one single-slot worker -> exactly 1 acquired,
                                    1 WorkerCapacityExceededError, and NO durable
                                    trace of the loser)
CAPACITY_REFUSAL_IS_BACKPRESSURE    PROVEN (the task stays `draft`/ready for a
                                    later tick — deliberately NOT `blocked`)
UNREGISTERED_WORKER_REFUSED         PROVEN (an assignment to a worker absent from
                                    the registry is refused, not left unbounded)
MIGRATION_0044_RERUNNABLE           PROVEN (psql exit 0 three times)

M5.4 — ORCHESTRATION (decision 0035)
CONCURRENT_MULTIWORKER_DISPATCH     PROVEN (postgres: A and B dispatched to
                                    DIFFERENT workers in one pass)
DEPENDENCY_GATING_PROVEN            PROVEN (C never offered while one parent is
                                    in flight)
EXACTLY_ONCE_DAG_ADVANCEMENT_PROVEN PROVEN (C dispatched once across 3 extra
                                    supervisor runs, 3 concurrent supervisors,
                                    and replayed completions)
DURABLE_WORKER_ASSIGNMENT           PROVEN (another process reads which worker
                                    holds which task — defect 12 closed)
ATOMIC_CLAIMS                       PROVEN (one owner per logical dispatch)
LEASES                              PROVEN (exclusive while live, reacquirable
                                    once expired)
FENCING                             PROVEN (unknown / cross-task / duplicate
                                    start callbacks all refused; duplicate
                                    reports alreadyRunning)
NO_STALE_MUTATION                   PROVEN (DISPATCH_ATTEMPT_STALE refuses an
                                    attempt below the authoritative one)
NO_DUPLICATE_INTEGRATION            PROVEN (replayed completions do not
                                    re-advance the DAG)
PROCESS_RESTART_PROVEN              PROVEN (restart mid-execution -> byte-
                                    identical attempt rows; an orphaned
                                    `prepared` attempt replays under the SAME
                                    deterministic workflow id)
SAFE_PARALLELISM_PROVEN             PROVEN (full diamond completes with exactly
                                    one attempt per node)

### REDUNDANT ENFORCEMENT — do not delete one half as dead code
Two properties are enforced by TWO independent layers. Mutation testing showed
removing either layer ALONE changes nothing; removing BOTH breaks the proofs.
- POOL LIMITS   : matcher gate + the prepare() transaction guard.
                  Both removed -> 2 proofs fail.
- WORKER SEPARATION : least-loaded ordering + AT_CAPACITY gate.
                  Both removed -> 6 proofs fail.
The read boundary spreads work in the normal case; the write boundary is what
holds when the load snapshot is stale — and it ALWAYS can be, because it is read
outside the transaction.

### M5.1 proofs (all mutation-verified)
REGISTRATION_IS_NOT_A_HEALTH_CLAIM  PROVEN (unit + postgres: register() cannot
                                     accept health/availability from the
                                     caller; registered-but-unprobed routes
                                     nothing. This keeps 0031's fail-closed
                                     read boundary from being bypassed at the
                                     WRITE boundary.)
RUNTIME_SUPPORT_DEFAULTS_CLOSED     PROVEN (declaring a runtime != being able
                                     to run it)
RE_REGISTRATION_RESETS_PROBE        PROVEN (a changed declaration invalidates
                                     old evidence)
PROBE_DOES_NOT_INVENT_WORKERS       PROVEN (returns null, stores nothing)
DEACTIVATE_PRESERVES_AUDIT          PROVEN (stops routing, keeps declaration
                                     and last probe)
LIVE_REGISTRATION_VISIBLE           PROVEN (postgres: routable mid-process, no
                                     restart — the M4 snapshot limitation is
                                     gone)
LIVE_UNHEALTHY_REROUTES             PROVEN (postgres: same router instance)
LIVE_LAST_WORKER_FAILS_CLOSED       PROVEN (postgres, in-process)
SUPERVISOR_END_TO_END               PROVEN (postgres: registered-unprobed ->
                                     task blocked, dispatcher NOT called;
                                     after probe -> dispatched to hermes)

### M4 proofs (all mutation-verified; 10/10 required proofs PROVEN)
REQUIRED_CAPS_FROM_CANONICAL_TASK   PROVEN (postgres: MissionTask declares no
                                     workerKind; routing derives it purely from
                                     tasks.required_capabilities)
WORKERS_DURABLE_QUERYABLE           PROVEN (postgres: written by one handle,
                                     read by another; upsert updates in place)
INACTIVE_UNHEALTHY_UNAVAILABLE_REJECTED  PROVEN (unit x6 + postgres x6)
MISSING_CAPABILITY_REJECTED         PROVEN (unit + postgres; ALL not ANY; exact
                                     match, `website` != `website.build`)
UNKNOWN_FAILS_CLOSED                PROVEN (unit + postgres: a row with only
                                     mandatory columns defaults to
                                     inactive/unknown/unknown/UNKNOWN, routes
                                     nothing)
DETERMINISTIC_SELECTION             PROVEN (unit x4 orders + postgres x3
                                     restarts, reverse insertion order)
NO_PROVIDER_HARDWIRE                PROVEN for the routing path (0 provider
                                     tokens in matcher/router/store/migration;
                                     asserted by test; a novel worker kind
                                     routes with no code change).
                                     OPEN for the selection path — see S1.
ROUTING_SURVIVES_RESTART            PROVEN (postgres: new handle + rehydrated
                                     registry gives identical decision AND
                                     identical per-candidate verdicts; a durable
                                     health change reroutes after restart)
REAL_POSTGRES                       PROVEN (20 integration tests; migration
                                     applied 3x exit 0; \d workers verified)
REVIEWER_INDEPENDENCE_PRESERVED     PROVEN (postgres: independent capable
                                     reviewer selected; producer never selected;
                                     refuses rather than self-review)
SUPERVISOR_FAILS_CLOSED             PROVEN (postgres: no eligible worker ->
                                     MissionTask blocked, dispatcher NOT called)
MIGRATION_0042_RERUNNABLE           PROVEN (exit 0 three times)
MIGRATION_0042_LEGACY_SAFE          PROVEN (mandatory-columns-only row upgraded
                                     to fail-closed defaults, no loss)

### M3 proofs (all mutation-verified)
NO_UNLOCK_BEFORE_ALL_DEPS_COMPLETE  PROVEN (unit + postgres)
DOWNSTREAM_UNLOCK_EXACTLY_ONCE      PROVEN (pure derivation; dispatched task
                                     stops being offered)
RESTART_PRESERVES_READINESS         PROVEN (container closed; readiness AND task
                                     order identical after restart)
STALE_WORKER_CANNOT_ADVANCE_DAG     PROVEN (a `running` dependency unlocks nothing)
REPLAN_CANNOT_UNLOCK_SUPERSEDED     PROVEN (postgres)
PARALLEL_ROOTS_REMAIN_PARALLEL      PROVEN (all roots returned at once)
DETERMINISTIC_ORDER_STABLE          PROVEN (stable across reads, status churn,
                                     restart)
DEPENDENCIES_IS_NON_AUTHORITATIVE   PROVEN (contradictory tasks.dependencies
                                     written straight to the DB changes nothing)

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

## CERTIFICATION WORK FROM SKIPPED TESTS — RESOLVED in 716c6b8
The 77 Docker-gated integration tests are NO LONGER SKIPPED. 716c6b8 started the
local Docker daemon and fixed the configuration gap the skip was hiding (four
suites called loadEnv() without OmniRoute reviewer settings, which container.ts
requires for the PostgreSQL backend).

CERT-1 RESOLVED — capability-schema (7) + postgres-capability-uow (4) PASS.
        This was M4's declared blocker; it was already cleared before M4 began.
CERT-2 RESOLVED — audit append-only (3) PASS. Evidence immutability is proven.
CERT-3 RESOLVED — repositories (14) + container.postgres (5) +
        postgres-action-decision-uow (6) PASS.
CERT-4 PARTIAL  — auth-application (15), auth-foundation (7),
        user-agent-administration (13) PASS.
        auth-bootstrap-cli (3) STILL FAILS — see MUST_BEFORE_CERTIFICATION.

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
TESTS                        PASS (1585 unit + 227 integration)
DIFF_CHECK                   PASS

## TEST_BASELINE
Pre-repair (session start, at ec5dcf5):
- typecheck: FAIL, 5 errors
- integration: 112 failed / 69 passed / 99 skipped (25 of 47 files failed)
- format:check: FAIL, 243 files (PRE-EXISTING, repo is not prettier-formatted)
- lint: 0 errors, ~290 warnings (PRE-EXISTING)

Current (at M6.2 / c1ca85c, all MEASURED — re-measure, never inherit):
- `pnpm run typecheck`: PASS
- `pnpm run build`: PASS (next build, full route manifest)
- `pnpm run test` (unit): PASS — 137 files, 1701 tests (M6.1: 1683, M5: 1667)
- `pnpm run test:integration`: 388 passed / 3 FAILED / 0 skipped (M6.1: 383/3)
- the 3 failures are D1 auth-bootstrap-cli, PRE-EXISTING. The count has never
  moved across M4, M5, M6.1, M6.2. NOT skipped, must never be re-skipped.
- migration 0045 applied 3x via psql, exit 0 each time
- `pnpm db:verify-ledger <url>`: LEDGER_OK, 43 rows match the journal
  (NOTE: this script REQUIRES the url as argv; bare `pnpm db:verify-ledger` exits 1)
- lint: 0 errors, 289 warnings — EQUAL to the M3/M4/M5 baseline
- `git diff --check`: PASS
- format:check: still FAIL on 243 files — PRE-EXISTING, NOT addressed
- psql evidence: `scheduled_jobs_kind_check` accepts 'probe_workers' and REJECTS
  'probe_wrkers', so widening the allow-list did not make `kind` free text

Previous (at M5, kept for drift comparison):
- `pnpm run typecheck`: PASS
- `pnpm run build`: PASS (next build, full route manifest)
- `pnpm run test` (unit): PASS — 135 files, 1667 tests
- `pnpm run test:integration`: 369 passed / 3 FAILED / 0 skipped
- CORE1 regression: 1/1 PASS (src/test/n1-restart-recovery.test.ts)
- CORE2 regression: 64/64 PASS across 15 files (dispatch-race,
  concurrent-dispatch-recovery, multiworker-concurrent, dag-multibranch,
  mission-restart, dispatch-recovery, autonomous-mission-runner-restart,
  dispatch-attempt-repository, mission atomicity/apply-plan/runtime)
- migrations 0043 and 0044 each applied 3x via psql, exit 0 each time
- `pnpm db:verify-ledger`: LEDGER_OK, 42 rows match the journal

BASELINE DRIFT, MEASURED: at session start the integration suite was
327 passed / 3 failed / 0 skipped. The handoff note claimed 301 and the
CURRENT section above claimed 321. NEITHER was current — always re-measure.
M5 added 42 proofs (11 health + 16 distribution/capacity + 15 orchestration).

The 3 failures are auth-bootstrap-cli, pre-existing, tracked below as D1 —
NOT skipped, and must never be re-skipped.
- `git diff --check`: PASS
- lint: 0 errors, 289 warnings (EQUAL to the M3/M4 baseline; the one warning M5
  briefly introduced was removed)
- format:check: still FAIL on 243 files — PRE-EXISTING, NOT addressed. Running
  prettier --write would reformat the whole repository; that needs its own
  decision, not a drive-by commit.
- migration 0042 applied 3x via psql (exit 0 each time); `\d workers` shows 15
  columns, 5 CHECK constraints, 2 indexes and fail-closed defaults

How to reproduce:
  pnpm run test:db:setup
  pnpm run typecheck && pnpm run test
  pnpm run test:integration
  npx vitest run src/core/workers src/server/routing src/server/services/worker-registry
  npx vitest run --config vitest.integration.config.ts src/server/routing \
    src/server/services/worker-registry src/server/supervisor

## OPEN_DEFECTS

### MUST_NOW
NONE.

### MUST_BEFORE_FINAL_CERTIFICATION (mandatory defect, not a blocker for M6)
D1 — `src/server/auth/auth-bootstrap-cli.integration.test.ts`: 3 tests fail by
     60s timeout. Pre-existing (CERT-4), first surfaced by 716c6b8. Confirmed
     NOT caused by M4 and NOT caused by M5: neither milestone touches any file
     under src/server/auth/, no CLI and no bootstrap path. Still 3 failures at
     M5, exactly as at M4 — the count has never moved.
     These tests are NOT skipped and MUST NOT be re-skipped.
     They block final ICOS_SELF_BUILD_E2E certification.

(Resolved in 8b93ab2: replacePlan destroying succeeded history -> decision 0029;
durable-scheduler failures -> the start_mission handler hard-required a goalId,
added by ec5dcf5, while igniteAutonomousMission already declared it optional.)

### SHOULD_NEXT
10. (M4) `AIResourceCatalog` is a SECOND hardcoded source of worker capability
    truth, and its engine is dead. It hardcodes worker kinds WITH capabilities
    (agent/other/hermes), model ids (gpt-4, claude-3-opus, claude-3-sonnet) and
    providers; `AdaptedAIResourceCatalog` intersects the durable registry with
    it, so a registered worker kind absent from that list can never become a
    selection candidate. NOT on the dispatch path — `AISelectionEngine` has zero
    consumers. Requirement "no provider hardwire" is PROVEN for routing and OPEN
    for selection. Belongs to the M5/M6 Resource Manager.

11. RESOLVED in M5.1 (decision 0032) — CapabilityRouter reads the durable
    store per decision. The sync read model remains only for the three
    synchronous consumers.

12. (M4) `dispatch_attempts` records the routed `worker_kind` but not the
    selected worker `id`. M5 needs the id to attribute work and to give reviewer
    independence a real producer identity. Additive column.

13. RESOLVED in M5.1 (decision 0032) — `WorkerRegistrationService`
    (container.workerRegistration) is the write side: register / probe /
    deactivate / deregister.
    SUCCESSOR DEFECT 14 below: nothing PROBES yet.

14. RESOLVED in M5.2 (decision 0033) — WorkerHealthProber.probeAll() produces
    evidence and expireStaleEvidence() invalidates what nothing refreshed.
    SUCCESSOR DEFECT 16 below: no adapter exists yet, so nothing REAL is probed.

15. RESOLVED in M5.3 (decision 0034) — selection orders by (durable load,
    worker id), derived from non-terminal dispatch_attempts. Restart-safe
    because it is a pure function of durable rows.

16. RESOLVED — M6.1 (decision 0036) + M6.2 (decision 0037), defect CLOSED.
    0036: adapters are keyed by RUNTIME (not worker kind), `CommandWorkerProbe`
    really runs a runtime with stdin `ignore` and a killing timeout, commands come
    from ICOS_WORKER_PROBE_COMMANDS, and malformed config REFUSES TO BOOT.
    0037: `probe_workers` is a durable `scheduled_jobs` kind (migration 0045), the
    interval is derived from the evidence horizon and refused if it exceeds it,
    occurrences are snapped to a shared GRID, and `startProductionServices`
    IGNITES the chain unconditionally (a self-perpetuating chain still needs a
    first link — defect 16 one level up).
    NOT covered by either: making a worker EXECUTE A TASK. See M6.3 in NEXT_ACTION.

17. (M5) NO WORKER-DEATH RECOVERY. A worker that dies MID-EXECUTION is DETECTED
    — its probe evidence expires and it becomes ineligible — but the task it was
    holding is never reassigned: the dispatch attempt stays `dispatched` and its
    capacity stays consumed forever, so that slot is permanently lost.
    Detection without reassignment. This is M7 (automatic recovery) and it is
    the single largest remaining hole in CORE3.

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

## CANONICAL AUTHORITIES (decision 0030) — do not add a second one
DAG EDGES    : mission_tasks.depends_on          (tasks.dependencies is NOT authoritative)
READINESS    : src/server/supervisor/readiness.ts computeReadyTasks  (ONE engine)
COMPLETION   : CANONICAL_COMPLETION_STATUS = "succeeded" only
ELIGIBILITY  : READY_ELIGIBLE_STATUSES = {draft}  — ALLOW-list, fail closed
PLAN CONTENT : fingerprintMissionPlan()           (planId != planFingerprint)
PLAN LINEAGE : autonomous_plans, predecessorPlanId -> plan_id (never surrogate id)
MISSION REPO : src/server/repositories/postgres/mission-repository.ts
WORKER ELIGIBILITY : src/core/workers/worker-eligibility.ts  (ONE matcher —
               decision 0031. Every gate is an ALLOW-list of one exact value:
               active / SUPPORTED_RUNTIME / healthy / available / ALL
               capabilities. "unknown" is NEVER a pass. Reviewer selection,
               bounded repair and the AI catalog adapter all delegate to it.
               Do NOT hand-roll a fourth filter.)
WORKER REGISTRY : `workers` table (migration 0042) is durable truth;
               InMemoryWorkerRegistry is a hydrated READ MODEL, never authority.
WORKER REGISTRATION : src/server/services/worker-registry/worker-registration-service.ts
               (decision 0032. REGISTRATION IS NOT A HEALTH CLAIM: register()
               structurally cannot accept health/availability from the caller;
               a new worker is unknown/unknown/UNKNOWN and routes nothing until
               probe() records real evidence. Do NOT add a "trusted" register.)
WORKER HEALTH  : src/server/services/worker-registry/worker-health-prober.ts
               (decision 0033. HEALTH IS EVIDENCE, NOT A FLAG: it is dated by
               probe() and by nothing else, and it EXPIRES. probeAll() refreshes,
               expireStaleEvidence() durably invalidates what nothing refreshed.
               Adapters are DATA keyed by worker kind — no provider is named. A
               kind with no adapter is `unsupported` and routes nothing; a probe
               that THROWS is unhealthy/failed, never "no evidence".
               Do NOT add an in-memory health cache — that is the M4 snapshot bug.)
WORKER LOAD    : DERIVED by counting non-terminal dispatch_attempts per
               worker_id (decision 0034). There is deliberately NO
               workers.current_load column and NO round-robin cursor: a counter
               is a second authority that can disagree with the ledger, and an
               in-memory cursor silently breaks ROUTING_SURVIVES_RESTART.
               computeWorkerLoad() is the ONE definition of "load".
WORKER CAPACITY: workers.max_concurrency (default 1 — a worker is NOT an
               unlimited execution slot) + capacity_pool / capacity_pool_limit
               for a SHARED provider/account quota (decision 0034). A pool
               ceiling resolves DOWNWARDS when members disagree. Enforced at the
               read boundary (matcher gates) AND inside prepare()'s transaction
               under a row lock — see REDUNDANT ENFORCEMENT above.
CAPABILITY ROUTING : src/server/routing/capability-router.ts
               Reads the DURABLE STORE per decision (0032), not a snapshot.
               IMPOSES the health-evidence horizon rather than trusting callers
               with it, and derives the load snapshot per decision (0033/0034).
               ROUTED | NO_ELIGIBLE_WORKER (fail closed, task -> blocked) |
               ROUTING_UNCONFIGURED (registry EMPTY only — pre-M4 behaviour).
               A NON-EMPTY registry is authoritative and fails closed.
Readiness is NEVER persisted — only derived. A stored ready flag is rejected (R5):
derived state that can disagree with the DAG is how double-unlock bugs appear.

## NEXT_ACTION — M6.3 (external worker EXECUTION adapter)

M6.1 + M6.2 closed defect 16: worker HEALTH is now real and autonomously
maintained. That is the smaller half of M6. What remains is the bulk of it, and
nothing below is done yet:

1. PROGRAMMATIC TASK EXECUTION. A worker must be LAUNCHED to do a task, not just
   pinged. `CommandWorkerProbe` proves the non-interactive process discipline that
   an executor must reuse — stdin `ignore`, a timeout that KILLS, no shell, bounded
   stderr, never-rejects-always-returns — but it answers "are you alive", not
   "do this work".
2. TASK CONTRACT INJECTION. The prompt / task contract must reach the worker
   automatically, with no human pasting anything. `autonomousTaskSpecSchema`
   (src/core/contracts/task.ts) is the existing contract — REUSE it.
3. OUTPUT AND RESULT CAPTURE. stdout/stderr, exit status, and the commit / artifact
   / evidence the worker produced. `dispatch_attempts` and
   `task_execution_results` already exist; check what they can already carry before
   adding columns.
4. FAILURE CLASSIFICATION. Session exhaustion, provider failure, and retryable vs
   permanent must be DISTINCT. A retryable failure has to resume the SAME logical
   task, not fork a new one. Note the precedent from 0037: "cannot verify" must
   never be allowed to look like "verified fine".
5. NO PROVIDER HARDWIRE. Adapters register as DATA, keyed by runtime (0036). No
   provider name may enter the matcher, router, prober, executor or schema.
   Worker != Runtime != Model != Provider != Account != CapacitySlot.
6. ISOLATION. Writer workers get their own worktree; readers may share a checkout
   only if strictly read-only. `WorktreeManager` already exists — check it first,
   and note the known worktree-collision history in project memory.

STILL OPEN from M5 for selection (defect 10): `AIResourceCatalog` is a SECOND
hardcoded source of capability truth with hardcoded provider/model names, and
`AdaptedAIResourceCatalog` intersects the durable registry with it. Not on the
dispatch path (`AISelectionEngine` has zero consumers), so "no provider hardwire"
is PROVEN for routing/probing and OPEN for selection. It belongs to M6.3 or the
Resource Manager, and it must not be allowed to leak provider names into execution.

Then M7 — AUTOMATIC RECOVERY — defect 17, now the largest structural hole: a worker
that dies mid-execution IS detected (its evidence expires, it becomes ineligible)
but its task is never reassigned, so the dispatch attempt stays `dispatched` and its
capacity slot is lost permanently. Detection without reassignment. M7 needs a
durable execution lease with an expiry; `dispatch_attempts` already has
claim_token / claim_until for RECOVERY claims — decide DELIBERATELY whether to reuse
them for execution leases or add a separate concept, and record it as a decision.

Already available and proven:
- `container.workerRegistration` — register / probe / deactivate / deregister,
  fail-closed on registration, capacity declarable at registration;
- `container.workerHealthProber` — probeAll / expireStaleEvidence / sweep, composed
  with REAL runtime-keyed adapters (0036) and swept autonomously (0037);
- `container.workerRegistryStore` — durable truth;
- `container.capabilityRouter` — live reads, imposed evidence horizon, derived
  load, per-candidate refusal evidence;
- `dispatchAttempts.listActiveWorkerAssignments()` — the durable load signal;
- fail-closed dispatch: no eligible worker -> MissionTask `blocked`; full worker
  -> back-pressure, task stays ready;
- the durable scheduler as a recurrence primitive: an allow-listed `kind`, a
  grid-aligned idempotency key, and unconditional ignition at startup (0037) — the
  pattern to REUSE for any future periodic sweep, instead of a timer.

Critical path after M6:
  M7 automatic recovery -> CORE3 chaos certification ->
  Self-Development Supervisor -> ICOS_SELF_BUILD_E2E PASS
  (D1 must be fixed before that final PASS.)

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
- RE-MEASURE the baseline; never inherit it. At M5 entry the handoff said 301
  integration tests and STATE.md said 321; the truth was 327. A stale baseline
  makes every later delta a guess.
- `recover()` replays the latest checkpoint. An integration suite that truncates
  missions and tasks but NOT `checkpoints` (and `context_items`) inherits the
  previous test's DAG state, and the symptom looks exactly like a routing
  defect. Dump the durable rows before blaming the code.
- When a green test suite survives a mutation, that is information, not a pass.
  Twice in M5 it meant the property was enforced REDUNDANTLY by a second layer;
  the useful mutation was then removing BOTH. A single mutation that changes
  nothing has proven nothing.
- Distinguish "the code is wrong" from "my assertion is wrong". Two M5.4
  failures were wrong assumptions about production behaviour (the completion
  path continues the mission itself; claimPrepared rejects a non-positive
  lease), not defects. Read the implementation before editing it.
- A green suite under mutation can be green BY ACCIDENT. Replacing the occurrence
  grid with `now + interval` (M6.2) left everything passing, because the
  composition-level tests boot twice inside the same second and the idempotency key
  is second-granular. The bug was real and the coincidence hid it. When a mutation
  survives, ask what is masking it before concluding the property is enforced —
  here the answer was "test clock granularity", and the fix was an INJECTED clock.
- Distinguish "the code is wrong" from "my assertion is wrong" (again, twice in
  M6.2). A fixed test clock set to a past instant makes a seeded job immediately
  DUE in wall-clock terms, so "exactly one claimable job" failed for a reason that
  had nothing to do with the code; and drizzle WRAPS PostgreSQL errors, so a CHECK
  constraint name travels in `error.cause`, not `error.message`.
- A self-perpetuating chain needs IGNITION, and that is a separate defect from the
  recurrence itself. M6.1 fixed "the probe is fake"; M6.2 had to fix both "nothing
  calls it on a timer" AND "nothing creates the first occurrence". Whenever a
  design says "it schedules its own successor", ask who creates link zero.
- `pnpm db:verify-ledger` REQUIRES the database url as argv; bare invocation exits 1
  with a usage line. Test DB url is `postgres://$(whoami)@localhost:5432/icos_test`.
- An under-specified test stub is not a supported composition. Two Container stubs
  omitted the non-optional `scheduledJobs`, which only surfaced when startup began
  using it. Casting with `as unknown as Container` defers that discovery to the next
  person; prefer a real in-memory implementation so wiring is observed through rows.
