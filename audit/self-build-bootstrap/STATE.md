# ICOS Self-Build Bootstrap — Durable State

Updated: 2026-09-29 (M14 — ICOS improves itself from one sentence; SELF_DEVELOPMENT_E2E repeatable)
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag
Branch: feat/autonomy-core3-goal-planner-dag

## CURRENT_MILESTONE
M13 — DEFECT 28 CLOSED, decision 0044. The IntegrationGate now runs only AFTER an
       independent canonical review exists. CORE3 is RE-CERTIFIED with the certification
       artifact removed: no proof pre-persists an approval any more. Execution leaves the
       work durable and `ready_for_integration` (`awaitingReview: true`); the later
       `gatePendingReview()` pass gates, applies and reaps. One gate, one review authority,
       order changed. No review still means no integration, and no premature escalation.
CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED — RE-DECLARED, M13, decision 0044 (was M9/0042).
       An ORDINARY autonomous mission now reaches the governed path BY DEFAULT, proven
       from `buildPostgresContainer` AND from `startProductionServices` — nothing in the
       proof composes the coordinator by hand. Governed workspace allocated automatically
       during attempt preparation, real external worker, independent review, gate,
       canonical commit applied ONCE, branch and worktree reaped, restart duplicates
       nothing. DEFECT 23 CLOSED.
NEXT — SELF_DEVELOPMENT_SUPERVISOR, then ICOS_SELF_BUILD_E2E (see NEXT_ACTION).
M8 — real external execution + governed integration: COMPLETE.
       decisions 0041 (+ wiring), commits 0b1e083, 4b570ec, 1bac102.
       DEFECT 22 CLOSED — `container.taskExecution` now selects the external worker
       executor BY RUNTIME. Proven against the CONTAINER, not a hand-built
       composition: REAL_RUNTIME_EXTERNAL_EXECUTOR_WIRED.
       DEFECT 19 CLOSED — the gate DECIDES, `IntegrationApplier` ACTS: fast-forward
       only, by atomic compare-and-swap, exactly-once derived from git, and the
       branch is reaped afterwards. EXACTLY_ONCE_WORKER_INTEGRATION_PROVEN and
       WORKER_WORKTREE_REAPING_PROVEN.
CORE3 CHAOS CERTIFICATION — PASSED, decision 0040, commit a45f0ca.
       A REAL external worker hangs, is KILLED by its own execution timeout, and the
       mission task still completes on ANOTHER worker, EXACTLY ONCE — asserted on
       durable rows from new connections. This is the COMPOSITION proof; every
       mechanism was already certified in isolation.
M7.1 — routed QC retries: COMPLETE, decision 0040, commit a45f0ca. Closed the
       re-dispatch gap M7 left open (see M7.1 PROOFS).
M7 — automatic recovery: COMPLETE, decision 0039, commit c5903ea.
       DEFECT 17 IS CLOSED. A worker killed mid-execution (a REAL SIGKILL, with the
       lease expiring by WALL CLOCK) has its task reclaimed, its capacity slot
       returned, and the same logical task then runs on another worker exactly once.
       The execution lease is the liveness probe a process worker never had: the
       pre-existing ADR-0027 orphan scan asks a TEMPORAL WorkflowProbe, which answers
       `unknown` for a process worker, so that unit deferred FOR EVER — the structural
       reason defect 17 survived M6.3.
M6 — non-interactive external workers: COMPLETE.
       M6.1 real runtime-keyed probe  — decision 0036, commit 9e808dc
       M6.2 autonomous probe sweep    — decision 0037, commit c1ca85c
       M6.3 external worker EXECUTION — decision 0038, commit 58fa884
       DEFECT 16 CLOSED (M6.1+M6.2). A REAL Hermes agent has been launched
       non-interactively by ICOS, given the composed task contract, and its output
       captured — all nine M6.3 proof targets met (list below).
       DEFECT 17 (worker-death recovery) IS UNCHANGED and is the last structural
       hole: the execution lease makes an abandoned run RECLAIMABLE, but nothing
       sweeps for expired leases and re-routes the task. That is M7.
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
9444447  M12 SELF_DEVELOPMENT_E2E candidate -> plan, via production composition
  6ee81be  M12 planner backend is pluggable compute, not a second planner (defect 27)
  9472de7  DEFECT 25 CLOSED; defect 27 named
  5db20d2  M11 DEFECT 25 CLOSED — self-development owns its chain, on the certified path
  996f865  M10 recorded; defect 25 named as the self-build blocker
  a92abad  M10 self-development can land its own work (defect 26 CLOSED)
  2e624c2  defect 24 — create() declares task metadata instead of inventing it
  cfe4431  D1 resolved — integration failures now zero
  1ab958b  D1 root cause fixed — the container leaked two PostgreSQL clients
  3c47cf0  CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED; defect 24 named
  a9aa3d7  M9 governed workspace allocation is the DEFAULT path (defect 23 CLOSED)
  0d3f4c8  M8 recorded — defects 22 + 19 closed, defect 23 named
  1bac102  M8 governed external worker integration, end to end
  4b570ec  M8 governed worker result integration + reaping (defect 19)
  0b1e083  M8 wire external execution into the REAL container (defect 22)
  a8e4dce  CORE3 chaos certified; deploy gap (defect 22) named
  a45f0ca  M7.1 routed QC retries + CORE3 CHAOS CERTIFICATION
  4963b09  M7 complete, defect 17 closed, chaos-certification entry state
  c5903ea  M7 abandoned external worker execution recovery (defect 17 CLOSED)
  b1557be  M6 complete, M6.3 proofs, M7 entry state
  58fa884  M6.3 real non-interactive external worker execution
  d468a67  M6.2 state + defect 16 closed + M6.3 entry state
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

### CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED — M9 (decision 0042, commit a9aa3d7)
7 PostgreSQL certification proofs + 8 allocation-policy proofs; 4 mutations verified.

  THE DEFECT: `allocateWorkspace` was only ever called explicitly, so an ORDINARY autonomous
  mission never reached the governed path — it dispatched with no registered workspace, the
  executor fell back to an ad-hoc worktree, and the branch was orphaned. Root cause, the SAME
  SHAPE AS DEFECT 22 FOR THE THIRD TIME: `production-services.ts` passed `undefined` for the
  supervisor's coordinator, making the supervisor's workspace branch dead code in production.

  ALLOCATION_IN_ATTEMPT_PREPARATION — allocated right after `prepare()` and BEFORE any
    external execution, keyed by the canonical workflowId.
  POLICY_FROM_CANONICAL_TASK_ONLY — `riskClass` + `allowedFileScope`. Provider, worker kind
    and model are NOT inputs: the policy's parameter type has no field for them, so the
    mistake cannot be reintroduced by editing a condition. The previous gate was
    `routedWorkerKind`, which let WHO executes decide whether work is governed AND silently
    skipped governance for any unrouted task.
  WRITER_ALWAYS_GOVERNED / READER_EXEMPT — read_only needs none; reversible and sensitive do.
  UNSCOPED_WRITER_IS_BLOCKED — fail closed. Inventing a permissive scope would let an
    autonomous agent write anywhere; falling back to ad-hoc is the orphan-branch defect.
    Only blocking is recoverable, and it is visible.
  ABSENT_METADATA_IS_A_WRITER — guessing "reader" would skip governance for exactly the tasks
    whose intent nobody wrote down.
  DECLARED_SCOPE_IS_THE_WORKSPACE_SCOPE — the gate rejects everything outside `owns`, so a
    generic default would turn every governed run into a rejection.
  NO_ORPHAN_BRANCH — after the run, `git branch --list ws/*` is EMPTY and the worktree is gone.
  EXACTLY_ONCE_ACROSS_RESTART — a NEW container re-running the mission integrates nothing
    twice and creates no second attempt.
  RETRY_WORKSPACE_SEMANTICS — the same workflowId REUSES its workspace; a different workflowId
    on the same task is refused as WORKFLOW_COLLISION.
  PROVEN_FROM_THE_REAL_RUNTIME — `buildPostgresContainer` + `composeAutonomyRuntime` (the exact
    function `createRecoveryScheduler` calls) AND a real `startProductionServices` boot.
    NOTHING in the proof composes the coordinator by hand, because a hand-built composition is
    precisely how defects 22 and 23 stayed invisible.

  SUBSTITUTED, and why: the gate's shell commands (install/typecheck/lint/unit/build/postgres)
  are trivial passing commands via ICOS_GATE_COMMANDS. Running four full pnpm suites inside a
  throwaway fixture would prove pnpm works, not that ICOS orchestrates correctly. Every gate
  RULE — scope, secrets, migrations, diff, conflict, review — is the real one.

  THREE LATENT DEFECTS THIS UNCOVERED, none reachable by a unit test:
   - `PostgresWorkspaceRegistry` hardcoded `testDatabase: ""` ("will be set by manager"), but
     the manager READS the workspace back — so the name was always empty and `create()` failed
     every time with DATABASE_FORBIDDEN. The PostgreSQL workspace path could NEVER allocate
     anything. Now derived from the slug.
   - any hyphenated slug broke creation (`^icos_test_[a-z0-9_]{1,32}$`), including the
     coordinator's own former default `task-<id>`. Slugs are underscore-only.
   - `markDispatched` assumed Temporal's fire-and-forget shape and rejected a SYNCHRONOUS
     dispatcher's acknowledgement; the external executor settles the attempt inside
     `dispatch()`. `prepared` remains invalid.

  NOT PROVEN by this certification, do not overclaim:
   - the mission used is single-task. Multi-task DAG behaviour is certified separately
     (M3/M5.4) and is NOT re-proven under the governed path.
   - the proof drives `supervisor.run(missionId)` directly after booting the real services;
     it does not wait for the recovery SCHEDULER's timer to pick the mission up.
   - no LIVE provider is used here; the worker is this process's own Node runtime. The live
     Hermes proof remains separate and opt-in.


### M8 PROOFS — defects 22 + 19 (commits 0b1e083 / 4b570ec / 1bac102, decision 0041)
7 unit router + 4 container-composition + 13 applier/reaping + 7 end-to-end; 15 mutations.

  REAL_RUNTIME_EXTERNAL_EXECUTOR_WIRED (defect 22)
    `RuntimeDispatchRouter` resolves the attempt, reads its worker from the REGISTRY and
    routes on `worker.runtime`. Asserted against `buildPostgresContainer` itself — the
    thing production builds — not a composition a test assembled.
    NOT worker kind, NOT provider: a worker of KIND "hermes" on an unconfigured runtime
    goes to Temporal, and the same kind on a configured runtime goes external. A provider
    in metadata changes nothing.
    WITH NO CONFIG the container returns the Temporal dispatcher EXACTLY as before, and a
    test pins that — a fix that regresses non-adopters is not a fix.
    Configuring execution without ICOS_REPO_PATH REFUSES TO BOOT rather than pointing an
    autonomous writer at whatever directory the server started in.

  EXACTLY_ONCE_WORKER_INTEGRATION_PROVEN (defect 19)
    `IntegrationApplier` extends the canonical boundary — same manager, same Git port,
    same lease and fencing token. `accepted` is reachable ONLY through the gate, so
    "worker output never self-merges" is STRUCTURAL, not a convention.
    FAST-FORWARD ONLY by `update-ref <new> <expectedOld>`, an atomic compare-and-swap: no
    machine-made merge commit, no machine-resolved conflict (divergence is NEEDS_REBASE),
    no read-then-write window. merge/rebase/reset/checkout/push/clean stay FORBIDDEN.
    EXACTLY-ONCE IS DERIVED FROM GIT, not from a flag or counter: a replay after a crash
    reaches the same answer as the run that crashed. Proven with a restarted applier.
    A lost CAS is RACE_LOST (expected, retryable) and CONVERGES to NEEDS_REBASE.
    A stale/foreign owner or a stale fencing token cannot integrate, even holding an ACCEPT.
    UNREVIEWED WORK IS NEVER INTEGRATED; REQUEST_CHANGES rejects; escalation is not consent.

  WORKER_WORKTREE_REAPING_PROVEN (defect 19)
    Reaping asked git the WRONG QUESTION and so never fired: `git branch -d` checks against
    HEAD, not against an arbitrary ref, so a branch fast-forwarded into `integration/phase-7`
    while HEAD sat elsewhere was reported "not fully merged" and kept FOREVER. Verified
    empirically. `deleteBranchMergedInto(branch, target)` asks the right question.
    A rejected result KEEPS its branch — it is the only copy. The archive is written BEFORE
    anything is removed, and reaping a worktree with uncommitted work is refused.

  LIFECYCLE (Part D) maps onto the EXISTING statuses, no new states invented:
    requested/creating -> ready/working -> validating/ready_for_integration -> integrating
    -> accepted|rejected -> cleanup (releasedAt).

  NOT PROVEN by M8, do not overclaim:
    - the end-to-end proof composes the coordinator explicitly. The CONTAINER wires the
      router, applier, reviewDecisions and the governed `workspaceFor` resolver, and that
      wiring is asserted — but no test yet drives a mission from `startProductionServices`
      through to an integrated commit. That is CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED.
    - the gate's shell commands (typecheck/lint/test/build) are a recorded runner in the
      end-to-end proof. The gate's DECISION LOGIC and all its rules are the real ones;
      running four pnpm suites in a throwaway fixture would prove pnpm works, not ICOS.
    - nothing yet ALLOCATES a governed workspace automatically for an autonomous mission
      task; `allocateWorkspace` is still called explicitly. See defect 23.


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
- M6.3 external worker EXECUTION — decision 0038, commit 58fa884.
  ALL NINE REQUIRED PROOF TARGETS MET (49 unit + 19 PostgreSQL, 6 mutations verified):
  WORKER_PROCESS_LAUNCH_PROVEN        — a real OS process runs; real duration, real exit
  TASK_CONTRACT_INJECTION_PROVEN      — the worker ECHOES BACK goalId/missionId/planId/
                                        missionTaskId/taskId/attempt/workflowId from BOTH
                                        env and the JSON contract file; assertions read the
                                        child's own view, not ours
  STDOUT_STDERR_CAPTURE_PROVEN        — both streams captured SEPARATELY (a classifier that
                                        cannot tell them apart cannot prioritise stderr)
  EXIT_CLASSIFICATION_PROVEN          — configured exit codes, patterns, timeout, signal,
                                        never-started; exit 0 + failure verdict IS a failure
  SESSION_EXHAUSTION_PROVEN           — from configured stderr patterns AND from the worker's
                                        own verdict; stays retryable
  RETRYABLE_RESUME_PROVEN             — attempt 2 inherits attempt 1's session token and
                                        ECHOES IT into its own real commit
  WRITER_WORKTREE_ISOLATION_PROVEN    — writer never gets the canonical checkout (REFUSED,
                                        not merely avoided); a real commit leaves canonical
                                        HEAD, branch and status untouched
  COMMIT_EVIDENCE_CAPTURE_PROVEN      — commit hash/commits/changedFiles read from GIT, not
                                        from the worker's claim; dirty-without-commit still
                                        reported; commitHash null when nothing committed
  PROCESS_RESTART_CONTINUATION_PROVEN — failure class, resume token and handoff survive on
                                        new connections with new service instances
  PLUS: NO_DUPLICATE_INTEGRATION (a runner without the lease executes and records NOTHING),
  FENCED_SUCCESS (a run that lost its lease mid-flight is recorded LEASE_EXPIRED even though
  it SUCCEEDED), LEASE_INDEPENDENT_OF_RECOVERY_CLAIM (both fences held at once by different
  owners), ALL_EIGHT_CLASSES_STORABLE + unknown class refused by the DATABASE,
  NO_PROVIDER_HARDWIRE (unconfigured runtime invents nothing; novel worker KIND needs no
  adapter), IDENTITY_AXES_DISTINCT (worker/runtime/model/provider/account/capacitySlot all
  six recorded separately), REVIEW_NOT_SELF_INTEGRATION (a success advances the task to
  `review_pending`, never to `succeeded`).

  LIVE PROVIDER PROOF — a REAL Hermes agent, not a stub:
    /Users/coco/.local/bin/hermes, Nemotron-class model via a custom endpoint, launched
    with `-z` (one-shot, no TTY), received the ICOS-composed contract, echoed a unique
    per-run token, left its isolated branch clean, canonical checkout untouched.
    5.3s of real network round-trip. Codex is present on the same machine and needs a
    config entry only — NO code change.
    IT IS OPT-IN, and that is deliberate, NOT a re-skip: it spends model credits on every
    run and a third-party outage would present as an ICOS regression. Every code path it
    exercises is also covered deterministically. It is the ONLY skipped thing in the
    integration suite (1 file / 2 tests).
    REPRODUCE:
      ICOS_LIVE_WORKER_PROOF=1 npx vitest run --config vitest.integration.config.ts \
        src/server/workers/execution/live-external-worker.integration.test.ts

  NOT PROVEN by M6.3, do not overclaim:
    - nothing INTEGRATES a worker's branch. A run leaves a branch and stops; merging is a
      separate decision. This is intentional (an executor that could merge could land
      unreviewed work), and it means the loop is not yet closed end to end.
    - nothing sweeps for EXPIRED execution leases. The fence makes an abandoned run
      reclaimable; no caller reclaims it yet. That is defect 17 / M7.
    - only the `node` and (by configuration) `binary` runtimes have been exercised.

### M7 PROOFS — automatic recovery (decision 0039, commit c5903ea)
4 unit + 8 PostgreSQL, 5 mutations verified. DEFECT 17 CLOSED.
  ABANDONED_EXECUTION_DETECTED   — an expired execution lease on a still-`dispatched`
                                   attempt is POSITIVE evidence nobody is running it.
                                   No WorkflowProbe involved, which is the point.
  CAPACITY_SLOT_RECOVERED        — THE defect-17 assertion:
                                   `listActiveWorkerAssignments()` is `[WORKER_A]`
                                   before the sweep and `[]` after. Settling the
                                   attempt is what frees the slot, because load is
                                   DERIVED from non-terminal attempts (0034).
  REASSIGNMENT_EXACTLY_ONCE      — attempt 2 then `prepare`s on WORKER_B and succeeds,
                                   which is only possible if the slot really came back
                                   (prepare enforces concurrency inside its own
                                   transaction). Exactly one non-terminal attempt for
                                   the task, on the new worker only.
  REAL_CHAOS                     — an ACTUAL OS process is spawned and SIGKILLed, and
                                   the lease expires by WALL CLOCK. Nothing simulates
                                   the death with an UPDATE.
  LIVE_RUNNER_NEVER_RECLAIMED    — an unexpired lease is not a candidate.
  GRACE_PERIOD_HONOURED          — expiry alone is not enough; a runner finishing a
                                   long commit is not reclaimed a millisecond late.
  LATE_REAL_RESULT_WINS          — a result landing between scan and action stops the
                                   reclaim; a genuine success is never overwritten
                                   with UNKNOWN_EFFECT.
  IDEMPOTENT_ACROSS_PROCESSES    — two concurrent sweepers reclaim ONE abandonment
                                   once, via the existing durable recovery_units claim.
  BOUNDED_RETRY                  — a permanently failing reclaim is EXHAUSTED after
                                   maxAttempts: a deterministically dying worker is not
                                   retried for ever.
  TERMINAL_MISSION_LEFT_ALONE    — never resurrect work for a cancelled mission.

  DELIBERATE DEVIATION FROM THIS FILE'S OWN M7 PLAN, recorded so it is not read as an
  oversight: the previous NEXT_ACTION said to reuse the M6.2 `scheduled_jobs` pattern.
  Reading the code changed the answer — `RuntimeRecoverySweeper` is ALREADY driven on a
  timer by `AutonomyRecoveryScheduler`, so a new scheduled job would have been a SECOND
  recovery path over the same table, the duplication M6.3 requirement 9 forbids. The
  new scan is a candidate source on the EXISTING sweeper. No migration was needed.

  A MUTATION SURVIVED, reported not buried: removing the scanner's
  `execution_lease_owner is not null` guard — and then BOTH lease-presence guards —
  changed no test, because SQL's three-valued logic already excludes a NULL lease from
  the age comparison. Those guards are LEGIBILITY, not enforcement. They are kept (a
  future `coalesce` refactor would silently admit never-leased attempts) and both the
  code comment and the test now say plainly that the test does not prove them.

  NOT PROVEN by M7 (BOTH CLOSED by M7.1 / decision 0040 — kept for the record):
    - the RE-DISPATCH was still the existing QC decision, and following it showed the
      retry was created UNROUTED. Closed below.
    - no end-to-end chaos run existed. Closed below.

### M7.1 PROOFS — the QC re-dispatch gap (decision 0040, commit a45f0ca)
6 unit + 3 PostgreSQL, 6 mutations verified.
  THE GAP, precisely: `QualityControlRepository.applyAction` INSERTs the retry attempt
  directly and left `worker_id` NULL — it copied only workerKind and capability. Harmless
  while every dispatcher resolved its own worker; FATAL once one resolves the worker from
  the LEDGER. The M6.3 external executor reads `attempt.workerId`, finds nothing, and
  fails the attempt closed with PROVIDER_UNAVAILABLE — so the retry spent one of a
  BOUNDED number of attempts and changed nothing, and the next would too. A recovered
  task could NEVER complete. Invisible before M6.3 existed.
  RETRY_IS_ROUTED            — through the canonical CapabilityRouter, the same instance
                               the supervisor uses. QC is a second CALLER of one
                               authority, never a second authority.
  RETRY_AVOIDS_A_DEAD_WORKER — no grudge list: a dead worker has already lost its health
                               evidence (0033) so the router does not offer it.
  NO_ELIGIBLE_WORKER_IS_BACK_PRESSURE — QC throws and the job is released for a later
                               sweep; it does NOT create an unroutable attempt. Spending
                               a bounded retry to record a FLEET problem as a TASK
                               failure is the failure mode avoided.
  CAPACITY_ENFORCED_ON_RETRY — `applyAction` bypasses `prepare()` and therefore bypassed
                               the capacity guard entirely. `assertWorkerCapacity` is now
                               EXTRACTED into a shared module both insert paths call
                               in-transaction — not copied, because two capacity checks
                               are two authorities.
  UNROUTED_WITHOUT_A_ROUTER  — a deployment with no registry keeps pre-M4 behaviour.

### CORE3 CHAOS CERTIFICATION — PASSED (decision 0040, commit a45f0ca)
2 PostgreSQL scenarios. The fault is REAL: a worker process hangs and is KILLED by its
own execution timeout.
  WHOLE_CHAIN_SURVIVES_A_WORKER_DEATH — route -> dispatch a REAL external worker -> hang
    -> killed -> classified STREAM_FAILED and SETTLED (which returns the slot) -> probe
    observes it unhealthy -> recovery reviews the failure, routes the retry to the OTHER
    worker, dispatches it -> the retry really writes and commits -> review ACCEPTS -> the
    task succeeds. Asserted on DURABLE ROWS from new connections: exactly 2 attempts,
    exactly 2 results, exactly ONE success, exactly ONE branch carrying the work, and the
    canonical checkout never moved.
  TOTAL_FLEET_OUTAGE_IS_BACK_PRESSURE — no attempt 2 is created and the task is NOT
    failed; it waits for capacity.
  REAL: PostgreSQL, OS processes, git worktrees and commits, the REAL DeterministicReviewer
  hard rules, the real routing/capacity/QC/recovery services, restarts as new connections.
  STUBBED, and why: the LLM half of the reviewer (a network model — the rule that matters,
  UNKNOWN_EFFECT -> RETRY, is the REAL deterministic one) and the probe sweep's observation
  that the hung worker is unhealthy (certified in M6.2; running it here adds noise, not
  proof).
  RECOVERY RUNS AS SUCCESSIVE SWEEP TICKS, because the sweeper is PERIODIC in production.
  One tick cannot both create the retry and review its result — `recoverUnregistered` runs
  at the START of a pass, so the retry's result does not exist yet when the pass that
  creates it begins. A single all-in-one call would certify a system that does not exist.

  NOT PROVEN by the certification, do not overclaim:
    - the mission-level loop (planning -> DAG -> multiple tasks) is not exercised here;
      this certifies ONE task surviving a worker death. Multi-task DAG behaviour is
      certified separately in M3/M5.4.
    - nothing integrates the worker branches. The certification itself SHOWS this: TWO
      branches survive the run, one per attempt. That is defect 19.

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

Current (at M12 / 9444447, all MEASURED, DOCKER CONFIRMED RUNNING):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS · `git diff --check`: PASS
- `pnpm run test` (unit): PASS — 1816 tests
- `pnpm run test:integration`: 451 passed / 0 FAILED / 3 SKIPPED
- skips rose 2 -> 3: the new SELF_DEVELOPMENT_E2E is OPT-IN (ICOS_SELF_DEV_E2E=1) because it
  spends real model credits. It PASSES when run. Repro command is in the test header.
- lint: 0 errors, 289 warnings — EQUAL to baseline · ledger 45 rows (migration 0047)

Previous (at M11 / 5db20d2):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS · `git diff --check`: PASS
- `pnpm run test` (unit): PASS — 1808 tests
- `pnpm run test:integration`: 451 passed / 0 FAILED / 2 SKIPPED
- lint: 0 errors, 289 warnings — EQUAL to baseline · ledger 44 rows

Previous (at M10 / a92abad):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS · `git diff --check`: PASS
- `pnpm run test` (unit): PASS — 1792 tests
- `pnpm run test:integration`: 447 passed / 0 FAILED / 2 SKIPPED
- INTEGRATION FAILURES REMAIN ZERO. The 2 skips are ONLY the opt-in live Hermes proof.
- lint: 0 errors, 289 warnings — EQUAL to baseline · ledger 44 rows

Previous (at D1 fix / 1ab958b):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS · `git diff --check`: PASS
- `pnpm run test` (unit): PASS — 144 files, 1788 tests
- `pnpm run test:integration`: 443 passed / 0 FAILED / 2 SKIPPED
- INTEGRATION FAILURES ARE NOW ZERO. The 2 skips are ONLY the opt-in live Hermes proof.
- the suite also dropped from ~290s to ~107s: three 60s timeouts and leaked connections gone
- lint: 0 errors, 289 warnings — EQUAL to baseline · ledger 44 rows

Previous (at M9 / a9aa3d7, before the D1 fix):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS · `git diff --check`: PASS
- `pnpm run test` (unit): PASS — 144 files, 1788 tests
- `pnpm run test:integration`: 438 passed / 3 FAILED / 2 SKIPPED
- the 3 failures are D1 auth-bootstrap-cli, PRE-EXISTING; the count has NEVER moved
- the 2 skips are the OPT-IN live Hermes proof only — skips did NOT increase
- lint: 0 errors, 289 warnings — EQUAL to baseline · ledger 44 rows (M9 needed NO migration)

Previous (at M8 / 1bac102):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS · `git diff --check`: PASS
- `pnpm run test` (unit): PASS — 143 files, 1780 tests
- `pnpm run test:integration`: 431 passed / 3 FAILED / 2 SKIPPED
- the 3 failures are D1 auth-bootstrap-cli, PRE-EXISTING; the count has NEVER moved
- the 2 skips are the OPT-IN live Hermes proof only
- lint: 0 errors, 289 warnings — EQUAL to baseline · ledger 44 rows (M8 needed NO migration)

DOCKER OUTAGE — READ THIS BEFORE COMPARING ANY BASELINE.
Partway through M8 the Docker daemon stopped on this machine. 11 integration FILES are
gated on `describe.skipIf(!dockerAvailable)` (pg-support.ts), so the suite silently
reported 357 passed / 79 SKIPPED / 0 failed — and the 3 D1 failures LOOKED FIXED because
they had been skipped, not fixed. Docker was restarted and the suite re-measured to the
numbers above. If a future run shows ~79 skips and zero failures, Docker is down: the
baseline is NOT comparable and D1 is NOT fixed.

Previous (at CORE3 chaos certification / a45f0ca):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS
- `pnpm run test` (unit): PASS — 141 files, 1760 tests
- `pnpm run test:integration`: 420 passed / 3 FAILED / 2 SKIPPED
- the 3 failures are D1 auth-bootstrap-cli, PRE-EXISTING; the count has never moved
  across M4, M5, M6.1, M6.2, M6.3, M7, M7.1. NOT skipped, must never be re-skipped.
- the 2 skips are the OPT-IN live Hermes proof only
- lint: 0 errors, 289 warnings — EQUAL to baseline · `git diff --check`: PASS
- ledger 44 rows — M7 and M7.1 both needed NO migration

Previous (at M7 / c5903ea):
- `pnpm run typecheck`: PASS · `pnpm run build`: PASS
- `pnpm run test` (unit): PASS — 140 files, 1754 tests
- `pnpm run test:integration`: 415 passed / 3 FAILED / 2 SKIPPED
- the 3 failures are D1 auth-bootstrap-cli, PRE-EXISTING; the count has never moved
  across M4, M5, M6.1, M6.2, M6.3, M7. NOT skipped, must never be re-skipped.
- the 2 skips are the OPT-IN live Hermes proof only (see M6.3 proofs for the command)
- lint: 0 errors, 289 warnings — EQUAL to baseline
- `git diff --check`: PASS · ledger 44 rows (M7 needed NO migration)

Previous (at M6.3 / 58fa884):
- `pnpm run typecheck`: PASS
- `pnpm run build`: PASS (next build, full route manifest)
- `pnpm run test` (unit): PASS — 140 files, 1750 tests (M6.2: 1701, M6.1: 1683, M5: 1667)
- `pnpm run test:integration`: 407 passed / 3 FAILED / 2 SKIPPED (M6.2: 388/3/0)
- the 2 skips are the OPT-IN live Hermes proof (1 file), gated on
  ICOS_LIVE_WORKER_PROOF=1. It PASSES when run — see the M6.3 proofs above for the
  repro command. It is NOT a re-skip of anything previously running, and it is the
  only skipped thing in the suite.
- migration 0046 applied 3x via psql exit 0, then through `migrate()`
- `pnpm db:verify-ledger <url>`: LEDGER_OK, 44 rows match the journal
- lint: 0 errors, 289 warnings — EQUAL to the M3/M4/M5/M6.2 baseline (M6.3 briefly
  introduced one unused-import warning; it was removed before commit)

Previous (at M6.2 / c1ca85c):
- unit 1701 / integration 388 pass / 3 fail / 0 skipped; ledger 43 rows
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

### MUST_BEFORE_FINAL_CERTIFICATION
NONE. D1 is FIXED (decision 0043, commit 1ab958b).

D1 — RESOLVED. It was NEVER an auth defect: `buildPostgresContainer` opens THREE PostgreSQL
     clients (the shared drizzle handle, `PostgresWorkspaceRegistry`, `PostgresGit`) and
     `close` was `handle.close`, so two `postgres.js` pools outlived it and kept the Node
     event loop alive. The bootstrap CLI did its work, printed `owner_already_present`, and
     then never exited — so `execFile` never resolved and each test waited out its 60s
     timeout. Invisible for a long-lived server; fatal for a CLI. Introduced with the Phase
     8D workspace manager.
     FIXED by closing every client the container opened. Nothing skipped, nothing
     quarantined, no timeout weakened — the tests now pass in 10.7s, and a MUTATION
     restoring the old close reproduces all three 60s timeouts exactly.
     LESSON: a failure that is STABLE is not thereby understood. "Pre-existing, count
     unchanged, not my milestone" was true every time it was written, and it let a one-line
     lifecycle bug survive six milestones and block certification. The useful question was
     never "whose change caused this?" but "what is the process actually doing when it times
     out?" — one direct run answered it.

ORIGINAL TEXT (kept for the record):
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

18. (M6.3) THE OLD EXECUTION PATH STILL HARDWIRES PROVIDERS. Two places, both
    PRE-EXISTING and NOT introduced by M6.3:
    `CompositeTaskExecutionDispatcher` branches on the literal worker kinds
    "hermes" / "openhands" / "digitalos", and `task_execution_results.worker_kind`
    has a CHECK allow-list containing those same names. M6.3 routes AROUND this —
    external workers record `workerKind: 'agent'` and carry provider identity in the
    six identity axes — so the new path adds no hardwiring, but the old one is
    untouched. Removing it needs a migration widening/neutralising that CHECK plus
    retiring the kind-based branch, which is its own decision. Related to defect 10
    (AIResourceCatalog), same root cause: provider names used as routing keys.

19. RESOLVED in M8 (decision 0041, commits 4b570ec + 1bac102) — the gate DECIDES and
    `IntegrationApplier` ACTS: fast-forward only by atomic compare-and-swap, exactly-once
    derived from git, unreviewed work refused, and the branch reaped afterwards (reaping
    now asks whether the branch is contained in the INTEGRATION TARGET, not in HEAD, which
    is why it never fired before). See the M8 PROOFS block.
    ORIGINAL TEXT: NOTHING INTEGRATES A WORKER BRANCH. A successful external run leaves a
    commit on `icos/worker/<missionTask>-a<attempt>-<uniq>` and the task advances to
    `review_pending`. That is deliberate — an executor able to merge could land
    unreviewed work — but it means the self-build loop is NOT closed end to end:
    no reviewer consumes the branch and no integrator merges it. Needs a decision on
    who merges, under what review evidence, and what happens to abandoned branches
    (they currently accumulate; only the worktree is cleaned up, never the branch).

17. RESOLVED in M7 (decision 0039, commit c5903ea) — DEFECT CLOSED.
    `listAbandonedExecutions` treats an EXPIRED EXECUTION LEASE on a still-`dispatched`
    attempt as positive evidence that its runner is gone (a live runner renews it), and
    `reclaimAbandonedExecution` settles the attempt — which is what RETURNS the capacity
    slot, since load is derived from non-terminal attempts. Proven with a real SIGKILL
    and wall-clock lease expiry; the task then runs on another worker exactly once.
    The pre-existing ADR-0027 orphan scan could not do this: it asks a TEMPORAL
    WorkflowProbe, which answers `unknown` for a process worker, so the unit deferred
    for ever. That was the structural reason this defect survived M6.3.
    SUCCESSOR: the RE-DISPATCH is still the existing QC/supervisor decision; M7 added no
    second re-routing authority. And see defect 19 — nothing integrates the branches.

21. (M7.1) `ReviewerServiceImpl` built `evidenceRefs` from evidence TIMESTAMPS, which
    can NEVER satisfy `idSchema` (lowercase/digits/-/_ only) because an ISO timestamp
    carries `T`, `Z`, `:` and `.`. Every reviewed result carrying evidence threw
    QUALITY_CONTROL_INVALID_REVIEW. FIXED in 0040 (mapped by `type`, matching
    DeterministicReviewer, non-conforming labels dropped). RECORDED because of HOW it was
    found: it had been latent since the reviewer was written and never fired, because
    nothing attached evidence to a reviewed SUCCESS until the M6.3 executor did. A unit
    test could not have found it; the composition did.

26. RESOLVED in M10 (commit a92abad) — `GovernedSelfDevelopmentCoordinator` called
    `integrationGate.integrate` and then STOPPED, saying so in its own outcome message:
    "merge-ready only; no merge performed". The SAME defect shape as 19, one layer up: a
    gate that decides and nothing that acts, so ICOS could evaluate its own improvement,
    pass every check, and never integrate it.
    FIXED by ACCEPT -> APPLY -> REAP through the CANONICAL authorities (the same
    `IntegrationApplier` and `WorkspaceManager.cleanup`), fenced by the SAME workspace lease
    that authorised the execution. Optional, so absent keeps the previous behaviour. A moved
    target (NEEDS_REBASE / lost race) goes to a human and KEEPS its branch — the work was
    fine, the target moved, and the branch is what a rebase needs.

28. (M12) THE GATE RUNS BEFORE ANY INDEPENDENT REVIEW CAN EXIST — the remaining self-build
    blocker, and an ARCHITECTURE decision rather than a bug.
    VERIFIED: `WorkspaceExecutionCoordinator.executeInWorkspace` runs the IntegrationGate
    immediately after execution, and the gate's review step consults
    `reviewDecisions.getByWorkflowId`. For a workflow that has only just executed, QC has not
    reviewed yet — QC reviews on a LATER sweep, after the result is recorded. So the gate
    answers NEEDS_HUMAN_APPROVAL unless a review was PRE-PERSISTED, which is exactly what the
    CORE3 certification does (`approve(c)` before `supervisor.run`).
    For ordinary autonomous work this is SAFE — nothing auto-integrates without a review. For
    autonomous SELF-DEVELOPMENT it is blocking: nothing produces the review before the gate.
    `GovernedSelfDevelopmentCoordinator` already has the right order (execute -> independent
    review -> gate -> apply), but its execution handoff enters `supervisor.run`, which gates
    inside `executeInWorkspace` — so the gate would run twice, the first time in the wrong
    order. TWO COMPONENTS EACH OWN "gate after execution" WITH DIFFERENT REVIEW
    PRECONDITIONS. That is the conflict.
    OPTIONS (either changes CERTIFIED M9 behaviour, so the CORE3 certification must be re-run):
      A. make the coordinator's gate CONDITIONAL — when no review exists, leave the workspace
         `ready_for_integration` for a later gated pass instead of gating unreviewed. Nothing
         that previously ACCEPTed would stop (a review existed then); work with no review
         would be left pending rather than marked NEEDS_HUMAN_APPROVAL with the mission task
         failed. Smallest change, and arguably the correct ordering everywhere.
      B. give self-development an execution entry that stops BEFORE the gate, leaving the
         gate solely to the self-development coordinator. Keeps M9 untouched but leaves two
         gating paths, which is the duplication the milestone has spent itself removing.
    RECOMMENDATION: A. The gate belongs after independent review, always; the immediate gate
    is the anomaly.

27. RESOLVED in M12 (commit 6ee81be) — `CanonicalAutonomousMissionPlanner` owns the schema,
    prompts, DAG gate and error taxonomy; a backend is a `PlannerCompletionProvider` (two
    strings in, one out) with no way to influence what a plan MEANS. OmniRoute keeps its class,
    constructor and error codes and its 14 tests pass UNCHANGED. `CommandPlannerProvider` adds
    a local-process backend, named only in configuration, handling no secret and surfacing only
    an exit code. Configuring BOTH backends is REFUSED rather than silently ranked.
    PROVEN against the real binary: a schema-valid, DAG-valid plan, and a cyclic plan from this
    backend rejected with the identical canonical error code.
    ORIGINAL TEXT: NO PLANNER PROVIDER IS CONFIGURABLE IN THIS ENVIRONMENT — THE SELF-DEVELOPMENT
    E2E BLOCKER. `OmniRouteAutonomousMissionPlanner` is the ONLY implementation of
    `AutonomousMissionPlanner`, and `createOmniRouteAutonomousMissionPlanner` throws
    CONFIGURATION_INCOMPLETE without OMNIROUTE_BASE_URL + OMNIROUTE_API_KEY +
    ICOS_PLANNER_MODEL. None are set here and there is no `.env` (only `.env.example`), so
    `container.autonomousPlanner` is undefined and the chain correctly fails closed with
    AUTONOMY_PLANNER_UNAVAILABLE.
    CONSEQUENCE: every link of self-development is wired and proven, but ICOS cannot PLAN its
    own work, so SELF_DEVELOPMENT_E2E cannot be run truthfully. Stubbing the planner would
    mean ICOS was not planning — the certification would assert something false.
    TWO WAYS FORWARD, and the choice is the owner's (CLAUDE.md names required production
    credentials as an escalation trigger):
      A. supply OmniRoute credentials + ICOS_PLANNER_MODEL — no code change;
      B. add a Hermes-backed adapter for the EXISTING `AutonomousMissionPlanner` port. Hermes
         is installed and authenticated here (Nemotron via a custom endpoint) and has already
         been proven as an external worker. This is a second PROVIDER ADAPTER, not a second
         planning authority — the same pattern as runtime-keyed probe and exec adapters — but
         it is a material choice about which model plans ICOS's own self-modification, and it
         spends credits per planning call.

25. RESOLVED in M11 (commit 5db20d2) — all three links proven:
    LINK 1 `SelfDevelopmentChain` owns candidate -> goal -> mission -> plan and implements no
    link of it (ids DERIVED from the candidate contentHash, so idempotence, restart-safety and
    duplicate-invocation safety all follow; selection evidence written before any mission
    exists; in-flight work resumed before new work is started).
    LINK 2 `CertifiedRuntimeExecutionHandoff` is an ADAPTER that calls `supervisor.run` and
    READS what the certified path produced; it FAILS CLOSED without a governed workspace, a
    lease or a routed worker, which is what makes a regression to the bypass detectable.
    LINK 3 composed in `composeAutonomyRuntime` with a composition-asserting test, plus a
    DURABLE backlog (built on the existing DurableMemory store, no migration) and a canonical
    independent-review adapter that fails closed when no independent reviewer exists.
    8 mutations verified. SELF_DEVELOPMENT_RUNTIME_WIRED=TRUE.
    ORIGINAL TEXT: THE SELF-DEVELOPMENT COORDINATOR IS NOT COMPOSED, AND DOES NOT USE THE CERTIFIED
    EXECUTION PATH. Verified: `GovernedSelfDevelopmentCoordinator` appears NOWHERE outside
    its own file and tests — the FOURTH occurrence of the defect-22/23 shape (a capability
    fully built and proven while the container never wires it).
    Worse than composition: it executes through an injected `CanonicalExecutionHandoff`
    function, NOT through `container.taskExecution` / the supervisor. So even once composed
    it would bypass the CORE3-certified path (runtime-based dispatch, governed allocation,
    capability routing, execution lease, recovery).
    And nothing creates candidate -> HighLevelGoal -> Mission -> AutonomousPlan: the
    coordinator takes missionId/missionTaskId/taskId as INPUT. That chain has no owner.
    THIS IS THE BLOCKER FOR ICOS_SELF_BUILD_E2E. See NEXT_ACTION.

24. RESOLVED in M10 (commit 2e624c2) — `create()` now passes DECLARED task metadata through
    the one creation authority (`prepareTaskCreation`) and OMITS what the caller did not
    declare, so `taskSchema` defaults apply. Nothing is invented in the repository, so no
    second planning contract exists. Option B (prohibit inline writer tasks) was rejected:
    the autonomous path already never uses them — `igniteAutonomousMission` creates missions
    with `tasks: []` — so a prohibition would only have broken the manual path.
    ORIGINAL TEXT: `PostgresMissionRepository.create()` HARDCODES task planning metadata —
    `riskClass: 'reversible'`, `allowedFileScope: []`, priority 3, attemptBudget 3 — for
    missions created with inline tasks. Under governance those writer tasks now BLOCK,
    because an undeclared scope cannot be governed. This is the M2 gap finally having
    teeth, and it is CORRECT fail-closed behaviour, but it means the inline-creation path
    cannot produce a runnable writer task.
    NOT a blocker for CORE3 autonomous orchestration: the AUTONOMOUS path goes through the
    planner, whose output schema and prompt both carry `allowedFileScope`, and `applyPlan`
    persists it (covered by task-planning-metadata.integration.test.ts). Fix by having
    `create()` accept and persist real per-task metadata instead of constants.

23. RESOLVED in M9 (decision 0042, commit a9aa3d7) — governed workspace allocation now
    happens during normal attempt preparation, keyed by workflowId, decided from
    `riskClass` + `allowedFileScope` only. Proven from the real container AND from
    `startProductionServices`. See the CORE3 certification block.
    ORIGINAL TEXT: NOTHING AUTOMATICALLY ALLOCATES A GOVERNED WORKSPACE for an autonomous mission
    task. `WorkspaceExecutionCoordinator.allocateWorkspace` is still called explicitly, so
    the governed path (workspace -> real worker -> gate -> apply -> reap) is composed and
    proven end to end but is not yet REACHED by an ordinary autonomous mission: such a task
    dispatches with no registered workspace, the executor falls back to an ad-hoc worktree,
    and its branch is orphaned exactly as before. This is the LAST gap between "governed
    integration exists" and "every worker result is governed", and it is the substance of
    CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED.

22. RESOLVED in M8 (commit 0b1e083) — `container.taskExecution` now selects the external
    worker executor BY RUNTIME via `RuntimeDispatchRouter`, asserted against the container
    itself. With no ICOS_WORKER_EXEC_COMMANDS the container returns the Temporal dispatcher
    exactly as before, so non-adopters are bit-for-bit unchanged.
    ORIGINAL TEXT, kept because the LESSON matters more than the defect:
    `container.taskExecution` is `TemporalTaskExecutionDispatcher` on the postgres path
    (container.ts:612) and `InMemoryTaskExecutionDispatcher` on the memory path
    (container.ts:383). `ExternalWorkerTaskExecutionDispatcher` appears NOWHERE outside
    its own file and tests.
    CONSEQUENCE, stated plainly: M6.3, M7 and the CORE3 chaos certification are PROVEN
    but NOT DEPLOYED. Every proof composes the executor explicitly; a production process
    started today would still dispatch through Temporal and would not launch an external
    worker at all. This is the single biggest gap between "certified" and "running".
    Wiring it needs a decision: which runtimes/worker kinds route to the external
    executor versus Temporal, and how that interacts with the provider-name branch in
    `CompositeTaskExecutionDispatcher` (defect 18). Probably belongs with defect 19,
    since a deployed executor immediately starts producing branches nobody integrates.

20. (M7) `recovery_units.kind` has NO CHECK constraint while `scheduled_jobs.kind` has
    an ALLOW-list. Inconsistent fail-closed posture at the database boundary: a typo'd
    recovery unit kind is storable and would simply never be swept. Not changed in M7 —
    tightening it is a migration and its own decision — but the inconsistency is real.

17-ORIGINAL (kept for orientation). A worker that dies MID-EXECUTION is DETECTED
    — its probe evidence expires and it becomes ineligible — but the task it was
    holding is never reassigned: the dispatch attempt stays `dispatched` and its
    capacity stays consumed forever, so that slot is permanently lost.
    Detection without reassignment. This is M7 (automatic recovery) and it is
    the single largest remaining hole in CORE3.
    M6.3 UPDATE: half the mechanism now exists. `dispatch_attempts` carries
    `execution_lease_owner` / `execution_lease_until` (migration 0046), an expired
    lease CAN be taken over, and the old owner is provably fenced out of reporting.
    What is still missing is the CALLER: nothing sweeps for expired execution leases,
    so an abandoned attempt stays `dispatched` and its capacity stays consumed. M7 is
    now "write the sweeper", not "design the lease" — and the M6.2 pattern applies
    directly: an allow-listed `scheduled_jobs` kind, a grid-aligned idempotency key,
    and unconditional ignition at startup (decision 0037).

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

## NEXT_ACTION — run the REAL SELF_DEVELOPMENT_E2E, then ICOS_SELF_BUILD_E2E

Defect 28 is closed and CORE3 is re-certified without the pre-seeded-approval artifact, so the
full self-development chain can now be run for the first time:
  candidate -> goal -> mission -> real planning -> DAG -> governed execution -> independent
  review -> IntegrationGate -> REAL gates -> integration -> evaluation -> durable learning.
Constraints for that run: no pre-seeded review, no manual stage advancement, no fake gate
commands, and no calling coordinator internals to advance stages.

## SUPERSEDED NEXT_ACTION — DEFECT 25 (closed in M11; kept for orientation)

D1 is fixed and integration failures are ZERO. CORE3 autonomous orchestration is certified.
Self-development can now INTEGRATE (M10). One gap remains before ICOS_SELF_BUILD_E2E, and it
is precise.

### DEFECT 25 — three missing links, in dependency order

1. NOTHING OWNS candidate -> HighLevelGoal -> Mission -> AutonomousPlan.
   `GovernedSelfDevelopmentCoordinator.process()` takes missionId/missionTaskId/taskId as
   INPUT. Give that chain an owner. `igniteAutonomousMission` is the canonical mission
   creation usecase and the planner is the canonical planning authority — compose them, do
   not write a third. The plan MUST declare `allowedFileScope` per writer task, or the task
   blocks (decision 0042); the planner's schema and prompt already carry it.

2. THE COORDINATOR MUST EXECUTE THROUGH THE CERTIFIED PATH.
   Today it calls an injected `CanonicalExecutionHandoff`. That bypasses
   `container.taskExecution`, governed allocation, capability routing, the execution lease
   and recovery — i.e. everything CORE3 certifies. Implement the handoff IN TERMS OF the
   production supervisor (`composeAutonomyRuntime(container).supervisor.run`), so there is
   one execution authority rather than two.

3. COMPOSE IT IN THE CONTAINER.
   This is the FOURTH time a capability was fully built and proven while the container never
   wired it (defects 22, 23, 25, and the coordinator's own missing applier). Do not treat it
   as an oversight to be avoided by care: assert the composition in a test, as
   `container-external-executor-wiring.integration.test.ts` does.

### THEN — ICOS_SELF_BUILD_E2E
VERIFIED FEASIBLE: a fresh `git worktree` has no node_modules, and
`pnpm install --frozen-lockfile --offline` completes in ~4s against the warm pnpm store. A
REAL gate run is therefore roughly: install 4s + typecheck ~30s + lint ~60s + unit ~54s +
integration ~110s + build ~60s = about 5-6 minutes. There is NO reason to use fake gate
commands for the self-build certification.
  - use the REAL ICOS_GATE_COMMANDS. The trivial commands are acceptable for orchestration
    proofs (they prove ICOS orchestrates, not that pnpm works) and are NOT acceptable for
    proving ICOS can build itself.
  - the test must NOT call coordinator internals to advance stages; drive the default
    production runtime path.
  - the improvement must be real, bounded and low-risk, and it must pass the real gates.

### ALSO OPEN
- defect 18 / 10 — provider names as routing keys in `CompositeTaskExecutionDispatcher` and
  `AIResourceCatalog`. Retiring the composite is the moment to close them.
- defect 20 — `recovery_units.kind` has no CHECK while `scheduled_jobs.kind` does.

### CERTIFICATION LEDGER — what is and is NOT true today
  DEFECT_28                                — CLOSED (decisions 0044 + 0045). The M13 claim was
                                             premature: gatePendingReview() had no production
                                             caller. Closed by the production recovery-sweep
                                             trigger with durable adoption (599cf30, merged).
  DEFECT_36                                — CLOSED (bcda6cc, decision 0049), proven on the
                                             MERGED tree (merge 9cfcd79 + 0051).
  REPAIR_WORKSPACE_DEFECT                  — CLOSED (b66def3, decision 0050) — closed only once
                                             DEFECT 40/41 (0051) were fixed: in the merged
                                             runtime a natural REQUEST_CHANGES correction was
                                             dispatched UNGOVERNED by QC, then stranded by a
                                             stale claim. CORRECTION_DAG_E2E now proves it.
  DEFECT_40 / DEFECT_41                    — CLOSED (decision 0051). 2/2 mutations killed.
  SELF_DEVELOPMENT_GATE_PATH_DIVERGENCE    — CLOSED (decision 0052). Self-development drives the
                                             production sweeps; it never reviews, gates, applies
                                             or completes a task. Also closed there:
                                             PREPARED_RECOVERY_BYPASSES_GOVERNANCE (recovery
                                             replayed a correction UNGOVERNED) and a fail-open
                                             0049 settlement (no workspace => UNGOVERNED =>
                                             `succeeded` with nothing integrated). 3/3 mutations
                                             killed. Gates: unit 1821 (42 unit tests deleted with
                                             the removed parallel path), integration 482 / 4
                                             skipped, lint 0 errors / 278 warnings, build PASS.
  INLINE_GATE_NEEDS_REBASE_DEFECT          — CLOSED (decision 0053): ACCEPT without an applied
                                             integration is `awaitingIntegration`, never success.
  CANCELLED_WORK_INTEGRATION_DEFECT        — CLOSED (0053): withdrawn work is abandoned and
                                             released before any gate.
  STUCK_EXECUTION_CAPACITY_DEFECT          — CLOSED (0053): a successful attempt is completed
                                             when its result is durable.
                                             3/3 mutations killed. Integration 483 / 4 skipped.
  SUPERSEDED_ATTEMPT_WORKSPACE_HELD        — CLOSED (0053 amendment). Found by self-build run 1:
                                             a RETRY after a worker timeout stranded attempt 2
                                             behind attempt 1's never-released workspace.
                                             Integration 484 / 4 skipped.
  SUPERSEDED_DIRTY_WORKSPACE_HELD          — CLOSED. Found by self-build run 2: the worker was
                                             killed mid-edit, cleanup refused UNCOMMITTED_CHANGES,
                                             the retry stranded. Retirement now commits the
                                             edits to the superseded attempt's own branch
                                             (preserved, never integrated) before cleanup.
  LEASE_RENEWAL_LOCK_IS_NOT_LOSS           — CLOSED. Found by self-build run 3: one transient
                                             REGISTRY_LOCKED on a lease renewal (the registry is
                                             a try-lock) was read as a lost lease; the correction
                                             attempt ended OWNERSHIP_LOST and the task failed.
  WORKER_TIMEOUT_VS_EXECUTION_LEASE        — CLOSED. A worker budget >= the (unrenewed) execution
                                             lease is fenced every time it is used; now refused
                                             at container boot.
  PENDING_PASS_ABORTS_ON_ONE_WORKSPACE     — CLOSED. OWNERSHIP_LOST on one workspace (e.g. a
                                             superseded attempt retired mid-pass) aborted the
                                             whole pending-review pass; it now skips that one.
  CORE3_AUTONOMOUS_ORCHESTRATION_CERTIFIED — TRUE, RE-PROVEN on the merged tree (0045 sweep +
                                             0049 settlement + 0050 correction + 0051):
                                             core3-autonomous-orchestration 10/10,
                                             core3-dag-settlement 13/13 (incl. TWO_TASK_DAG_E2E
                                             and CORRECTION_DAG_E2E), core3-natural-review-gate
                                             8/8, core3-chaos-certification 2/2.
                                             Merged-tree gates: typecheck PASS, build PASS,
                                             git diff --check PASS, lint 0 errors / 289
                                             warnings (baseline), unit 1863/1863, integration
                                             477 passed / 4 skipped (opt-in E2Es), dedicated DB
                                             icos_merge36_test. Named restart / recovery /
                                             multi-worker / exactly-once files: 18 files,
                                             119/119.
  MULTI_WORKER_E2E_PASS                    — TRUE, re-proven on the merged tree (M5.4, 0035).
  AUTO_SESSION_RECOVERY_PASS               — TRUE, re-proven on the merged tree (M7, 0039/0040).
  SELF_DEVELOPMENT_RUNTIME_WIRED           — TRUE (M11), and JOINED to its coordinator (0046).
  SELF_DEVELOPMENT_PLANNING_E2E_PASS       — TRUE (M12, commit 9444447).
  SELF_DEVELOPMENT_E2E_PASS                — TRUE (M14). Candidate -> goal -> mission -> real
                                             plan -> governed workspace -> external worker
                                             writes and commits -> independent review -> gate
                                             -> REAL repository gates -> integration exactly
                                             once by ancestry -> durable learning.
                                             TWO consecutive passes from a reset target, on a
                                             DEDICATED database, each leaving a durable
                                             evidence record under
                                             audit/self-build-bootstrap/evidence/.
  ICOS_SELF_BUILD_E2E                      — PARTIAL, and therefore recorded as FALSE.
                                             From the single sentence "Improve ICOS
                                             autonomously", with no candidate/goal/mission/
                                             task/plan/worker/review/approval/integration
                                             supplied, ICOS has PROPOSED and INTEGRATED its
                                             own improvements — including a real source
                                             change to src/core/context/contracts.ts, gated
                                             by the repository's own typecheck, lint, unit,
                                             integration and build.
                                             It is NOT repeatable: it passes when the plan
                                             has ONE writer task and blocks when the plan has
                                             an edge, because a read-only inspection task is
                                             executed and never settled. That is DEFECT 36,
                                             closed and merged here (0049); repeatability NOT
                                             yet re-run — deliberately, until the self-dev
                                             path converges on the canonical authority below.
ICOS is NOT yet self-building, and must not be described as such.

### OPEN, NOT FIXED HERE
  GOVERNANCE PROPOSALS — "Improve ICOS autonomously" sometimes proposes changing a governance
              file, and the gate then answers NEEDS_HUMAN_APPROVAL. That is CORRECT. The E2E
              currently scores it as a failure; whether it should is a certification-standard
              decision for the owner, not a test to quietly relax.
  defect 18 / 10 — provider names as routing keys in `CompositeTaskExecutionDispatcher` and
              `AIResourceCatalog`. Retiring the composite is the moment to close them.
  defect 20 — `recovery_units.kind` has no CHECK while `scheduled_jobs.kind` does.

Critical path:
  canonical review/gate/settlement authority (self-dev convergence, inline-gate NEEDS_REBASE,
  cancelled-work integration, stuck capacity) -> ICOS_SELF_BUILD_E2E repeatable
  -> self-build certification

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
- AN END-TO-END RUN FINDS DEFECTS UNIT TESTS STRUCTURALLY CANNOT. M6.3's classifier
  short-circuited on any worker-reported failure, so a classless "I failed" plus
  "context window exceeded" on stderr was filed as an anonymous FAILED_RETRYABLE. Every
  unit test passed, because only a REAL worker emitted both signals in the same run.
  When a component's inputs normally arrive together, test them together.
- WHEN A TEST FAILS, ASK WHICH OF THE TWO IS WRONG BEFORE EDITING EITHER. In M6.3 the
  same run produced one wrong assertion (a success advances a task to `review_pending`,
  not `succeeded` — ICOS does not let work self-integrate) and one real defect (the
  precedence bug above). Reflexively "fixing" the code would have broken the review
  invariant; reflexively fixing the test would have shipped the defect.
- EXTRACT A SHARED RUNNER INSTEAD OF COPYING ONE. M6.3 needed M6.1's non-interactive
  process discipline plus stdout. Copying would have produced two runners, and the one
  that drifts is the one that forgets to close stdin — a hang, which is worse than a
  failure because it holds a capacity slot and never yields a verdict. The probe now
  delegates; its 31 tests passed unchanged, which is what made the extraction safe.
- DO NOT WRITE AN OBSERVATION INTO THE THING BEING OBSERVED. The worker task contract
  was nearly written into the worker's own worktree, where it would have appeared in
  `git status` and been reported as a file the worker changed.
- A DRIZZLE `sql` FRAGMENT WITH A `Date` BOUND PARAM FAILS AT RUNTIME, not at compile
  time (`The "string" argument must be of type string ... Received an instance of
  Date`). Use the typed operators (`gte`, `lt`) for timestamp comparisons.
- ADDING A METHOD TO A REPOSITORY CONTRACT IS THE CHEAPEST WAY TO FIND EVERY
  IMPLEMENTATION. `tsc` named all of them — both repositories and every test stub — so
  parity was enforced by the compiler rather than by remembering.
- APPLYING A MIGRATION WITH psql DOES NOT RECORD IT IN THE DRIZZLE LEDGER. psql proves
  idempotence; `pnpm run test:db:setup` (which calls `migrate()`) is what writes the
  `__drizzle_migrations` row. Do both, then `db:verify-ledger <url>`.
- TWO RECURRENCE PRIMITIVES NOW EXIST AND THEY ARE NOT INTERCHANGEABLE. `scheduled_jobs`
  (0037) is for a new periodic concern; the existing `RuntimeRecoverySweeper` +
  `recovery_units` is for scanning abandoned durable state, and it is ALREADY on a timer.
  In M7 this file's own plan said to use the scheduler; reading the code showed that
  would have created a SECOND recovery path over the same table. A plan written before
  the code was read is a hypothesis, not an instruction — including a plan I wrote.
- SQL THREE-VALUED LOGIC CAN MAKE A GUARD LOOK PROVEN WHEN IT IS NOT. An `is not null`
  guard next to a comparison on the same column is redundant: NULL already fails the
  comparison. Removing it changes no test. Keep it for legibility if a future refactor
  could wrap the comparison, but do not record it as an enforced invariant.
- A LIVENESS SIGNAL MUST BE ANSWERABLE FOR THE THING BEING ASKED ABOUT. ADR-0027 probed
  Temporal for workflow liveness, which is unanswerable for a process worker, so the
  recovery unit deferred for ever — fail-closed and permanently stuck. Fail-closed is
  correct, but a fail-closed branch that can never be left is a silent dead end. When
  adding a fail-closed default, ask what evidence could ever leave it.
- A COMPOSITION FINDS WHAT UNIT TESTS STRUCTURALLY CANNOT, twice over now. The CORE3
  chaos certification found (a) a QC retry created with no worker, which made a recovered
  task impossible to complete, and (b) a latent `evidenceRefs` bug that had been dormant
  since the reviewer was written and could only fire once something attached evidence to a
  reviewed SUCCESS. Neither was reachable from any single component's tests. Budget for a
  composition test per milestone, not just per component.
- "WIRED" IS NOT "PROVEN". Removing the capacity guard from the QC retry left the whole
  chaos suite green, because the router never CHOOSES a full worker — the guard exists for
  a race (routing is decided outside the transaction and is advisory) that the happy path
  never reaches. A guard whose rejection branch no test reaches is untested code. Drive the
  race directly.
- CERTIFIED IS NOT DEPLOYED. M6.3, M7 and the chaos certification are all proven by
  composing the executor explicitly in tests, and `container.taskExecution` still resolves
  to Temporal. Always ask what the CONTAINER builds, not what the tests build — grep the
  composition root before claiming a capability is live.
- A SKIPPED TEST CAN LOOK LIKE A FIXED TEST. Docker stopped mid-session and 11 integration
  files gated on `describe.skipIf(!dockerAvailable)` vanished into the skip count — taking
  the 3 D1 failures with them, so the suite read 0 failed. Always compare the SKIP count as
  carefully as the fail count; a sudden drop in failures with a jump in skips is an
  environment change, never progress.
- ASK GIT THE QUESTION YOU ACTUALLY MEAN. `git branch -d` checks a branch against HEAD, not
  against the ref you integrate into, so reaping silently never fired and branches
  accumulated forever. The bug was a plausible-looking call that answered a DIFFERENT
  question correctly. Verify git semantics empirically in a scratch repo — it took thirty
  seconds and settled it.
- PREFER A COMPARE-AND-SWAP TO A MERGE. `update-ref <new> <expectedOld>` gave exactly-once
  integration, atomicity, no merge commits, no machine conflict resolution and no
  checked-out tree — all from one primitive that `git merge` would have given none of.
- RUNNING THE PATH FINDS THE MISSING LINK. The coordinator never passed a review verdict to
  the gate, so an autonomous run could never reach ACCEPT. Nothing in the types said so; the
  gate simply answered NEEDS_HUMAN_APPROVAL the first time the whole flow was executed.
- THE SAME DEFECT SHAPE APPEARED THREE TIMES: a capability fully built and proven, and the
  CONTAINER never wiring it (defect 22: taskExecution was Temporal; defect 23: the supervisor
  got `undefined` for its coordinator). Both were invisible because every proof composed the
  thing by hand. The fix is structural, not vigilance: extract the production composition
  (`composeAutonomyRuntime`) and make proofs call IT. A test that wires its own graph proves
  the graph it wired, not the one that runs.
- MAKING A PATH THE DEFAULT IS WHERE ITS LATENT DEFECTS SURFACE. Turning governed allocation
  on uncovered three bugs that had been unreachable: a registry that never persisted the test
  database name (so PostgreSQL workspace creation could NEVER succeed), a slug format that
  violated the database-name guard, and an acknowledgement that assumed asynchronous dispatch.
  None was findable by unit tests; all three were found by the first real run.
- FAIL-CLOSED CHANGES MAKE PREVIOUSLY-DECORATIVE METADATA LOAD-BEARING. `allowedFileScope` was
  optional and mostly empty; now an unscoped writer blocks. That is correct, and it instantly
  exposed that `PostgresMissionRepository.create()` hardcodes constants (defect 24). Expect a
  fail-closed rule to surface every place the data was never really filled in.
- A STABLE FAILURE IS NOT AN UNDERSTOOD FAILURE. D1 sat for six milestones behind an
  accurate sentence — "pre-existing, count has never moved, this milestone does not touch
  src/server/auth/" — that was true every single time and explained nothing. The bug was a
  container closing one of the three PostgreSQL clients it opened, so a CLI finished its work
  and never exited. One direct run of the CLI showed it printing the right answer and hanging.
  When a failure is stable, stop proving it is not yours and ask what the process is doing.
- A LEAKED HANDLE IS INVISIBLE IN A SERVER AND FATAL IN A CLI. The same defect had existed
  since Phase 8D without symptom, because every other consumer was long-lived. Any component
  that opens a connection must be closed by whoever composed it — and the regression proof
  counts real backends in `pg_stat_activity` rather than naming the clients, so it catches the
  next one too.
- THE SAME DEFECT SHAPE HAS NOW APPEARED FOUR TIMES: a capability fully built, fully proven,
  and never wired into the container (taskExecution was Temporal; the supervisor got
  `undefined` for its coordinator; the self-development coordinator is composed nowhere; and
  that coordinator's own gate had no applier). Care has not prevented it once. The only thing
  that has is a TEST THAT ASSERTS THE COMPOSITION — `container-external-executor-wiring`
  catches it, a hand-built harness never will. Write that test first, next time.
- A COMPONENT WITH ITS OWN EXECUTION ABSTRACTION WILL BYPASS THE CERTIFIED PATH. The
  self-development coordinator takes an injected `CanonicalExecutionHandoff`, so composing it
  would still not make it use runtime-based dispatch, governed allocation, routing, leases or
  recovery. An injected seam is not neutral: it is a second authority waiting to diverge.
- "BUILT BUT NEVER EXERCISED" IS THE DOMINANT DEFECT CLASS IN THIS REPOSITORY. M12 alone
  uncovered four more by running one real path: `context_items` mapped snake_case against a
  camelCase table (every write failed), `audit_event_type_check` allowed no `goal.*` event
  (every goal write failed), `createWithImposedId` silently dropped `goalId` (every
  id-imposed autonomous mission lost its lineage), and `saveContextItem` was assumed to
  upsert. None was findable by reading; each took one real execution. Prefer running the path
  to reasoning about it.
- A SCHEMA THAT IS `.strict()` MEETS A REAL MODEL BADLY. The canonical plan schema rejects any
  unlisted field, and an LLM adds one occasionally. The fix was to SAY SO in the prompt, not
  to loosen the contract — and to normalise transport (code fences, narration around the JSON)
  in the provider, where it cannot touch plan semantics.
- A CERTIFICATION ARTIFACT IS A DEFECT WEARING A TEST HELPER'S CLOTHES. Every CORE3 proof
  called `approve(c)` before `supervisor.run`, and that line was read for two milestones as
  test setup. It was in fact the exact statement of defect 28: the gate ran in the same call
  that finished execution, so the ONLY way to reach ACCEPT was to fabricate the approval
  first. When a proof must arrange something the runtime can never arrange for itself, the
  proof is describing a missing capability, not preparing a fixture. Read helper names as
  claims about production.
- AN EDIT THAT IS NOT IN `git status` WAS NEVER MADE. The supervisor half of defect 28 was
  believed applied and was simply absent; CORE3 failed 5/9 for a reason already 'fixed'. The
  stack trace named `supervisor-service.ts:326` and `git status` did not list that file — two
  seconds of evidence against a remembered edit. Trust the working tree, never the memory of
  having changed it. (Same shape as the defect-24 patch that silently failed to apply.)
- A DEFECT THAT LOOKS LIKE ONE LINE CAN BE FIVE. `const attemptNumber = 1` was the visible
  half of REPAIR_WORKSPACE_DEFECT; behind it sat a ready-status allow-list, a held workspace,
  a held capacity slot, a stale in-memory binding and a per-task branch name. Each was
  invisible until the one in front of it was fixed and the path run again. Budget for the
  NEXT layer when a fix reveals one — and re-run the real path after every single layer,
  because reasoning could not have found any of them.
- THE SYSTEM REFUSING IS NOT THE SYSTEM FAILING. Runs died on POLICY_UNKNOWN (a category the
  self-modification policy denies), on NEEDS_HUMAN_APPROVAL (ICOS proposing to change its own
  governance) and on out-of-scope rejections (a writer one directory too high). Three of
  those were the constitution working exactly as written. A red E2E is a question, not a
  verdict: ask what refused and whether it was right before changing anything.
- A CERTIFICATION MARKER NEEDS A PASS RATE, NOT A PASS. SELF_DEVELOPMENT_E2E and
  ICOS_SELF_BUILD_E2E each passed on their first real run, and both were then shown to be
  roughly coin-flips by running them again. Passing once proves the path EXISTS; only
  repetition tells you whether it WORKS. Run a marker twice from a clean target before
  writing it into the ledger.
