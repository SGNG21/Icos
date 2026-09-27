# 0034: Distribution is derived from the durable ledger, and a worker is not an unlimited slot

## Status
Accepted

## Context

Decision 0031 made capability routing fail closed and reproducible across a
restart. Decision 0033 made health evidence dated and expirable. Selection,
however, was still **first-eligible-by-id** (defect 15):

> ten ready tasks and three healthy, capable workers all went to worker A.

Exactly-once dispatch PER TASK was already certified by CORE2
(`postgres-supervisor-dispatch-race`, `postgres-concurrent-dispatch-recovery`,
`postgres-multiworker-concurrent`). The gap was purely **distribution**, plus two
things the schema could not express:

1. **Nothing to count.** `dispatch_attempts` recorded the routed worker KIND,
   never WHICH worker. Per-worker load was unknowable, and so was attribution:
   "which worker produced this?" had no durable answer, leaving reviewer
   independence without a real producer identity (defect 12).
2. **No ceiling to count against.** With no declared concurrency, a worker is
   implicitly an unlimited execution slot — "least loaded" has no meaning and
   oversubscription cannot even be defined.

The hard constraint from 0031 governs any fix: a distribution policy MUST be a
pure function of durable state. An in-memory round-robin cursor distributes
perfectly and silently destroys `ROUTING_SURVIVES_RESTART`, because a fresh
process starts its rotation over.

## Decision

### 1. Load is DERIVED from the dispatch ledger, never stored

There is deliberately **no `workers.current_load` column and no counter**. Load
is the count of NON-TERMINAL rows in `dispatch_attempts`, grouped by
`worker_id` — the same rows that already certify exactly-once dispatch.

A counter would be a second authority that can disagree with the ledger, and
every disagreement is a lost or duplicated dispatch. Deriving it means the number
cannot drift, and it reproduces identically in a fresh process for free.

`DispatchAttemptRepository.listActiveWorkerAssignments()` returns one entry per
active execution; `computeWorkerLoad()` folds that into per-worker and per-pool
tallies. One definition of "load" for the whole system.

### 2. The policy is least-loaded, then worker id

Ordering IS the policy, and it lives in the ONE canonical matcher — no second
selector. Least durable load first, worker id as the tie-break, nothing else.

This is the simplest rule that actually distributes AND stays a pure function of
durable rows: two processes, or one process before and after a restart, derive
the same order from the same database. A clock, a random pick or a rotation
cursor would each distribute too, and each would break 0031.

With no load snapshot the order is by id alone — the pre-M5.3 behaviour, kept for
the synchronous single-decision consumers (reviewer selection, bounded repair),
which pick one worker for one decision and cannot oversubscribe a fleet.

### 3. Capacity: a worker declares a maximum, and pools are shared (migration 0044)

- `workers.max_concurrency` — NOT NULL DEFAULT 1. The default matters: the
  alternative assumption (unlimited) is what makes distribution meaningless.
- `workers.capacity_pool` / `capacity_pool_limit` — an opaque SHARED ceiling.

The pool is the axis that keeps **Worker != Model != Provider != Account !=
CapacitySlot** honest. Several DISTINCT workers may draw on ONE provider or
account quota, and a per-worker limit cannot express that: without a shared
ceiling, pointing three workers at one account silently triples the quota. A
worker can therefore be completely idle and still have nowhere to run.

No provider is named anywhere in the schema, the matcher or the router. The pool
is a string routing counts against and never interprets.

**A quota is a ceiling, so disagreement resolves DOWNWARDS.** When members of one
pool declare different limits, the SMALLEST governs everyone
(`effectiveCapacityPoolLimits`). Taking the largest, or the first seen, would let
one misdeclared worker raise the real limit for all its peers.

This is deliberately NOT the Resource Manager. It is the minimum durable
vocabulary that keeps the axes separable, so the Resource Manager can later own
model/provider/account/slot without a migration that re-interprets worker rows.

### 4. Two independent enforcement layers, on purpose

The routing decision reads load OUTSIDE any transaction, so it is **advisory**:
two supervisors can both observe "worker W is free" and both choose it.

- **Read boundary** — `AT_CAPACITY` and `CAPACITY_POOL_SATURATED` gates in the
  matcher keep a saturated worker out of the candidate set, so normal operation
  spreads work instead of queueing it.
- **Write boundary** — `prepare()` re-checks the worker's concurrency and its
  pool INSIDE the transaction that creates the intent, after taking a row lock on
  the worker and on every peer sharing its pool. Locks are acquired in worker-id
  order, so two transactions touching one pool cannot deadlock.

Either layer alone is insufficient: the read boundary loses the race, and the
write boundary alone would let the router keep proposing a full worker forever.
Both were verified independently by mutation (removing either one leaves pool
limits enforced; removing both breaks them).

An UNREGISTERED worker id is refused by the guard: assigning work to a worker
absent from the registry means deciding against state that no longer exists, and
the resulting attempt's load would be bounded by nothing.

### 5. A capacity refusal is back-pressure, not failure

`WorkerCapacityExceededError` is a distinct type because the correct response is
distinct. The supervisor catches ONLY this error and leaves the task ready for a
later tick — possibly routed to a different worker. Nothing durable changed.

It deliberately does NOT mark the task `blocked`: blocking would turn transient
back-pressure into an operator-visible fault. Every other prepare failure still
propagates, so a real defect can never be mistaken for a full worker.

### 6. `dispatch_attempts.worker_id` has no foreign key

Attribution must outlive the worker. A `RESTRICT` reference would make
deregistering a worker impossible once it had done any work; `SET NULL` would
erase the historical record of who did it. Routing reads the column only to COUNT
load, never to decide eligibility.

## Consequences

- Ten ready tasks across three single-slot workers now occupy three workers and
  leave the remaining seven ready, instead of piling ten onto one worker.
- Oversubscription is impossible even under a lost race: the loser is refused,
  atomically, with no durable trace.
- Reviewer independence and bounded repair gain a real producer identity
  (defect 12 closed).
- Distribution survives a restart: a fresh process recounts the same rows and
  continues the same assignment rather than restarting a rotation.
- Fairness is "within one job" for equal-capacity workers, not weighted. Cost,
  latency and priority are NOT inputs. Adding them means adding a score, and a
  score must still be derived only from durable rows.
- **Not built:** the Resource Manager. `AIResourceCatalog` remains a second
  hardcoded capability source with zero consumers on the dispatch path
  (defect 10). The pool vocabulary exists so it can arrive without reinterpreting
  worker rows.

## Evidence

- `src/core/workers/worker-eligibility.test.ts` — 18 distribution/capacity proofs;
  four mutations verified (ordering removed, AT_CAPACITY removed, pool gate
  removed, pool ceiling resolving upwards).
- `src/server/routing/postgres-multiworker-orchestration.integration.test.ts` —
  16 proofs against real PostgreSQL: distribution across three workers, load
  derived by a different process, unhealthy/unavailable/incapable workers refused
  while idle, stale evidence stopping distribution, restart continuing the same
  assignment, both DB CHECK constraints, concurrent prepares resolving to exactly
  one winner, and two concurrent supervisors dispatching each task once.
- Mutations verified at the integration level: removing the atomic guard fails 3
  tests, not recording `worker_id` fails 12, removing distribution ordering fails
  1, and removing BOTH pool layers fails the 2 pool proofs.
- Migration 0044 applied 3× via psql, exit 0 each time; ledger verified (42 rows).
