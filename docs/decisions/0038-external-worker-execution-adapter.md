# 0038: One external worker execution boundary — a fine failure taxonomy, and a fence that outranks success

## Status
Accepted

## Context

M6.1 (0036) made worker HEALTH real. M6.2 (0037) made it autonomous. Neither makes
a worker DO anything: ICOS could tell that Hermes was alive and could not ask it to
write a line of code.

The existing execution path could not be extended as-is either. `CompositeTask
ExecutionDispatcher` routes on hardcoded worker kinds — `"hermes"`, `"openhands"`,
`"digitalos"` — which is the provider hardwiring decision 0036 removed from probing,
still present on the execution path.

## Decision

### 1. ONE boundary: an adapter at the existing dispatcher seam

`ExternalWorkerTaskExecutionDispatcher implements TaskExecutionDispatcher`. The
supervisor keeps calling the interface it already calls, and the same
`recordTaskExecution` usecase records the proof.

A parallel "external worker path" was rejected: it would mean two places creating
attempts, two recording results, and two to keep exactly-once correct. Under that
seam sits exactly one `WorkerExecutor`, whose adapters are keyed by **RUNTIME**, not
worker kind — the same correction 0036 made, for the same reason. Twenty kinds on one
runtime need one adapter; a novel kind needs none.

There is deliberately **no built-in default command**. The probe could default `node`
to `process.execPath --version` because "can Node run" needs no deployment
knowledge. "Do this task" does: there is no universal way to ask a runtime to perform
work. An unconfigured runtime therefore gets NO adapter and reports
`PROVIDER_UNAVAILABLE` rather than inventing an invocation.

### 2. Two layers of failure, ONE mapping

`task-execution.ts` is the business proof: coarse, Cockpit-facing, never an internal
trace. It is not widened.

The executor needs something else — a taxonomy fine enough to decide whether to
retry. "The provider is throttling us" and "this task is impossible" are both
`WORKER_FAILED` to the business record, and that difference is the entire retry
decision. So `WorkerFailureClass` has the eight required classes, each existing
because it implies a different correct response, with:

- **retryability as an exhaustive frozen record**, not a function with a default. A
  new class cannot be added without a deliberate answer, because silently defaulting
  to retryable is how an impossible task burns its whole attempt budget.
  `FAILED_TERMINAL` is the only terminal class.
- **one deterministic mapping** to the business code. A partially-done run
  (`STREAM_FAILED`, `LEASE_EXPIRED`, `WORKER_CRASHED`) maps to the fail-closed
  `UNKNOWN_EFFECT`: a process that died mid-run tells you nothing about which files
  it had already written, and calling that "the task failed" asserts more than we
  know.
- **the fine class persisted on the attempt** (`dispatch_attempts.failure_class`,
  migration 0046), because the retry decision must outlive the process that observed
  it.

Recognisers are CONFIGURATION (`ICOS_WORKER_FAILURE_CONFIG`). Every signal that
distinguishes throttling from impossibility arrives as a provider-shaped string on
stderr; hardcoding those strings would put provider names back in the core. An
unrecognised failure defaults to retryable — bounded by the attempt budget, whereas
defaulting to terminal risks abandoning recoverable work permanently.

### 3. The fence outranks everything, including success

An execution lease is acquired before the run and re-checked **after** it. A run that
lost its lease mid-flight may not report anything — *including a success*. Reporting a
stale success is exactly how one logical task gets integrated twice.

The lease uses NEW columns, not `claim_token`/`claim_until`. Those already fence who
may DISPATCH a `prepared` attempt during recovery; this fences who is RUNNING a
`dispatched` one. Different state, different lifetime, different owner, and both can
be held simultaneously by different processes. Sharing them would let a recovery
sweeper and a running executor silently overwrite each other's fence — the precise
double-execution bug the fence exists to prevent. This answers, for the execution
half, the question STATE.md left open for M7.

### 4. Resume is a continuation of the same logical task

`resume_token` and `handoff` are recorded on the attempt that failed; the next
attempt inherits them via `latestResumableState(missionTaskId)` and they are injected
into the prompt under an explicit "do not start over" heading. A retry remains a new
attempt row for the same `missionTaskId` — the existing ledger model, not a parallel
concept.

### 5. Writer isolation is enforced, not requested

A writer gets its own `git worktree` on its own `icos/worker/...` branch, and
`provisionWorkspace` **refuses** to return a path inside the canonical checkout. An
external worker is an autonomous process running a model's decisions; pointed at the
integration checkout it can reset, amend or checkout at will, concurrently with the
supervisor. A worktree makes the blast radius one branch, and makes "what did this
worker change" a question git answers exactly — which is what turns a CLAIM into
EVIDENCE.

Readers share the canonical checkout, because a read cannot corrupt it, and are handed
an empty `allowedFileScope`.

**The executor does not integrate.** A successful run leaves a branch and records it;
merging is a separate, later decision. The task advances to `review_pending`, never to
`succeeded`.

### 6. Evidence over claims

Commit hash, commit list and changed files are read from git in the workspace, not from
the worker's report, and are collected **whatever the outcome** — a killed run may still
have committed work, and discarding it would make the next attempt redo it. A worker
saying "I committed the fix" is a claim; `git rev-parse HEAD` is evidence. Uncommitted
changes count as changed files; `commitHash` is null when nothing was committed, because
returning HEAD would imply work that did not happen.

### 7. Non-interactive, by construction

One shared runner (`run-process.ts`), extracted from M6.1 rather than copied, because
two runners drift and the one that drifts is the one that forgot to close stdin:
stdin `ignore`, SIGTERM-then-SIGKILL timeout, no shell, bounded output, never
rejects. The task contract is injected both as a JSON file (path in argv and env) and
as a composed prompt, because real CLIs disagree about which they want. The contract
file lives OUTSIDE the workspace: written inside, it would appear in `git status` and
become part of the changed-files evidence — the observation corrupting the observed.

## Consequences

- ICOS can launch, control, classify and resume real external workers with no human
  present. Proven against a live Hermes agent.
- `task_execution_results.worker_kind` still has a CHECK allow-list containing
  `'hermes'`/`'openhands'`/`'digitalos'`, and `CompositeTaskExecutionDispatcher` still
  branches on those names. External workers record `workerKind: 'agent'` and carry
  provider identity in the identity axes instead, so this decision adds no new
  hardwiring — but it does not remove the old one. Recorded as a defect.
- Defect 17 (worker-death recovery) is UNCHANGED and now the last structural hole: the
  lease makes an abandoned execution *reclaimable*, but nothing yet sweeps for expired
  leases and re-routes the task. That sweeper is M7.

## Evidence

- 1750 unit tests (+49), 19 new PostgreSQL proofs, 6 mutations verified.
- **A real Hermes agent** (`/Users/coco/.local/bin/hermes`, Nemotron-class model via a
  custom endpoint) launched non-interactively with `-z`, received the ICOS-composed
  contract, echoed a unique per-run token back, and left its isolated branch clean —
  5.3s of real network round-trip. Codex is present on the same machine and needs only
  a config entry, no code.
- migration 0046 applied 3x via psql exit 0, then through `migrate()`; ledger 44 rows;
  `\d dispatch_attempts` shows all five columns, the CHECK and the partial index;
  `failure_class = 'SESSION_EXHAUSTD'` is rejected by the database.
- integration 407 pass / 3 fail — the 3 are pre-existing D1 auth-bootstrap-cli, a count
  that has never moved. typecheck PASS, build PASS, lint 0 errors / 289 warnings
  (= baseline), `git diff --check` PASS.

### A defect the end-to-end run found that no unit test did

The classifier first short-circuited on any `status: "failed"` from the worker. A real
worker that reported failure *without* a class while printing "context window
exceeded" was therefore filed as an anonymous `FAILED_RETRYABLE` — the diagnosable
cause discarded in favour of the catch-all. Only an explicit class may outrank the
recognisers; a classless "I failed" now falls through to them. The unit suites missed
it because only a real worker emitted both signals at once, which is the argument for
end-to-end proofs that unit coverage cannot replace.
