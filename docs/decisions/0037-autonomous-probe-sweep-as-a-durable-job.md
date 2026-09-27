# 0037: The probe sweep is a durable job on a shared grid — and ignition is not recurrence

## Status
Accepted

## Context

Decision 0036 made worker probing REAL: `CommandWorkerProbe` runs a runtime
non-interactively and `container.workerHealthProber` is composed with adapters
keyed by runtime. That closed the first half of defect 16.

The second half was still open, and it made the first half worthless in a real
deployment: **nothing ever called `probeAll()` or `expireStaleEvidence()`.** A
probe nobody runs is a probe that does not exist. Health evidence is dated and
expirable by decision 0033, so with no caller every worker's evidence ages out,
every worker becomes ineligible, and the whole fleet refuses every task — while
presenting as a routing defect rather than as a missing caller.

M5 certification was withdrawn by 0036 pending this decision.

## Decision

### 1. The sweep is a `scheduled_jobs` job, never a `setInterval`

`probe_workers` joins the durable scheduler's kind allow-list (ADR-0025,
migration 0045).

A timer was rejected for two reasons, both fatal rather than stylistic:

- a timer runs once **per process**, so N replicas would probe the same fleet N
  times, multiplying real process spawns against real workers;
- a timer **vanishes on restart**, so probing would silently stop exactly when a
  deployment is least stable.

`scheduled_jobs` already holds the next run time durably and hands out a lease, so
exactly one process sweeps at a time and the recurrence survives a restart. Timers
only trigger a consultation of the table; they are never the source of truth.

The `kind` column remains an ALLOW-list. Widening it by one value must not turn it
into free text, or a typo'd kind would become a row no handler can ever run.

### 2. The interval is DERIVED from the evidence horizon, and a bad one is refused

`DEFAULT_WORKER_PROBE_INTERVAL_MS = HEALTH_EVIDENCE_MAX_AGE_MS / 4`. Probing must
be several times more frequent than expiry, or healthy workers flicker out between
sweeps. Deriving it means the two cannot drift apart when someone tunes the horizon.

An interval at or above the horizon is **refused at composition time**
(`WORKER_PROBE_INTERVAL_EXCEEDS_HORIZON`). Such a configuration means evidence is
always stale by the next sweep, so the fleet could never take work. Booting a fleet
that is structurally incapable of accepting a task is worse than not booting.

### 3. Occurrences are snapped to a GLOBAL GRID, not offset from a caller's clock

An occurrence is due at `(floor(now / interval) + 1) * interval`, and its
idempotency key is that instant.

`now + interval` was the obvious version and it is wrong. It is relative to
whoever computed it, so a restart or a second replica mints an occurrence a few
seconds off the live chain's, with a **different** idempotency key: two chains,
probing forever, neither able to detect the other. On a shared grid every process
computes the same instant and therefore the same key, so the duplicate is refused
by the database.

This is what makes the next point possible at all.

### 4. IGNITION IS A SEPARATE CONCERN FROM RECURRENCE

The handler re-enqueues its successor, so the chain perpetuates itself. A
self-perpetuating chain with no first link never runs — the same defect-16 trap one
level up.

`seedWorkerProbeSweep` is therefore called at process start, in
`startProductionServices`, and it is **unconditional**. Grid alignment is what
allows that: a live chain already owns the key, so ignition is a no-op; if the
chain never started or died, ignition is the link that restarts it. It targets a
FUTURE occurrence, so it can never collide with an already-completed one and
mistake it for a live chain.

A failed ignition **aborts startup**. Silently running a fleet that cannot take
work is the failure mode this whole decision exists to prevent.

### 5. Failure is visible, never silent

- the sweep is re-enqueued **after** it succeeds. If the sweep throws, the
  scheduler retries THIS job with its own backoff instead of the handler quietly
  scheduling a successor and abandoning the failure: one recurrence chain, and a
  failing fleet stays visible as a failing job;
- a lost re-enqueue is a `PermanentJobError`, so it surfaces as a dead job rather
  than as mysterious idleness;
- a deployment that scheduled probing but composed no prober gets
  `SCHEDULER_WORKER_PROBE_UNAVAILABLE`, not a silent success.

Replay is safe by construction: a probe is an observation, not a mutation of work,
so probing twice is harmless, and the re-enqueue is deduplicated by key.

## Consequences

- worker health is now maintained autonomously, once per fleet, across restarts;
- `ICOS_WORKER_PROBE_INTERVAL_MS` must be consistent across replicas. Mismatched
  values build one grid per distinct interval, hence one chain per interval. This is
  a known ceiling, marked in the code: closing it needs a `kind`-scoped pending-job
  query, i.e. a new `ScheduledJobRepository` contract method. Not worth it until a
  deployment actually runs heterogeneous intervals;
- defect 16 is CLOSED. Defect 17 (no worker-death recovery) is untouched and is now
  the largest remaining hole: a worker dying mid-execution is detected, but its task
  is never reassigned and its capacity slot is lost permanently. That is M7.

## Evidence

- 1701 unit tests (+18), 5 new PostgreSQL proofs on real Postgres;
- migration 0045 applied 3x via psql, exit 0 each time; ledger 43 rows;
- `probe_workers` insertable, `probe_wrkers` rejected by
  `scheduled_jobs_kind_check` — verified via psql and in an integration test;
- 6 mutations applied and reverted, each killing at least one test: ignition
  removed; grid replaced by `now + interval` (unit and PostgreSQL); successor
  re-enqueue removed; real sweep removed; container wired with no prober;
- integration 388 pass / 3 fail — the 3 are pre-existing D1 auth-bootstrap-cli,
  a count that has never moved;
- typecheck PASS, build PASS, lint 0 errors / 289 warnings (= baseline),
  `git diff --check` PASS.

### A mutation that survived, and what it taught

Replacing the grid with `now + interval` initially left the whole suite GREEN. The
composition-level tests boot twice within the same second, and the idempotency key
is second-granular, so the broken version deduplicated **by accident**. Only a test
with an INJECTED clock — boots 7 seconds apart, same bucket — distinguishes
"aligned to a shared grid" from "aligned to whoever asked first". A green suite
under mutation is information, not a pass.
