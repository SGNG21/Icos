# Dispatch bridge — P0 / P1 / P2 report, 2026-10-05

Owner decision of 2026-10-05: fix the Workforce ↔ CORE3 dispatch seam first (P0), prove the
critical runtime E2E with the brain affecting dispatch (P1), then land a narrow policy-based
auto-launch (P2). Lane `feat/fable5-product-layer`, rebased on `integration/icos-central`
@ `a8325fb`. Decisions 0069 and 0070.

## P0 — the bridge (commits `91812db`, `7e487fd`, `869d75c`, `8f2c118` before rebase)

Root cause: Chief delegated at ignition, before the planner had produced a task, so
assignments named stages (`<mission>:research`) while the dispatcher matches CORE3 task ids
(`task-…`). Fix: `boundTaskCompute` wraps the existing compute seam and, at the first routing
of any task of a mission, asks Chief to delegate PER CORE3 TASK; the assignment row carries the
task id; the attempt records `routing_decision.workforce`; the review decision records
`providerMetadata.routing.workforce`. Details in decision 0070.

Proof on PostgreSQL: `dispatch-bridge.integration.test.ts` (3 tests), plus the unit proofs in
`chief-delegation.test.ts` (20), `mission-binding.test.ts` (7), `supervisor-workforce-compute.test.ts`,
`reviewer-brain-attribution.test.ts`, `omniroute-reviewer-extract.test.ts`.

## P1 — live-shaped proof on an isolated server

Not the live runtime (which serves central's code): a proof server from this worktree on
its own database `icos_bridge_proof`, its own Temporal task queue, port 3100, with the live
OmniRoute, executors and models (recipe in memory). Owner, twelve brains (`workforce:bootstrap`,
all `created`, all tool grants `granted`) and the fleet (`compute:register --apply`, 15 workers,
13 healthy) were created through the canonical scripts. Six goals were run through
`scripts/bridge-live-e2e.ts` (goal intake → Durable Scheduler → runtime → read-only evidence).

| Run | Mission    | Brain on task                   | Attempt evidence                                              | Review                                                             | Settlement           | What it taught                                                                                                     |
| --- | ---------- | ------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | `a54f2e24` | brain-planner (real task id)    | `agentIds=[brain-planner]`, raised                            | 5 × INVALID_OUTPUT (`cc` reviewer compute)                         | none                 | `cc/*` workers cannot review                                                                                       |
| 2   | `3255e7d5` | brain-planner ×2                | yes                                                           | 5 × INVALID_OUTPUT (haiku, strict parse)                           | none                 | reviewer parser rejects fenced JSON → fixed `7e487fd`                                                              |
| 3   | `fdddf67e` | partial: Planner at capacity    | yes on bound tasks                                            | REQUEST_CHANGES ×2, REPLAN — decision row carries `brain-reviewer` | looping              | objective named `src/core/cognitive`; a read-only task has no bound workspace, the worker truthfully finds nothing |
| 4   | `5ae4ea70` | none: Planner at capacity       | no                                                            | REQUEST_CHANGES                                                    | **failed** (settled) | per-task binding burns a slot per task; superseded tasks held theirs → fixed `869d75c`                             |
| 5   | `fc94cbf9` | none: slots still held by run 3 | no                                                            | **APPROVE**, reviewer assignment released at settlement            | **succeeded**        | execution → review → settlement → release works end to end                                                         |
| 6   | `c4f9d427` | brain-planner (real task id)    | attempt 1 `agentIds=[brain-planner]`, `complexityRaised=true` | pending at the time of writing                                     | see final report     | the full chain on one mission                                                                                      |

Verdict for P1: **green with one stated weakness.** The brain governed the dispatch that ran
for eleven minutes (attempt 1, routed `high` instead of `low`); the deterministic reviewer
then judged that attempt RETRY, and the retry and the correction were prepared by quality
control, which at that commit did not consult the workforce seam — they ran with the task's
own bar and no brain evidence. That gap is closed by the commit that followed
(`fix(quality-control): a retry or correction keeps the brain that governed the task`),
proven in `quality-control-retry-routing.test.ts`, and not yet re-run live. Honest limits: the ledger never carries `brain_id` for a
goal-keyed call (settlement re-derives attribution from the reservation key, 0066 C2); `synthesize`
after `cancel` still refuses `CHILDREN_NOT_SETTLED`, so `chiefRelease` cancels but logs a refusal.

## P2 — narrow policy auto-launch (committed after the P1 verdict)

`launchPolicy`: `AUTO_ALLOWED` → `approved` signed `policy:mission-autonomy`; `POLICY_GATED` /
`APPROVAL_REQUIRED` → hold for a human; a human `reject` is the denial; actions always hold. The
runtime launches only a policy-signed ref of the same conversation and the same turn that is
still `approved` (`beginLaunch` moves it exactly once); budget, admission, bounds and allowlist
are the unchanged launch path. A policy-approved goal runs its tasks under `if_risky` (a
`sensitive` task still asks a human); a human approval keeps `always`. Proof:
`cognitive-mission-launch.integration.test.ts` L5 (launched without a decision; a held proposal
still waits), `cognition.test.ts`.

## Pre-existing red, verified on central's own code with a separate test database

- `core3-dag-settlement.integration.test.ts`: 14/15 failed on central `a8325fb` and on this
  branch alike (`CLEANUP_REFUSED: statut blocked non terminal` in the workspace manager).
- `postgres-compute-routing.integration.test.ts`: 1/6 failed on both (`9/21 fallback retry`).

## Verification on the final HEAD (rebased on central `c0129ae`)

- Typecheck: clean. Lint on every file changed since central: no error.
- Unit: see the final report line (`FULL_UNIT`); the suite with P2 in the tree passed
  284 files / 3772 tests before the last rebase.
- Integration: 91 files, 42 failures in 8 files on this branch under load; the six files not
  already known red were A/B-run on central's own code with a separate test database (see
  the final report for the per-file classification).

## What the owner still has to do

1. Apply `maxConcurrentAssignments: 5` to the live brains through `WorkforceService.changePolicy`
   (the seed only affects new seeds); or accept per-task slots at 3.
2. Decide whether skills should declare worker capabilities (today `workerCapabilities: []`
   everywhere, so a brain's material effect is the complexity floor, the hold and the
   evidence).
3. `synthesize` after `cancel` still refuses `CHILDREN_NOT_SETTLED`; `chiefRelease` therefore
   cancels and logs a refusal. A workforce-lifecycle fix, not made here.
4. Land this branch after central's own E2E; conflicts can only be textual
   (`supervisor-service.ts`, `container.ts`, `production-services.ts`, `quality-control-service.ts`).
