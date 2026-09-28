# 0046: Reviewer compute is pluggable, and the fleet view is live

## Status
Accepted

## Context

With defect 28 closed, the self-development chain was run end to end against real compute for
the first time. Each run got further and stopped on a different defect. None was findable by
reading: every one of them was a component that was correct in isolation and unreachable in
composition.

## DEFECT 31 — the fleet view was a boot-time snapshot

`WorkerRegistryPort` is synchronous, so the container satisfied it with

```ts
const workerRegistry = new InMemoryWorkerRegistry(await workerRegistryStore.list());
```

one snapshot, taken once, at boot. Every writer — registration, health probes, deactivation,
stale-evidence expiry — writes to the STORE, so the snapshot was accurate for exactly as long
as the fleet did not change. In a real deployment workers register themselves AFTER the
runtime boots.

The consequence was not a stale read. `ReviewerIndependenceChecker` resolves both identities
through this port, so it found a fleet frozen at boot and answered `NO_INDEPENDENT_REVIEWER`
for every worker that had registered since — for ever, fail-closed, with a message that
blamed identity axes. Self-development could never be reviewed in any deployment whose
workers come up after the runtime does.

`MirroringWorkerRegistryStore` keeps the synchronous view in step by mirroring every durable
write back into it. The mirror sits at the STORE, not in the registration service, because
registration is not the only writer: probes and expiry write here too, and a mirror following
only registration would drift on exactly the evidence routing depends on. The mirror is
updated only after the durable write succeeds; the store remains the single source of truth.

## DEFECT 32 — a fail-closed reviewer with only one possible backend

The PostgreSQL container REQUIRES an LLM reviewer and refuses to boot without one. That is
correct. But the only backend was HTTP (OmniRoute), so a deployment without that endpoint
could never review anything, and therefore could never approve anything. That is not safety,
it is a dead end — and it is the reason the first real self-development runs died on
`QUALITY_REVIEWER_PROVIDER_FAILURE` with nothing to point at but a dead port.

`CommandReviewer` adds a local-process reviewer, selected by `ICOS_REVIEWER_COMMAND`, exactly
as M12 added a local-process planner. The review AUTHORITY is untouched: the policy prompt,
the decision vocabulary, the output schema and the error taxonomy are the canonical ones,
IMPORTED from the existing reviewer rather than restated, so the two backends cannot drift on
what a review means. A provider owns transport and nothing else.

Two backends configured at once REFUSES TO BOOT, keyed on `ICOS_REVIEWER_MODEL` rather than
on the OmniRoute credentials, which other components need. Which model reviewed a change is
audit-relevant; it must never be decided by whichever environment variable happened to win.

`hermes-planner-provider.ts` was renamed `command-planner-provider.ts` in the same change: its
own test asserts that no product name is committed, and the file name was the one place that
still did.

## Planner retry

Measured against a live agent, roughly half of otherwise identical runs answered the
`.strict()` plan schema with prose around the JSON or a field the schema does not name. The
canonical planner now puts the SAME prompt to the provider up to three times on a shape
failure only. It loosens no contract and invents no plan. A timeout, an abort, a provider
failure or a schema-valid plan that is not a valid DAG are not retried: in each of those the
model was heard correctly, and asking again cannot help.

The prompt also now tells the planner NOT to set `workerKind` or `capability`. Routing is the
deployment's decision, and a capability key the fleet has never heard of makes the task
unroutable and silently blocks it — which is how three runs ended.

## Consequences

- A deployment can now be certified with real compute and no HTTP model endpoint.
- The fleet view follows the durable store, so reviewer selection, independence and the AI
  resource catalog all stop depending on boot order.
- `reviewerSystemPrompt()`, `reviewerUserPrompt()`, `reviewerOutputSchema` and `reviewerError`
  are now exported from `omniroute-reviewer.ts`. That file is no longer only OmniRoute's; if a
  third backend appears, the canonical half should move to a file of its own.

## Evidence

Unit: 15 proofs across `command-reviewer.test.ts` and `command-planner-provider.test.ts`
(canonical policy handed over verbatim, fence/narration normalised, fail-closed on schema,
timeout, empty output and non-zero exit, stderr NEVER surfaced, malformed configuration
refused, no product name committed); 4 proofs of the mirroring store; 4 of the planner retry.
Integration: the composition test registers a worker AFTER the container is built and asserts
the fleet view sees it, its probe and its removal.

Mutations verified (each restored afterwards):

| Mutation | Result |
|---|---|
| Container takes the boot snapshot and drops the mirror | composition proof fails |
| `MirroringWorkerRegistryStore.upsert` stops mirroring | 3 unit proofs fail |
| `CommandReviewer` accepts any verdict shape | 1 unit proof fails |
| `MAX_ATTEMPTS = 1` (no planner retry) | 2 unit proofs fail |

Gates: typecheck PASS, build PASS, `git diff --check` PASS, lint 0 errors / 289 warnings
(baseline), unit 1836 PASS, integration 455 PASS / 3 skipped (opt-in E2Es).
