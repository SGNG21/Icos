# 0033: Health is evidence, not a flag — it must be dated, and it must expire

## Status
Accepted

## Context

Decision 0032 (M5.1) gave the worker registry a write side and made routing read
live durable state. It established that **registration is not a health claim**:
a registered worker is `unknown/unknown` and routes nothing until `probe()`
records something better.

Two gaps remained, recorded as defects 14 and 15. This decision closes 14.

**Nothing produced probe evidence.** `WorkerRegistrationService.probe()` could
RECORD a health verdict, but no loop produced one. Without an operator calling
`probe()` by hand, every registered worker stayed permanently ineligible. The
failure direction was correct; it was not orchestration.

Worse, the recorded verdict had **no timestamp**, which made it impossible to
distinguish two very different situations:

- a worker probed healthy two seconds ago, and
- a worker probed healthy last Tuesday whose process has since died.

Both read `health = 'healthy'`. So:

1. A crashed worker, a dead session or a stopped prober left a `healthy` row
   behind that kept receiving work **forever** — nothing would ever overwrite
   it, because a worker that stops answering also stops being probed.
2. A process restart re-read `healthy` and believed it. The
   `ROUTING_SURVIVES_RESTART` property certified by 0031 was being used to
   resurrect a verdict that no longer described reality: the routing was
   reproducible, but reproducibly wrong.

## Decision

### 1. Probe evidence is dated (migration 0043)

`workers` gains two additive columns:

- `last_probe_at` — when a PROBE last recorded evidence. `NULL` means *never
  probed*. `register()` deliberately leaves it `NULL`.
- `last_probe_outcome` — one of `never | ok | failed | unsupported | stale`.

`failed` and `unsupported` are deliberately **distinct from `never`**. A
runtime/provider probe that failed must stay visible as a failure; collapsing it
into "we have not looked yet" is how a transport error silently becomes an
absence of bad news. A database CHECK (`workers_probe_evidence_dated_check`)
refuses any outcome other than `never` without a timestamp, so undatable
evidence cannot be stored even by a caller bypassing the Zod contract.

### 2. The canonical matcher gains a freshness gate — and stays pure

`src/core/workers/worker-eligibility.ts` remains THE one matcher (0031). It
gains two reasons, `HEALTH_EVIDENCE_MISSING` and `HEALTH_EVIDENCE_STALE`, driven
by an optional `evidenceHorizon: { now, maxAgeMs }` on `WorkerRequirement`.

The clock arrives as **data**, never as a `Date.now()` call inside the module.
That is what allows a freshness rule to live in a pure function: the same
`(worker, now, maxAgeMs)` triple always yields the same verdict, so a routing
decision is still reproducible and `ROUTING_SURVIVES_RESTART` still holds. An
unparseable timestamp is STALE, never fresh. Evidence dated in the future is
accepted: clock skew between a worker host and the router is not the worker's
fault, and treating skew as staleness would take a healthy fleet offline.

`CapabilityRouter` **imposes** the horizon rather than trusting the caller to
pass one, so no consumer can accidentally route on undated evidence.

### 3. Staleness fails closed at BOTH boundaries

- **Read boundary** — the router refuses stale evidence at the moment of the
  decision, so a crashed worker stops receiving work immediately rather than
  whenever the next sweep happens to run.
- **Stored state** — `WorkerHealthProber.expireStaleEvidence()` durably rewrites
  expired rows to `unknown/unknown/stale`, so the DURABLE state converges to
  ineligible and every consumer agrees, horizon or not.

Only the read boundary would leave a stale `healthy` sitting in the table, a
loaded gun for any future consumer. Only the stored state would leave a window
between expiry and the next sweep. Both are required.

`HEALTH_EVIDENCE_MAX_AGE_MS` is ONE exported constant, imported by the producer
and the consumer. Two independent horizons would create a window where the
router still trusts evidence the prober has abandoned.

### 4. Probe adapters are data, keyed by worker kind

`WorkerHealthProber` takes `adapters: Record<workerKind, WorkerHealthProbePort>`.
The module names no provider, no model and no account. A new worker kind becomes
probeable by registering an adapter, never by editing the prober.

A kind with **no** adapter is recorded `unsupported` and routes nothing: we
cannot verify it, so we do not pretend to. Treating "unprobeable" as "fine" is
precisely the fail-open hole 0031 exists to prevent.

A probe that **throws** is a NEGATIVE observation — `unhealthy/unavailable`,
outcome `failed` — never a missing one. This is the branch that stops a
provider or runtime failure from silently passing as health.

### 5. Inactive workers are neither probed nor expired

`deactivate()` preserves the last probe for audit (0032). Probing or expiring an
inactive worker would destroy that record for no routing benefit — an inactive
worker is already refused by the `status` gate.

## Consequences

- Health evidence now has a lifetime. `healthy` written once no longer routes
  work forever.
- A crash, a dead session or a stopped prober all fail closed by the same
  mechanism: nothing refreshed the evidence, so it expired.
- A process restart cannot restore HEALTHY. The stored claim survives the
  restart — it is durable — but it buys no eligibility once aged, and a sweep in
  the new process makes the stored state agree.
- Worker != Model != Provider != Account != CapacitySlot is preserved: the
  prober answers only for the WORKER. An adapter may consult the other axes
  internally; the registry stores no model, provider or account authority.
- **Still open (defect 15):** selection is `first-eligible-by-id`, so ten ready
  tasks and three healthy workers all route to one worker. That is M5.3, and any
  distribution policy must stay a pure function of durable state or this
  decision's restart guarantee stops holding.
- **Not built:** no adapter exists yet, so in the wired container every worker
  kind reads `unsupported` and routes nothing. That is the honest state until M6
  ships non-interactive external workers — and it fails closed.

## Evidence

- `src/core/workers/worker-eligibility.test.ts` — freshness gates,
  mutation-verified (removing the gate fails 5 tests).
- `src/server/services/worker-registry/worker-health-prober.test.ts` — 13
  proofs; three mutations verified (failed probe collapsing to `never`,
  unprobeable kind failing open, expiry disabled).
- `src/server/services/worker-registry/postgres-worker-health.integration.test.ts`
  — 11 proofs against real PostgreSQL, including legacy-row safety, durable
  invalidation, the DB CHECK refusing undatable evidence, and a cold process
  refusing aged evidence.
- Migration 0043 applied 3× via psql, exit 0 each time; ledger verified.
