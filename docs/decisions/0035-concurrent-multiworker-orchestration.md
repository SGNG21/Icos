# 0035: Concurrent multi-worker orchestration, and why unlock is a derivation

## Status
Accepted

## Context

Decisions 0031–0034 built the parts: a fail-closed matcher, live durable routing,
dated health evidence, derived load and capacity. What had never been proven was
the whole thing running CONCURRENTLY on MORE THAN ONE WORKER while the DAG
advanced correctly.

The smallest shape that cannot be faked by a queue:

```
A ──┐
    ├──> C
B ──┘
```

A and B are independent and must run at the same time on DIFFERENT workers. C
must become runnable EXACTLY ONCE, and only after both parents complete
canonically.

CORE2 already certified exactly-once dispatch PER TASK under concurrent
supervisors (`postgres-supervisor-dispatch-race`,
`postgres-concurrent-dispatch-recovery`, `postgres-multiworker-concurrent`). That
work is deliberately NOT rebuilt. What was missing is the multi-worker layer on
top: per-worker assignment, dependency gating across distinct workers, and proof
that leases, fencing, a replayed callback or a restart cannot advance the DAG
twice.

## Decision

This milestone adds **no new mechanism**. It proves the existing ones compose,
and records what the composition actually guarantees. Three findings are worth
writing down because each contradicts a plausible assumption.

### 1. Unlock is a DERIVATION, so it cannot fire twice

`computeReadyTasks` recomputes readiness from persisted rows every time (0030).
There is no unlock event, no "C became ready" message, and therefore nothing that
can be delivered twice. Running the supervisor three times in a row, or from
three processes at once, produces exactly one attempt for C.

The exactly-once guarantee is thus split cleanly and deliberately:

- **Unlock** is idempotent because it is derived, never stored.
- **Dispatch** is exactly-once because the ledger arbitrates it atomically.

A stored `ready` flag would collapse these two into one fragile mechanism — which
is exactly the double-unlock bug shape 0030 rejects (R5).

### 2. The completion path continues the mission itself

`recordMissionTaskExecution` calls `continueMission` after an approved review, so
**C is already dispatched by the time the second parent's completion returns**.
Any test or operator expecting to dispatch C "afterwards" is describing a system
that does not exist.

This makes the exactly-once property stronger, not weaker: C is dispatched by the
completion path AND the supervisor is then run repeatedly on top, and still
exactly one attempt exists.

### 3. Worker separation is enforced REDUNDANTLY, and that is intentional

Two independent mechanisms keep A and B on different workers:

- the least-loaded ordering of decision 0034, and
- the `AT_CAPACITY` gate.

Mutation testing showed that removing **either one alone** preserves the
behaviour, and removing **both** breaks six proofs. This is defense in depth
rather than duplication: the ordering spreads work in the normal case, and the
capacity gate is what holds when the ordering is fed a stale snapshot — which it
always can be, since the snapshot is read outside the transaction.

### 4. What fencing means here

- `authorizeStart` refuses a workflow id that is unknown, or that belongs to a
  different task, and reports `alreadyRunning` for a duplicate start rather than
  starting twice.
- `prepare` refuses an attempt number below the authoritative one
  (`DISPATCH_ATTEMPT_STALE`), so a late writer holding an old attempt cannot
  reassert itself over a retry.
- A recovery lease is exclusive while live and reacquirable once expired, so one
  dead recoverer cannot strand work and two live ones cannot both replay.
- A crash-orphaned `prepared` attempt is replayed under the SAME deterministic
  workflow id, so the external runtime deduplicates it.

### 5. A restart mid-execution adds nothing and loses nothing

With A and B in flight on two workers, killing the process and recovering in a
fresh one produces **byte-identical attempt rows**: no new attempt, no
re-dispatch, and the surviving state still completes the diamond with exactly one
attempt for C.

## Consequences

- Multi-worker orchestration is certified end to end: concurrent execution on
  distinct workers, correct dependency gating, exactly-once DAG advancement,
  and correct resumption after a restart.
- Per-worker attribution is available on every attempt, so "who did this?" has a
  durable answer for reviewer independence and for post-hoc audit.
- **Test-isolation hazard, recorded because it cost real time:** `recover()`
  replays the latest checkpoint, so an integration test that truncates missions
  and tasks but NOT `checkpoints` inherits the previous test's DAG state and
  fails in a way that looks like a routing defect. Truncate `checkpoints` and
  `context_items` in any suite that calls `recover()`.
- **Not proven here:** automatic recovery from a worker that dies MID-execution
  (as opposed to a supervisor process that dies). Detection exists — probe
  evidence expires and the worker becomes ineligible — but nothing yet reassigns
  the task it was holding. That is M7, and it is the next real gap.

## Evidence

`src/server/supervisor/postgres-m54-multiworker-orchestration.integration.test.ts`
— 15 proofs against real PostgreSQL: A and B on distinct workers in one pass, C
gated while one parent is in flight, C dispatched exactly once after both
complete (including under three concurrent supervisors), durable assignment read
by a different process, atomic claims, exclusive and expirable leases, fencing
against unknown/mismatched/duplicate start callbacks, stale-attempt refusal,
replayed completions not re-advancing the DAG, restart-mid-execution producing
identical rows, orphaned attempts replayed under the same workflow id, and the
full diamond completing with one attempt per node.

Mutations verified: a `queued` dependency counting as complete fails 2 proofs;
removing the stale-attempt guard fails 1; not recording `worker_id` fails 4;
removing BOTH the distribution ordering and the capacity gate fails 6.
