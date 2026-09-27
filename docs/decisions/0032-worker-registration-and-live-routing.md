# 0032: Worker registration is not a health claim, and routing reads live durable state

## Status
Accepted

## Context

Decision 0031 (M4) delivered a durable worker registry, one canonical
fail-closed matcher and a capability router, all proven against real
PostgreSQL. It also recorded two limitations, deliberately accepted at the time:

1. **Nothing registered workers.** The `workers` table was durable and
   authoritative-when-populated, but no code path wrote to it. Every deployment
   therefore sat in `ROUTING_UNCONFIGURED`, and capability routing — though
   proven — was **inert**.
2. **The read model was a boot-time snapshot.** `CapabilityRouter` consumed the
   hydrated `WorkerRegistryPort`, so a worker registered or re-probed
   mid-process kept its stale eligibility until the next container build.

These interact badly: fixing (1) without (2) means a freshly registered worker
is invisible until restart, and — worse — a worker that has just gone unhealthy
**keeps receiving work** for the remainder of the process lifetime.

## Decision

### 1. The router reads the durable store, not a snapshot

`CapabilityRouter` now takes `WorkerRegistryStore` (async, durable truth)
instead of `WorkerRegistryPort` (sync, derived read model), and `route()` is
async. Its only consumer, `SupervisorService.routeReadyTask()`, was already
async, so the change cost one `await`.

This is not a second authority: the store has always *been* the authority, and
the sync registry a derived view. The router reading the authority directly is
strictly more correct and strictly less code.

`WorkerRegistryPort` and its hydrated read model remain for
`IndependentReviewerSelector`, `BoundedRepairController` and
`AdaptedAIResourceCatalog`, which are synchronous by contract and out of scope
here.

**Supersedes** decision 0031's "Known limitation, accepted for M4" on
snapshotting.

### 2. Registration is not a health claim

`WorkerRegistrationService` is the write side. `register()` **refuses to accept
health or availability from the caller**. A worker announcing itself is
evidence that it EXISTS, not evidence that it WORKS. A newly registered worker
is therefore:

```
status: "active", health: "unknown", availability: "unknown", runtimeSupport: "UNKNOWN"
```

and routes **nothing** until `probe()` records real evidence. Declaring a
runtime is likewise not the same as being able to run it, so `runtimeSupport`
defaults to `UNKNOWN` too.

Letting registration assert `healthy` would have reintroduced at the *write*
boundary exactly the fail-open hole 0031 closed at the *read* boundary. That is
the single most important property in this decision, and it is
mutation-verified.

**Re-registration resets probe evidence.** If the declaration changed, previous
probe results no longer describe the thing that is registered now.

`deactivate()` takes a worker out of rotation while preserving its declaration
and last probe for audit; `deregister()` forgets it entirely. `probe()` on an
unregistered worker returns `null` rather than inventing a registration — a
probe for a worker nobody registered is an upstream bug, not a registration.

## Consequences

**Positive**
- Capability routing is no longer inert: there is a supported way to populate
  the registry, and doing so takes effect immediately.
- A worker that goes unhealthy stops receiving work in-process, without a
  restart.
- The fail-closed property now holds across the full lifecycle — read *and*
  write.

**Negative / accepted**
- `route()` now performs a read per routing decision instead of using a cached
  pool. This is one indexed `SELECT` on a table sized by worker count (tens),
  on a path that already performs several writes per dispatch. Correctness over
  a micro-optimisation; if it ever matters, cache with explicit invalidation,
  never by reverting to a boot-time snapshot.
- **Nothing probes yet.** The service *records* probe evidence; no loop
  produces it. Until an M5.2 prober exists, an operator or a worker's own
  heartbeat must call `probe()`. A registry with no prober is a registry where
  every worker stays ineligible — which is the correct failure direction.
- **Selection is still first-eligible-by-id, so it does not distribute.** With
  ten ready tasks and three healthy workers, all ten route to the same worker.
  Exactly-once dispatch per task is already certified (CORE2), but load
  distribution is not implemented. See M5.2.

**Related**
- Extends decision 0031; supersedes its snapshot limitation.
- Any future distribution policy MUST remain a pure function of durable state,
  or `ROUTING_SURVIVES_RESTART` (0031) stops holding.
