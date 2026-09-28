# 0042: Allocation belongs to attempt preparation, and what the work may touch decides it

## Status
Accepted

## Context

M8 closed defects 22 and 19: external execution is wired into the container, and an accepted
worker result reaches the canonical branch exactly once and is reaped. But
`WorkspaceExecutionCoordinator.allocateWorkspace` was still only called explicitly, so an
*ordinary* autonomous mission never reached any of it — it dispatched with no registered
workspace, the executor fell back to an ad-hoc worktree, and the branch was orphaned exactly
as before. Defect 23.

The root cause was the same shape as defect 22, for the third time: **the capability existed
and the container did not build it.** `production-services.ts` passed `undefined` for the
supervisor's coordinator, so the supervisor's workspace branch was dead code in every real
deployment.

## Decision

### 1. Allocation happens during normal attempt preparation

The supervisor allocates the governed workspace immediately after `prepare()` succeeds and
**before any external execution**, keyed by the canonical `workflowId`. The manager is
idempotent on that key, so a recovery replay or a second supervisor tick continues in the
workspace that already holds the worktree and branch rather than forking a second one; a
*different* workflow id bound to the same task is refused as `WORKFLOW_COLLISION`.

### 2. What the work may TOUCH decides governance — not who executes it

The previous condition was `routedWorkerKind`. That is wrong twice over: an unrouted task
silently skipped governance entirely, and it let WHO executes decide whether the work is
governed.

`decideWorkspaceAllocation` reads only `riskClass` and `allowedFileScope` from the canonical
Task. Provider, worker kind and model are not inputs — the policy's parameter type has no
field for any of them, so the mistake cannot be reintroduced by editing a condition.

- `read_only` → **NOT_REQUIRED**. A reader mutates nothing; a worktree would cost a full
  checkout for nothing.
- a writer with a declared scope → **GOVERNED**, and the declared scope *is* the workspace
  scope. Not cosmetic: the gate rejects every changed file outside `owns`, so a generic
  default would turn each governed run into a rejection.
- a writer with **no** declared scope → **REFUSED**, and the task is `blocked`.
- absent metadata → treated as a **writer**. Guessing "reader" would skip governance for
  exactly the tasks whose intent nobody wrote down.

### 3. Fail closed, because the alternatives are worse

A writer that cannot be governed has three possible treatments: invent a permissive scope
(an autonomous agent could then write anywhere), fall back to an ad-hoc worktree (the
orphan-branch defect), or block. **Only blocking is recoverable**, and it is visible.

### 4. Proofs compose nothing by hand

`composeAutonomyRuntime` was extracted from `createRecoveryScheduler` so the runtime and its
proofs use the same function, and the certification additionally boots the real
`startProductionServices`. A hand-built composition is precisely how defects 22 and 23 stayed
invisible: the test wired what the container did not.

## Consequences

- An ordinary autonomous writer task now runs governed by default: registered workspace →
  real external worker → independent review → gate → integrate once → reap.
- Deployments must declare `ICOS_REPO_PATH` and `ICOS_WORKER_WORKSPACE_ROOT`; the workspace
  manager previously fell back to one developer's absolute paths.
- Planning must declare `allowedFileScope` on writer tasks or they block. `applyPlan` still
  hardcodes task metadata (the M2 gap), so this is the first place that gap has teeth —
  recorded as a defect rather than worked around.

## Three latent defects this uncovered, none of which a unit test could reach

**The PostgreSQL workspace path could never allocate anything.**
`PostgresWorkspaceRegistry.rowToWorkspace` hardcoded `testDatabase: ""` with a comment saying
the manager would set it — but the manager *reads* the workspace back from the registry, so
the name was always empty and `create()` failed every time with `DATABASE_FORBIDDEN`. It is
now derived from the slug (`testDatabaseName`), keeping one source of truth rather than a
stored copy that could drift.

**Any hyphenated slug broke workspace creation.** `assertWorkerDatabaseName` enforces
`^icos_test_[a-z0-9_]{1,32}$`, and the coordinator's own former default — `task-<id>` —
contains a hyphen. Slugs are now underscore-only.

**A synchronous dispatcher could not be acknowledged.** `markDispatched` required state
`prepared` or `dispatched`, which assumes Temporal's fire-and-forget shape. The external
executor runs the process, records the result and settles the attempt inside `dispatch()`, so
the acknowledgement arrives when the attempt is already `completed` or `failed` — evidence the
dispatch happened, not that it failed. `prepared` remains invalid.

## Evidence

- 1788 unit tests, 7 new PostgreSQL certification proofs driving the REAL container and
  `startProductionServices`, 8 allocation-policy unit proofs.
- 4 mutations verified: passing `undefined` for the coordinator (the defect-23 state) fails
  three certification proofs including the `startProductionServices` one; gating on worker
  kind fails the default-path proof; allowing an unscoped writer to run fails the fail-closed
  proof; ignoring the task's declared scope fails the default-path and restart proofs.
- integration 438 pass / 3 fail / 2 skipped, Docker confirmed running. The 3 failures are the
  pre-existing D1 auth-bootstrap-cli timeouts, a count that has never moved; the 2 skips are
  the opt-in live Hermes proof.
- typecheck PASS, build PASS, lint 0 errors / 289 warnings (= baseline), `git diff --check`
  PASS, ledger 44 rows (no migration).
