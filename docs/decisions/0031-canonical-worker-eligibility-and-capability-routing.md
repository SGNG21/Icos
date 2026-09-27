# 0031: One canonical worker eligibility authority, and capability routing on durable state

## Status
Accepted

## Context

CORE3 M2 made `tasks.required_capabilities` durable (migration 0041) and M2's
post-phase audit recorded plainly that the envelope was persisted but **not
honored at runtime**: "requiredCapabilities does not route". M4's job is to
close that gap.

Tracing the read/write path found two independent problems.

### Problem 1 — three competing eligibility matchers

Three places answered the question "may this worker take work", with
**different semantics**:

| Implementation | health gate | availability gate |
|---|---|---|
| `IndependentReviewerSelector.select()` | `=== "healthy"` | `=== "available"` |
| `BoundedRepairController.getEligibleWorkers()` | `=== "healthy"` | `=== "available"` |
| `AdaptedAIResourceCatalog.isRunnable()` | `!== "unhealthy"` | `!== "unavailable"` |

The first two are a verbatim copy of each other. The third is a **looser**
variant that failed **OPEN** on `"unknown"` — which is precisely the value every
worker fixture carries, and precisely the value the registry defaults to. An
unprobed worker was therefore *runnable* according to one authority and
*ineligible* according to the other two.

This was not hypothetical: `worker-registry.test.ts` asserted that three
fixtures whose own comments read `health: "unknown", // Fail-closed: we don't
probe health` were runnable. The test encoded the defect.

### Problem 2 — the worker registry was not durable

Both composition roots in `container.ts` built the registry as
`new InMemoryWorkerRegistry([])`: empty at boot, invisible outside the process,
discarded on restart. `MissionTask.workerKind` was passed straight through to
the dispatcher as the planner wrote it. There was no registry to match
capabilities against, so routing could not exist, let alone survive a restart.

### What a Worker is, and is not

The vocabulary was never pinned down, and conflating these is how a routing
layer silently becomes a provider hardwire:

- **Worker** — an execution unit that can be handed a task. What this decision
  is about.
- **Model** — a specific model identity (e.g. a model id offered by a provider).
- **Provider** — the service offering models.
- **Account** — the billing/credential identity used to reach a provider.
- **Capacity slot** — a unit of concurrency against an account or provider.

`AIResourceCatalog` already owns Model and Provider candidates. Account and
capacity slot have no representation yet and deliberately gain none here.

## Decision

### 1. One eligibility authority

`src/core/workers/worker-eligibility.ts` is THE matcher. It is pure — no I/O,
no clock, no randomness — so the same inputs always produce the same route.

Every gate is an **ALLOW-list of one exact value**:

| Gate | Only accepted value |
|---|---|
| `status` | `active` |
| `runtimeSupport` | `SUPPORTED_RUNTIME` |
| `health` | `healthy` |
| `availability` | `available` |
| `requiredCapabilities` | ALL present, matched exactly |

`unknown` is never a pass. A worker we have not probed is a worker we do not
route to.

`IndependentReviewerSelector`, `BoundedRepairController` and
`AdaptedAIResourceCatalog` all delegate to it. The first two keep their exact
previous behaviour; the third is **deliberately tightened** and now fails closed
on `unknown`. Reviewer independence is expressed as nothing more than
`excludeWorkerIds: [producerWorkerId]` on top of the shared gates.

Selection order is by worker id and nothing else. No scoring, no load
balancing, no recency: anything derived from a clock or a counter would make
identical inputs produce different routes across a restart.

### 2. The worker registry is durable

Migration 0042 adds the `workers` table. Its defaults are the fail-closed state
(`status='inactive'`, `health='unknown'`, `availability='unknown'`,
`runtime_support='UNKNOWN'`), and CHECK constraints re-assert every closed value
set at the database boundary. A row inserted with only its mandatory columns
routes nothing.

`WorkerRegistryStore` (async, durable) is kept **separate** from
`WorkerRegistryPort` (sync, the read model every matcher already consumes). The
Postgres container hydrates the read model from the store at build time. Making
`WorkerRegistryPort` async instead would have rippled through three consumers
for no routing benefit.

**Known limitation, accepted for M4:** the read model is a *boot-time snapshot*.
A worker registered or re-probed mid-process is not visible to routing until the
next hydration. This is sufficient to prove restart survival and is what keeps
the blast radius small; live refresh belongs to M5/M6.

### 3. Capability routing

`CapabilityRouter` reads `tasks.required_capabilities` from the **durable
canonical Task** via `MissionTask.taskId` — not from the MissionTask, and not
from planner output held in memory. The value that survived the restart is the
value that routes.

Three decisions:

- `ROUTED` — dispatch to the selected worker's kind.
- `NO_ELIGIBLE_WORKER` — **fail closed**: the MissionTask is set `blocked` and
  nothing is dispatched. A blocked task is recoverable; work done by an
  under-qualified worker is not.
- `ROUTING_UNCONFIGURED` — the registry is **empty**. Dispatch behaves exactly
  as it did before M4.

`ROUTING_UNCONFIGURED` is the one permissive path and is stated plainly rather
than hidden. It is not a fail-open matcher; it is the honest "no routing table
exists yet" state, and it is what makes M4 reversible while no deployment has
registered workers. **The moment one worker is registered the registry becomes
authoritative and routing fails closed.**

Every refusal carries a per-candidate verdict (which gates failed, which
capabilities were missing). A routing decision that cannot explain itself is not
evidence.

### 4. No provider hardwire

Nothing in the matcher, the router, the `workers` table or the migration names a
model, provider or account. A novel worker kind with a novel capability routes
correctly with no code change — proven by test. Provider/model/account hints may
travel in `workers.metadata` but are NON-AUTHORITATIVE and are never read by
routing.

## Consequences

**Positive**
- `tasks.required_capabilities` finally controls execution.
- One answer to "may this worker take work", and it fails closed.
- Routing is reproducible across a process restart from durable rows.
- A fail-open path that accepted unprobed workers is gone.

**Negative / accepted**
- `AdaptedAIResourceCatalog` is stricter than before. Any deployment relying on
  unprobed workers being "runnable" will now select nothing until health and
  availability are actually probed. This is intended; the previous behaviour
  was the defect.
- Routing sees a boot-time registry snapshot (see limitation above).
- `dispatch_attempts` records the routed `worker_kind` but not the selected
  worker **id**. Sufficient for M4; M5 multi-worker orchestration will want the
  id, and adding the column is additive.

**Superseded/related**
- Extends decision 0030's canonical-authority principle to worker eligibility.
- Does not alter readiness: routing runs *after* `computeReadyTasks`, never
  instead of it.
