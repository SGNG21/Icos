# ICOS Self-Build Bootstrap — Durable State

Updated: 2026-09-27
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag
Branch: feat/autonomy-core3-goal-planner-dag

## CURRENT_MILESTONE
M5.2 — worker probing + load distribution (NEXT, not started)
M5.1 — worker registration + live routing: COMPLETE, decision 0032,
       audit in M5-1-POST-PHASE-AUDIT.md
M4 — capability routing: COMPLETE, decision 0031, audit in M4-POST-PHASE-AUDIT.md
M3 — canonical dependency/readiness authority: COMPLETE, committed 5bb5a2b
M2 — canonical plan contract + task planning metadata: COMPLETE, committed 71ee3aa
M1 — immutable plan lineage: FROZEN, see M1-FREEZE.md
M0 — repository recovery: COMPLETE, see M0-RECOVERY-REPORT.md

## CURRENT_HEAD
M4 commit (see `git log -1`). Preceding milestones:
  716c6b8  CERT-1..CERT-4 Docker unblock (77 gated integration tests)
  5bb5a2b  M3 canonical dependency/readiness authority
  71ee3aa  M2 canonical plan contract + task planning metadata
  8b93ab2  M0/M1 immutable plan lineage
M1 freeze facts: M1-FREEZE.md §1. M1 implementation: 8b93ab2.

NOTE: this field was STALE at M4 entry — it read 5bb5a2b while HEAD was 716c6b8,
and the M4 section below still declared CERT-1 a blocker that 716c6b8 had
already cleared. Verify CURRENT_HEAD against `git rev-parse HEAD` every phase.

## CERTIFIED_MILESTONES
- M5.1 worker registration + live routing — decision 0032,
  audit in M5-1-POST-PHASE-AUDIT.md
- M4 capability routing — decision 0031, audit in M4-POST-PHASE-AUDIT.md
- M0 repository recovery — evidence in M0-RECOVERY-REPORT.md
- M1 immutable plan lineage — FROZEN, evidence in M1-FREEZE.md (commit 8b93ab2)
- M2 canonical plan contract + task planning metadata — commit 71ee3aa,
  audit in M2-POST-PHASE-AUDIT.md
- M3 canonical dependency/readiness authority — commit 5bb5a2b,
  decision 0030, audit in M3-POST-PHASE-AUDIT.md

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

Current (at M4):
- `pnpm run typecheck`: PASS
- `pnpm run test` (unit): PASS — 133 files, 1619 tests (M3 was 1585; +34 from M4)
- `pnpm run test:integration`: 321 passed / 3 FAILED / 0 skipped
  (M3-era was 227 passing + 77 skipped; 716c6b8 unblocked the skips to 301/3/0;
  M4 adds 20 → 321/3/0). The 3 failures are auth-bootstrap-cli, pre-existing,
  tracked below as D1 — NOT skipped, and must never be re-skipped.
- `git diff --check`: PASS
- lint: 0 errors, 289 warnings (EQUAL to the M3 baseline; the one warning M4
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
  npx vitest run src/core/workers src/server/routing
  npx vitest run --config vitest.integration.config.ts src/server/routing

## OPEN_DEFECTS

### MUST_NOW
NONE.

### MUST_BEFORE_CERTIFICATION (mandatory defect, not a blocker for M5)
D1 — `src/server/auth/auth-bootstrap-cli.integration.test.ts`: 3 tests fail by
     60s timeout. Pre-existing (CERT-4), first surfaced by 716c6b8. Confirmed
     NOT caused by M4: `git status` for the M4 commit touches no file under
     src/server/auth/, no CLI and no bootstrap path.
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

14. (M5.1) NOTHING PROBES. WorkerRegistrationService RECORDS probe evidence but
    no loop PRODUCES it, so without an operator calling probe() every worker
    stays ineligible. Correct failure direction, but not orchestration. M5.2.

15. (M5.1) SELECTION DOES NOT DISTRIBUTE. selectWorker returns
    first-eligible-by-id, so ten ready tasks with three healthy workers all go
    to the same worker. Exactly-once dispatch PER TASK is already certified
    (CORE2 dispatch-race / concurrent-recovery / multiworker-concurrent) — the
    gap is load distribution. Core of M5.2.
    ANY distribution policy MUST stay a pure function of durable state, or
    ROUTING_SURVIVES_RESTART (decision 0031) stops holding. An in-memory
    round-robin counter would silently break it.

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
CAPABILITY ROUTING : src/server/routing/capability-router.ts
               Reads the DURABLE STORE per decision (0032), not a snapshot.
               ROUTED | NO_ELIGIBLE_WORKER (fail closed, task -> blocked) |
               ROUTING_UNCONFIGURED (registry EMPTY only — pre-M4 behaviour).
               A NON-EMPTY registry is authoritative and fails closed.
Readiness is NEVER persisted — only derived. A stored ready flag is rejected (R5):
derived state that can disagree with the DAG is how double-unlock bugs appear.

## NEXT_ACTION — M5.2 (worker probing + load distribution)

M4 built the routing table and the matcher. M5.1 made it live and gave it a
write side. M5.2 has to make it carry CONCURRENT work across MULTIPLE workers.

Two gaps, both named in M5-1-POST-PHASE-AUDIT.md:

1. NOTHING PROBES (defect 14). `WorkerRegistrationService.probe()` records
   evidence; no loop produces it. Without an operator calling probe() by hand,
   every registered worker stays ineligible. Options: a supervisor-side prober,
   a worker heartbeat that calls probe() itself, or both. Probe evidence MUST
   stay durable — an in-memory health cache reintroduces the M4 snapshot bug.

2. SELECTION DOES NOT DISTRIBUTE (defect 15). `selectWorker` returns
   first-eligible-by-id, so N ready tasks with M healthy workers all go to one
   worker. Exactly-once dispatch PER TASK is already certified by CORE2
   (postgres-supervisor-dispatch-race, postgres-concurrent-dispatch-recovery,
   postgres-multiworker-concurrent) — do NOT rebuild that. The gap is purely
   distribution.

   HARD CONSTRAINT: any distribution policy MUST be a pure function of durable
   state. An in-memory round-robin counter would silently break
   ROUTING_SURVIVES_RESTART (decision 0031), which is currently PROVEN.
   A deterministic derivation (e.g. from the durable task identity and the
   sorted eligible set) keeps both properties. Extend `WorkerRequirement` and
   the canonical matcher — do NOT add a fourth eligibility filter.

Then, still open for M5/M6:
3. `dispatch_attempts` has no `worker_id` (defect 12) — needed for multi-worker
   attribution and for a real producer identity in reviewer independence.
   Additive column + additive migration.
4. Resource Manager: still deliberately not built. When it arrives it should
   subsume `AIResourceCatalog` (defect 10), which hardcodes worker kinds with
   capabilities, model ids and providers, and whose engine has zero consumers.
   Worker != Model != Provider != Account != Capacity Slot is established in
   decision 0031 §Context; keep those axes separate.

Already available and proven:
- `container.workerRegistration` — register / probe / deactivate / deregister,
  fail-closed on registration;
- `container.workerRegistryStore` — durable truth;
- `container.capabilityRouter` — live reads, per-candidate refusal evidence;
- fail-closed dispatch: no eligible worker -> MissionTask `blocked`, dispatcher
  not called.

Critical path after M5:
  M6 non-interactive external workers -> M7 automatic recovery ->
  CORE3 chaos certification -> Self-Development Supervisor ->
  ICOS_SELF_BUILD_E2E PASS

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
