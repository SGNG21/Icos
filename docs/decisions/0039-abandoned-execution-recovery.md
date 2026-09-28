# 0039: The execution lease is the liveness probe a process worker never had

## Status
Accepted

## Context

Defect 17, stated precisely: a worker that died **mid-execution** was detected — its
probe evidence expired, so routing stopped choosing it — but the task it was holding
was never reassigned. The attempt stayed `dispatched`, and because durable load is
DERIVED by counting non-terminal attempts (decision 0034), that worker's capacity slot
was consumed **permanently**. Detection without reassignment.

M6.3 (0038) added the execution lease, which made the death *observable*. This decision
adds the caller that acts on it.

### Why the existing recovery sweeper did not already cover this

ADR-0027's `RuntimeRecoverySweeper` already scans for orphaned `dispatched` attempts.
It could not recover an external worker, and the reason is structural:
`listOrphanedDispatched` hands its candidate to a `WorkflowProbe`, which asks **Temporal**
whether a workflow still exists. A process-based external worker has no workflow. The
probe therefore answers `unknown`, the sweeper's `default` branch DEFERS, and the unit
defers forever — fail-closed and permanently stuck. That is the exact mechanism by which
defect 17 survived M6.3.

## Decision

### 1. The lease is the liveness signal, and it replaces an unanswerable question

A live runner renews its execution lease; a dead one cannot. So an **expired lease on a
still-`dispatched` attempt is positive evidence** that nobody is executing it — rather
than the unanswerable "is there a workflow?".

`listAbandonedExecutions` is therefore a **separate candidate source**, not a widening of
`listOrphanedDispatched`. Same table, different evidence, different verdict: one can only
defer, the other can resolve.

### 2. It is an ordinary recovery unit, not a new mechanism

`dispatch_execution_abandoned` joins `RecoveryUnitKind` and flows through the existing
`recovery_units` claim. It inherits, for free and without new code:

- durable mutual exclusion, so two processes reclaim one abandonment once;
- a **bounded** attempt budget (`maxAttempts`), so a deterministically-dying worker is not
  retried forever;
- backoff, deferral and the "one bad unit never stalls the others" property.

**I deliberately did NOT use the M6.2 `scheduled_jobs` pattern here**, even though
STATE.md's own M7 entry note told me to. Reading the code changed the answer: the runtime
recovery sweeper is *already* driven on a timer by `AutonomyRecoveryScheduler`, so a new
scheduled job would have been a **second recovery path** for the same table — the exact
duplication requirement 9 of M6.3 forbids. The earlier note was written before that code
was read; it is superseded, and this is recorded so the contradiction is not mistaken for
an oversight.

No migration was needed: `recovery_units.kind` has no CHECK constraint. (Noted as a small
inconsistency with `scheduled_jobs.kind`, which is allow-listed — recorded as a defect
rather than changed here, since tightening it is its own decision.)

### 3. Settle the attempt FIRST — that is the actual fix

`reclaimAbandonedExecution` settles the attempt before recording the business result.
Ordering matters because **settling the attempt is what frees the capacity**: load is
derived from non-terminal attempts, so an attempt left `dispatched` holds the slot for
ever. The lost slot, not the missing result, is defect 17.

The class is `LEASE_EXPIRED`, mapping to the fail-closed `UNKNOWN_EFFECT`: the worker died
mid-run, so we do not know what it wrote. Its branch survives as evidence either way.

**No resume token is carried.** The runner died before recording one, and inventing a
continuation from an unknown state would be worse than starting clean.

### 4. Three fail-closed guards

- **A live runner is never reclaimed** out from under itself — an unexpired lease is not a
  candidate.
- **A grace period applies on top of expiry**, so a runner finishing a long commit is not
  reclaimed a millisecond late.
- **A late real result always wins.** If a result landed between the scan and the action,
  nothing is reclaimed and nothing is overwritten. Overwriting a genuine success with
  `UNKNOWN_EFFECT` would destroy real work.

Re-dispatch itself remains the existing QC/supervisor decision, as with
`recordLostExecution`. This decision frees the slot and records the loss; it does not add
a second re-routing authority.

## Consequences

- **Defect 17 is CLOSED.** A worker killed mid-execution has its task reclaimed, its slot
  returned, and the same logical task runs on another worker exactly once.
- Recovery now has two complementary evidence sources for a `dispatched` attempt: a
  Temporal workflow probe, and an execution lease. Neither subsumes the other, and a
  deployment using both gets both.
- Still open (defect 19): **nothing integrates a worker branch.** A reclaimed attempt's
  branch, and a successful attempt's branch, both simply accumulate. That is the last gap
  before the self-build loop closes.

## Evidence

- 1754 unit tests (+4), 8 new PostgreSQL proofs, 5 mutations verified.
- **Real chaos**: an actual OS process is spawned and `SIGKILL`ed, and the lease expires by
  **wall clock** — not by an UPDATE pretending it did. Proven: the slot is consumed before
  recovery (`listActiveWorkerAssignments() == [WORKER_A]`) and empty after, and attempt 2
  then `prepare`s successfully on worker B — which only succeeds if the slot genuinely
  came back, because `prepare` enforces concurrency inside its own transaction.
- Two concurrent sweepers reclaim one abandonment exactly once.
- integration 415 pass / 3 fail — the 3 are pre-existing D1 auth-bootstrap-cli, a count
  that has never moved. typecheck PASS, build PASS, lint 0 errors / 289 warnings
  (= baseline), `git diff --check` PASS, ledger 44 rows (no migration).

### A mutation that survived, reported rather than buried

Removing the scanner's `execution_lease_owner is not null` guard changed no test. Removing
**both** lease-presence guards also changed no test. The reason is SQL's three-valued
logic: a NULL `execution_lease_until` already fails the age comparison, so the explicit
guards are **legibility, not enforcement**. They are kept — a future refactor wrapping that
comparison in a `coalesce` would silently start admitting never-leased attempts — but the
code comment and the test now say plainly that the test does not prove the guards. A green
suite under mutation is information, not a pass.
