# 0063: the compute fleet is RECONCILED at boot — and reconciling is not enabling

## Status

**NUMBERING IS PROVISIONAL AND MUST BE RECOMPUTED AT CENTRAL INTEGRATION.** Authored as 0063
on `feat/live-worker-bootstrap`. 0062 is already taken TWICE in parallel lanes
(`context-memory-client-knowledge` — client context resolution; `phone-live-proof` — ICOS
self-model), so 0063 is very likely contested too. Do not cite this number anywhere outside
this branch until integration assigns the final one, exactly as 0055–0061 were reassigned in
merge order (2026-09-30). **Migration number: none — this lane adds no migration**, so nothing
in `drizzle/` needs renumbering; the `workers` table (migrations 0042/0043/0044) is unchanged
and no column is added.

Accepted (foundation).
The startup path ships **disabled**; no live registry has been written under this decision.

## Context

Decision 0054 made the compute fleet come from PROVIDER TRUTH: OmniRoute answers which models
exist, `compute-fleet.ts` turns that answer into candidate declarations with deterministic ids,
and the canonical `WorkerRegistrationService` writes them fail-closed. Decisions 0036/0037 gave
those candidates a real probe and a durable, self-perpetuating `probe_workers` sweep that
`startProductionServices` ignites on every boot.

Both halves were certified. Neither was ever connected to a deployment.

The only code that ever WROTE a worker was `pnpm compute:register` and the self-build E2E
fixture. So the live runtime ignited a probe sweep over an empty registry, reported
`0 registered workers / 0 routable compute candidates`, and read as a routing bug — the
defect-16 shape one level up again: a chain whose first link nobody forged.

Making registration happen at boot is, however, not a small change. It is a write that executes
before any human is in the loop, on every boot and every replica, against whatever database the
process resolved. Three ways that goes wrong, all of which it did in draft:

1. **It destroys the evidence it depends on.** `register()` reset `health`, `availability` and
   the probe evidence unconditionally. A bootstrap on every boot would therefore wipe the whole
   fleet's evidence at every restart — silently unrouting a PROVEN fleet until the next sweep.
2. **It legislates instead of reporting.** A draft deactivated candidates the provider no longer
   listed, and re-registered a still-served but operator-DISABLED worker. That second one flipped
   a worker `inactive -> active` at boot: the effect of `ENABLE_WORKER`, which is risk HIGH and
   reauth-gated, with no command record, no audit entry and no actor.
3. **It mistakes an outage for an answer.** An unreachable provider throws, which is safe. A
   provider answering `200` with an empty listing does not — and read as "every model was
   withdrawn" it condemns the entire fleet on one bad response.

## Decision

**The boot-time path RECONCILES DECLARATIONS. It has no other authority.**

1. **Registration is declaration-only.** The bootstrap writes `capabilities`, `runtime`,
   `maxConcurrency`, `capacityPool`, `metadata` and the rest of the declaration. It writes
   `health`, `availability` and probe evidence NEVER, and `status` NEVER. Three claims stay
   separate and are never collapsed:
   `catalog presence != registered`, `registered != available`, `available != routable`.

2. **An unchanged declaration is a no-op.** `register()` returns the stored row untouched when
   the declaration is identical, so a restart writes nothing and probe evidence survives.
   Resetting evidence is the right answer to a CHANGE and the wrong answer to a repetition.
   Idempotency here is not an optimisation; it is the precondition for running at boot at all.

3. **Declaration comparison is canonical.** `metadata` keys are sorted before comparison:
   PostgreSQL `jsonb` does not preserve object key order, so a row read back from the durable
   store is key-reordered relative to the one that wrote it. Compared naively, every
   re-registration looks like a change against a real database while passing against an
   in-memory store — the guard would never fire where it matters.

4. **Status belongs to the control command bus (0055).** `DISABLE_WORKER`/`ENABLE_WORKER` are the
   only authority over `status`. A declared candidate whose row is not `active` is reported and
   LEFT ALONE; a candidate the provider no longer serves is reported and left alone. The
   reconciler does not need that authority: a withdrawn model's own probe fails within one sweep,
   so the canonical matcher stops routing to it on EVIDENCE rather than on a boot-time guess.

5. **An empty discovery is not a withdrawal.** A listing that yields no candidate is recorded
   `discovery: "EMPTY"` and produces no orphan report. A PARTIAL listing still reads `OK`, so
   `discovered.length > 0` is explicitly NOT a sufficient signal for any future write side.

6. **The dry run and the write are the same computation.** `planComputeBootstrap` is pure and
   `applyComputeBootstrap` replays exactly its plan. A dry run computed by different code than
   the write is a dry run that can lie. `pnpm compute:register` is the dry run; `--apply` writes.

7. **Opting in is a deployment decision.** `ICOS_COMPUTE_BOOTSTRAP` defaults to OFF. Registering
   writes rows, which is an operator's call, not something a deployment acquires by being
   upgraded. A provider outage at boot is reported and never aborts startup: the rest of the
   runtime must still come up, and the registry's previous contents still route. A WRITE failure
   is reported distinctly from a provider outage, because the two need opposite responses and
   `applyComputeBootstrap` is not transactional — a failed write can leave a partial registry.

## Amendment — a model is probed over HTTP, and "no probe" must be sayable

The reconciliation above registers candidates fail-closed and leaves health to the
`probe_workers` sweep. That sweep's transport turned out to be the larger risk, so it is
decided here rather than left to configuration.

**A MODEL IS NOT A RUNTIME.** `CommandWorkerProbe` answers "can this runtime execute
here" by spawning the runtime, which is correct for a runtime and wrong for a model behind
a gateway. Measured on the previously certified configuration, probing a model that way
gave every probe the server's whole environment — 9 secrets including the live
`DATABASE_URL`, `BETTER_AUTH_SECRET`, `ICOS_OWNER_PASSWORD`, `GITHUB_TOKEN` — plus the
agent CLI's enabled toolsets (terminal, file, code execution, browser, computer use, cron,
delegation) with approvals auto-bypassed, unattended, every 30 seconds. Nothing went
wrong, because the prompt is benign. A health check must not hold authority it cannot use.

So: **`OmniRouteHttpWorkerProbe` is the canonical probe for a model.** One minimal
completion through the gateway ICOS already talks to — no child process, no shell, no
filesystem, no tool surface, and no credential but the gateway's own. `pnpm compute:probe`
uses the same adapter; the operator path must not keep an authority the unattended sweep
gave up.

**SELECTION IS A THREE-STATE DECISION, and that is the load-bearing part.**
`WorkerHealthProber` keys adapters by RUNTIME, which cannot distinguish a model from a
real binary worker — every compute candidate declares `runtime: "binary"`. A worker-level
selector therefore runs first, deciding from canonical `metadata.model` (never a provider
name). It must be able to say three things:

- a probe — use it;
- "not mine" — the runtime map answers;
- **"mine, and nothing may probe it"** — recorded `unsupported`, routes nothing.

The first implementation had only the first two, and that was a FAIL-OPEN hole, not a
cosmetic gap: with the gateway credential absent, every model worker fell through to
`adapters["binary"]`, the agent CLI ran, and the sweep recorded `ok` — a model certified
healthy by starting a runtime that knows nothing about it. Proven by test before fixing.
Health that comes from probing the wrong thing is worse than no health at all, so a
missing credential now LOSES health rather than borrowing authority.

**NO FALLBACK ON FAILURE, EVER.** Selection happens before any request. A failed HTTP
probe is recorded failed; nothing retries that worker through another adapter, because a
gateway hiccup must not silently restore the authority this removes.

**WHAT A PROBE COSTS**, since this decision changes what it spends: one sweep is 435
prompt + 176 completion tokens across 13 answering candidates (largest single completion
observed: 85, against a 512 ceiling that is headroom, not spend). At the 30s grid that is
~1.25M prompt and ~0.51M completion tokens per day, on the same provider accounts as real
work. An operator accepts that or changes the interval; it is recorded so the choice is
explicit.

**KNOWN BLIND SPOT.** The gateway reports the resolved MODEL and never the route it took,
so `cc/claude-sonnet-5` and `claude/claude-sonnet-5` both answer as `claude-sonnet-5`.
Measured across the real fleet, 9 of 15 workers sit in such a collision group. Those are
distinct workers with distinct capacity pools, so a silent route substitution is
undetectable here and one upstream account can be counted as two ceilings. Closing it
needs the gateway to echo its route; a cleverer comparison cannot.

## Consequences

- A deployment can expose its real compute capacity without an operator remembering a command,
  and a restart no longer threatens a proven fleet.
- Registration alone is still not capacity. Without `ICOS_WORKER_PROBE_COMMANDS` a `binary`
  candidate has no probe adapter, is recorded `unsupported`, and routes nothing; without
  `ICOS_WORKER_EXEC_COMMANDS` nothing executes. Both stay deployment configuration (0036) and
  both are now documented in `.env.example`.
- **Tenancy, stated so it can be revisited.** `workers` has no tenant column; a worker is a
  runtime execution unit, not tenant data, and isolation is per DATABASE. This is the
  repository's existing model, not something this decision introduces, and no tenant operation
  occurs without tenant context. The day a worker becomes tenant-scoped — a tenant-dedicated
  provider account, a per-tenant capacity pool — this boot-time write becomes a cross-tenant
  write with no key, and this decision must be revisited first. A unit canary
  (`TENANT_ENVIRONMENT_ISOLATION`) fails if a tenant-shaped field appears on the entry.
- `applyComputeBootstrap` is not atomic, and `WorkerRegistryStore` exposes no transaction. A
  partial reconciliation is reported rather than hidden. Making it atomic needs a new port
  method and is deliberately not done here.

## Evidence

17 unit proofs of the planner and reconciliation, 8 unit proofs of the startup gate, 3 added to
the registration service, and 8 PostgreSQL proofs on an isolated test database in which every
"restart" is a fresh connection handle — the jsonb round-trip in point 3 is provable only there.
81 related registry/routing/dispatch integration tests pass unchanged. One independent read-only
security review; findings 1 and 2 above were found by it and by self-review during the lane.
