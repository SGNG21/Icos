# 0063: the compute fleet is RECONCILED at boot — and reconciling is not enabling

## Status

Numbering: authored as 0063 on `feat/live-worker-bootstrap`. 0062 is already taken twice in
parallel lanes (`context-memory-client-knowledge`, `phone-live-proof`), so this number is
provisional and is reassigned at central integration, like 0055–0061 before it.

Accepted (foundation). No migration: the `workers` table (0042/0043/0044) is unchanged.
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
