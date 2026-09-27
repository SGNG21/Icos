# 0036: A real probe, keyed by runtime — and why an unverifiable worker must fail loudly

## Status
Accepted

## Context

Decision 0033 built the probe LOOP and proved it. Decision 0035 proved
multi-worker orchestration on top. Both were proven against **fake adapters**:
the composition root passed `adapters: {}`, so in any real deployment every
worker read `unsupported` and the fleet routed nothing.

That state was fail-closed and honest, and it was recorded as defect 16. It was
also **not orchestration**: nothing real was ever probed, so "health" had never
survived contact with a process that can be missing, slow, chatty, or waiting for
someone to type something.

M5 certification was therefore withdrawn until this decision landed.

## Decision

### 1. Adapters are keyed by RUNTIME, not by worker kind

0033 keyed probe adapters by `workerKind`. That was wrong, and it is corrected
here before anything depended on it.

The runtime is what determines **how** you check something: you probe a binary by
running it, a container runtime by asking its daemon. A worker KIND says what the
worker is FOR, which tells you nothing about how to verify it.

The practical consequence: a brand-new worker kind is probeable with **no new
adapter and no code change**, provided its runtime is already covered. Keying by
kind would have required one registration per kind — which is exactly how a
routing layer slowly accumulates a hardcoded list of provider names.

This keeps the axes separate and now makes RUNTIME explicit alongside them:

> Worker != **Runtime** != Model != Provider != Account != CapacitySlot

The probe answers "can this worker's RUNTIME execute here, right now". It does
not choose a model, authenticate a provider, check an account quota or reserve a
capacity slot. Keeping it this narrow is what stops "health" from silently
becoming "everything is configured correctly".

### 2. The probe is a real, non-interactive subprocess

`CommandWorkerProbe` runs the command and reports what happened:

- **stdin is `ignore`.** A process that tries to prompt gets EOF immediately
  instead of blocking. This is not a detail: a probe that waits for a human holds
  a capacity slot and never yields a verdict, and a never-answered probe is
  indistinguishable from a healthy one.
- **There is always a timeout, and it kills the process.** A slow probe is a
  failed probe; we do not wait to find out.
- **No shell.** Command and arguments are an argv array, so nothing in a worker's
  declaration can be interpolated into a shell.
- **stderr is captured but bounded** (4 KiB), so a chatty runtime cannot grow it
  without limit, and the first line travels in the failure message — a failure
  you cannot read is a failure you cannot fix.

`runCommand` never rejects: a spawn failure (missing executable, EACCES) is
returned as a non-zero result. One shape to interpret. A helper that both rejects
and resolves has two failure paths and one of them always ends up unhandled.

### 3. No executable, path or provider name is committed

The command comes from an injected resolver built from
`ICOS_WORKER_PROBE_COMMANDS` — JSON, per runtime. The repository names no
binary and no provider; a deployment decides what "running" means for its
runtimes.

The single built-in answer is the `node` runtime, via `process.execPath`. That is
not a hardwire: a worker declaring the `node` runtime runs on the runtime this
server is already executing in, so the check needs no configured path and names
no product. Configuration always overrides it.

**Malformed configuration refuses to boot.** Falling back to "no commands" would
mean nothing is ever probed, every worker stays ineligible, and the fleet looks
mysteriously idle — technically fail-closed, practically undiagnosable. Refusing
to start is louder and kinder.

### 4. "Cannot verify" and "verified as broken" are different facts

Both refuse work; they are recorded differently on purpose, because they need
different fixes.

| Situation | Outcome | Meaning |
|---|---|---|
| No adapter registered for the runtime | `unsupported` | We have no way to check this. |
| Adapter registered, resolver has no command | `failed` | A CONFIGURATION DEFECT. |
| Command ran, non-zero exit | `failed` | The runtime refused. |
| Command timed out | `failed` | The runtime did not answer. |
| Command exited 0 (or a configured code) | `ok` | Verified. |

The second row is the subtle one. An adapter that is wired but cannot resolve a
command **throws**, so the prober records a dated `failed` rather than leaving the
row looking never-probed. "We forgot to configure this" must be visible as a
fault, not disguised as an innocent initial state.

A runtime that reports readiness with a non-zero code can declare
`healthyExitCodes` — configuration, not a guess.

### 5. The composition root is part of the contract

`buildWorkerProbeAdapters()` registers ONE adapter instance for exactly the
probeable runtimes: the resolver, not the adapter, decides what a runtime's check
is. Unprobeable runtimes are **left out of the map** rather than mapped to
something permissive, which is what preserves the `unsupported` / `failed`
distinction above.

The wiring is itself under test. An adapter nobody wired proves nothing: the
mutation "container passes `{}`" — precisely the pre-M6 state — must fail a test,
and it does.

## Consequences

- Health is now produced by running real processes. UNKNOWN → HEALTHY requires a
  process to have actually exited successfully.
- Everything 0033 and 0034 guarantee still holds over real verdicts: evidence
  expires, a restart does not restore health, routing refuses
  unknown/unhealthy/unavailable, and distribution spreads real tasks across
  really-probed workers.
- A new worker kind costs nothing. A new RUNTIME costs one configuration entry.
- **Still open:** nothing calls `probeAll()` / `expireStaleEvidence()` on a timer.
  A durable scheduler already exists (ADR-0025, `scheduled_jobs`); it should be
  reused rather than a `setInterval`, which would not survive a restart and would
  run once per process instead of once per fleet. Until then, probing is
  operator- or caller-driven.
- **Still open (defect 17):** a worker that dies mid-execution is detected but its
  task is never reassigned, and its capacity slot stays consumed. M7.
- The Hermes, Nemotron-backed and Codex adapters are configuration on top of this
  boundary, not new abstractions. They are M6's remaining work.

## Evidence

- `src/server/workers/probes/command-worker-probe.test.ts` — 16 proofs running
  REAL child processes: a genuine success, a missing executable, a non-zero exit
  with its reason carried, a configured non-zero healthy code, a hanging process
  killed by the timeout, a process reading stdin getting EOF instead of blocking,
  an unresolved runtime failing loudly, configuration parsing and override, and
  the CONTAINER WIRING itself.
- `src/server/workers/probes/postgres-real-worker-probe.integration.test.ts` — 14
  proofs on real PostgreSQL: UNKNOWN → HEALTHY only after a real probe, real
  failure → unhealthy/unavailable, unconfigured runtime `unsupported`, wired-but-
  unresolvable runtime `failed`, durable evidence surviving a restart, a cold
  process refusing aged evidence, expiry, per-reason routing refusals, two
  really-probed workers taking one task each, durable load following the ledger,
  an unprobed peer taking nothing, dependency unlocking exactly once under
  concurrent supervisors, REAL EXECUTION writing real files on two workers, and
  no oversubscription race.
- Mutations verified: unresolved runtime passing as healthy (1 fails), timeout
  ignored (1 fails), any exit code healthy (3 fail), container passing no adapters
  (1 fails), container mapping every runtime (1 fails).
