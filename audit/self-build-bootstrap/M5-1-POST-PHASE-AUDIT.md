# M5.1 Post-Phase Audit — worker registration and live routing

Date: 2026-09-27
Entry HEAD: 79c6c2e (M4 capability routing)
Scope: M5 increment 1 — decision 0032. **Not all of M5**; see "What M5 still owes".

## Why this increment, and why it is first

M4's own audit named the problem: capability routing was proven and **inert**.
`SHOULD_NEXT 13` recorded that nothing writes to the `workers` table, so every
deployment sat in `ROUTING_UNCONFIGURED` and M4 changed nothing in production.
`SHOULD_NEXT 11` recorded that the read model was a boot-time snapshot.

These could not be fixed separately. Adding registration without live reads
would mean a freshly registered worker is invisible until restart — and, worse,
a worker that has just gone unhealthy keeps receiving work for the rest of the
process lifetime.

## What changed

| Change | Before | After |
|---|---|---|
| `CapabilityRouter` source | `WorkerRegistryPort` (boot-time snapshot) | `WorkerRegistryStore` (durable, read per decision) |
| `route()` | sync | async (its only consumer was already async) |
| Registration | none existed | `WorkerRegistrationService`: register / probe / deactivate / deregister |
| New worker's initial state | n/a | `health: unknown`, `availability: unknown`, `runtimeSupport: UNKNOWN` — routes nothing |

The sync `WorkerRegistryPort` read model is unchanged and still serves
`IndependentReviewerSelector`, `BoundedRepairController` and
`AdaptedAIResourceCatalog`, which are synchronous by contract.

## The invariant this increment exists to protect

**REGISTRATION IS NOT A HEALTH CLAIM.**

A worker announcing itself is evidence that it EXISTS, not evidence that it
WORKS. `register()` structurally cannot accept a health or availability claim
from its caller. Had it done so, the fail-open hole decision 0031 closed at the
*read* boundary would have reappeared at the *write* boundary, and every proof
in M4 would have been bypassable by any caller willing to say `health:
"healthy"`.

## Proofs

| Proof | Status | Evidence |
|---|---|---|
| REGISTRATION_IS_NOT_A_HEALTH_CLAIM | **PROVEN** | unit + postgres: registered-but-unprobed yields `NO_ELIGIBLE_WORKER` with reasons `[HEALTH_NOT_HEALTHY, NOT_AVAILABLE]` |
| CALLER_CANNOT_SMUGGLE_HEALTH | **PROVEN** | unit: extra `health`/`availability` keys on the input are ignored; stored state stays unknown |
| RUNTIME_SUPPORT_DEFAULTS_CLOSED | **PROVEN** | unit: declaring `runtime: "node"` leaves `runtimeSupport: "UNKNOWN"` |
| PROBE_MAKES_ROUTABLE | **PROVEN** | unit + postgres |
| DEGRADED_OR_UNAVAILABLE_PROBE_REMOVES | **PROVEN** | unit: both `degraded` and `unavailable` take the worker back out |
| RE_REGISTRATION_RESETS_PROBE | **PROVEN** | unit: a changed declaration invalidates old evidence |
| PROBE_DOES_NOT_INVENT_WORKERS | **PROVEN** | unit: `probe()` on an unknown id returns null, store stays empty |
| DEACTIVATE_PRESERVES_AUDIT | **PROVEN** | unit + postgres: stops routing, keeps declaration and last probe |
| DEREGISTER_RETURNS_TO_UNCONFIGURED | **PROVEN** | unit + postgres |
| MALFORMED_REGISTRATION_REJECTED | **PROVEN** | unit: non-UUID id rejected, nothing stored |
| LIVE_REGISTRATION_VISIBLE | **PROVEN** | postgres: registered mid-process, routable with no restart |
| LIVE_UNHEALTHY_REROUTES | **PROVEN** | postgres: same router instance reroutes immediately |
| LIVE_LAST_WORKER_FAILS_CLOSED | **PROVEN** | postgres: in-process transition to `NO_ELIGIBLE_WORKER` |
| RESTART_STILL_AGREES | **PROVEN** | postgres: a different handle reaches the same result |
| SUPERVISOR_END_TO_END | **PROVEN** | postgres: registered-unprobed → task `blocked`, dispatcher not called; after probe → dispatched to `hermes` |
| DETERMINISM_UNDISTURBED | **PROVEN** | unit: two registered workers, reverse order, stable winner |

### Mutation evidence

| Mutant | Killed by |
|---|---|
| registration accepts a caller-supplied health claim | 1 unit test |
| `runtimeSupport` defaults to `SUPPORTED_RUNTIME` | 1 unit test |
| re-registration preserves stale probe evidence | 3 unit tests |
| `probe()` invents an unregistered worker | 1 unit test |
| router caches the pool (regression to the M4 snapshot) | 3 integration tests |

No surviving mutant.

## Findings

### MUST_NOW
**NONE.**

### What M5 still owes (M5.2)

**A1 — NOTHING PROBES.** The service *records* probe evidence; no loop
produces it. Until a prober or worker heartbeat exists, an operator must call
`probe()` by hand, and a registry with no prober leaves every worker
ineligible. That is the correct failure direction, but it is not orchestration.
This is now the single thing standing between M5.1 and a live multi-worker
deployment.

**A2 — SELECTION DOES NOT DISTRIBUTE.** `selectWorker` returns
first-eligible-by-id. With ten ready tasks and three healthy workers, all ten
route to the same worker. Exactly-once dispatch *per task* under concurrent
supervisors is already certified (CORE2:
`postgres-supervisor-dispatch-race`, `postgres-concurrent-dispatch-recovery`,
`postgres-multiworker-concurrent`), so the hard concurrency work is done — but
load distribution across workers is genuinely not implemented. This is the core
of M5.2. **Any distribution policy MUST remain a pure function of durable
state**, or `ROUTING_SURVIVES_RESTART` (decision 0031) stops holding; a
round-robin counter held in memory would silently break it.

**A3 — `dispatch_attempts` still has no `worker_id`** (carried, M4 S3).
Multi-worker attribution and a real producer identity for reviewer independence
both need it. Additive column + additive migration.

**A4 — `AIResourceCatalog` remains a second hardcoded source of worker
capability truth** (carried, M4 S1), off the dispatch path
(`AISelectionEngine` has zero consumers). Belongs to the Resource Manager.

**A5 — one read per routing decision.** Accepted deliberately (decision 0032
Consequences). If it ever matters, cache with explicit invalidation — never by
reverting to a boot-time snapshot.

### MUST_BEFORE_CERTIFICATION
**D1 (carried) — `auth-bootstrap-cli.integration.test.ts`: 3 tests fail by 60s
timeout.** Pre-existing (CERT-4). Confirmed untouched by M4 and M5.1: neither
commit modifies any file under `src/server/auth/`, any CLI, or any bootstrap
path. NOT skipped, and must not be re-skipped.

## Gates

| Gate | Result |
|---|---|
| `pnpm run typecheck` | PASS |
| `pnpm run test` (unit) | PASS — 134 files, **1630** tests (M4: 1619) |
| `pnpm run test:integration` | **327 passed / 3 failed / 0 skipped** (M4: 321/3/0) — the 3 are D1 |
| `pnpm run lint` | 0 errors, 289 warnings (EQUAL to the M3/M4 baseline) |
| `git diff --check` | PASS |
| `pnpm run format:check` | still FAIL on 243 files — PRE-EXISTING, untouched |

No new migration: M5.1 is code only, on the 0042 schema.

## Reproduce

```
pnpm run test:db:setup
pnpm run typecheck && pnpm run test
pnpm run test:integration
npx vitest run src/server/services/worker-registry src/server/routing src/core/workers
npx vitest run --config vitest.integration.config.ts src/server/routing
```
