# 0045: The pending-review gate is driven by the production recovery sweep, from durable state

## Status
Accepted — closes DEFECT 28 (completes decision 0044).

## Context

Decision 0044 split execution and gating into two moments: a workspace whose execution finishes
before any independent review exists is parked `ready_for_integration`, and
`WorkspaceExecutionCoordinator.gatePendingReview()` is "the same gate, later". An independent
recertification of 0044 found the loop was not closed in the running system:

1. **No production caller.** `gatePendingReview()` was called only by tests. In production an APPROVE
   persisted after execution was never gated, applied or reaped — the work waited for ever. Every
   integrating certification proof, including "startProductionServices BOOTS the governed path",
   called it by hand.
2. **In-memory only.** It iterated `executionWorkspaces`, a process-local map. After a crash, or for
   work executed by another process, the parked workspace existed only in the durable registry, and
   `reconcile()` — the only thing that repopulated the map — also had no production caller. The
   "RESTART WHILE AWAITING REVIEW" proof kept the first process alive and said so.
3. **No real reviewer in the proof.** The certification helper `qcReviews()` wrote an APPROVE record
   directly; 0044's claim that it "runs the real reviewer" was inaccurate (corrected there).

The review half already worked in production: `QualityControlService.recover()` runs on every
recovery tick, registers every recorded execution without a QC job (`recoverUnregistered`) and
reviews it with the real `ReviewerService` (deterministic rules, then the OmniRoute LLM reviewer).

## Decision

### 1. One trigger: the production recovery sweep

`PendingReviewGateSweeper` wraps `gatePendingReview()` and is registered ONCE in
`createRecoveryScheduler`'s `sweepAll([...])`, AFTER the autonomy/QC sweep, so a review persisted on a
tick is gated on the same tick. It is the only production caller of `gatePendingReview()`
(structurally asserted).

The QC persistence path was rejected as the owner: the gate runs the full verification suite, and
coupling it to review persistence would make QC's retry/cooldown machinery re-run integrations and
put a second actor in charge of the gate. The sweep is already the component that advances durable
state after crashes.

### 2. Pending work is discovered from DURABLE state

Before gating, the pass ADOPTS from the workspace registry every workspace that is
`ready_for_integration`/`integrating`, unreleased, carries a workflow id, and ALREADY has a canonical
review. Adoption takes the durable lease (`acquireLease`, which bumps the fencing token):
- `LEASE_HELD` — a live owner is responsible for it: skip;
- `REGISTRY_LOCKED` — another process is mutating the registry (the registry uses a try-lock): skip,
  the next sweep retries;
- no review — not adopted, not claimed, not touched. Silence is never consent, and claiming unreviewed
  work would only block its real owner.

### 3. Exactly once

- In one process, overlapping sweeps share ONE in-flight pass (single-flight).
- Across processes, the durable lease + fencing token decide who gates; the registry lock serializes
  registry mutations.
- The IntegrationApplier's git-derived check (`ALREADY_INTEGRATED`) remains the last guarantee.
- A NEEDS_* verdict (not terminal) is not re-gated on every tick: the pass remembers the gate inputs
  (verdict, human approver, work branch head, target head) and re-gates only when one moved. The memo
  is process-local; after a restart the first pass gates once more (the safe direction).
- The gate, the applier and the review authority are unchanged: one IntegrationGate, one review.

### 4. Unchanged semantics

REQUEST_CHANGES → the gate refuses (REJECT, workspace reaped) and QC's bounded repair (CORRECT, routed
through the capability router) proceeds. Reviewer failure or silence → QC parks the job
(`review_unavailable`, 5-minute cooldown) and nothing is gated, integrated or escalated.

## Evidence

`src/server/autonomy/core3-natural-review-gate.integration.test.ts` (8 proofs), with the ONLY test
double at the network edge — a local endpoint speaking the OmniRoute chat-completions API, called by
ICOS's own reviewer client from ICOS's own QC service in ICOS's own production recovery scheduler:
- NATURAL_RUNTIME_REVIEW_GATE_E2E: reviewer unavailable → QC fails closed and parks the job, no review,
  no gate, no integration, no escalation → reviewer available, cooldown elapses → the real QC persists
  an LLM APPROVE → the production sweep gates → one gate call, one apply, INTEGRATED, workspace reaped.
  No hand-written review, no manual `gatePendingReview()`, no manual gate or applier call.
- REQUEST_CHANGES never integrates; a routed correction attempt is prepared (bounded repair).
- restart after execution before review; restart after review before gate (new process, owner dead).
- duplicate reviewer delivery and duplicate sweeps (concurrent + sequential): one gate call.
- two processes observing the same pending workspace: exactly one adopts and integrates.
- structural: `gatePendingReview()` has exactly one production caller.
- unit (`workspace-execution-coordinator.test.ts`): an inconclusive verdict is gated once, not on every
  sweep, and is gated again when an input moves.

Mutations (each must fail a behavioural test): trigger not registered in the production sweep, durable
adoption removed, adoption without claiming the lease, single-flight removed, `REGISTRY_LOCKED` treated as
fatal, unreviewed work adopted, re-gate memo removed. Results are recorded in `audit/self-build-bootstrap/STATE.md`.

## Known limits (open, not closed by this decision)

DEFECT 28 is closable on its own: review → production trigger → gate → integration. The three
items below are separate defects, each blocking a different capability.

- **DEFECT 36 — dependent governed tasks do not progress.** QC's ACCEPT completes the mission task and
  wakes the mission BEFORE the pending-review pass gates and reaps the workspace. A dependent task B
  is then dispatched while A is not yet integrated: with a scope overlapping A's, B's allocation is
  refused `OWNERSHIP_CONFLICT` and its PREPARED attempt is never allocated again; with a disjoint scope
  B is based on the pre-A target and its gate answers `NEEDS_REBASE`, which nothing resolves.
  Reproduced by the runtime (reviewer, sweep, gate) with no manual step. Fix is a design choice
  (completion driven by integration, re-allocation of prepared-but-unallocated attempts, or wake after
  reap) and needs its own decision.
- **STUCK EXECUTION ATTEMPTS (pre-existing).** Governed external-execution attempts stay `dispatched` after the
  work is recorded; only `record-mission-task-execution.ts` marks attempts completed by workflow id.
  They keep consuming worker concurrency slots, which threatens long-running autonomy and capacity.
- **REPAIR WORKSPACE DEFECT (pre-existing).** `supervisor-service.ts` fixes
  `attemptNumber = 1`, so a REQUEST_CHANGES correction attempt is not executed in a new governed
  workspace, so bounded repair is not real end to end yet.

Open item (not part of this decision): `GovernedSelfDevelopmentCoordinator` still calls the
IntegrationGate/IntegrationApplier directly with an unpersisted review (M10). Converging it onto the
persisted-review + pending-review path belongs to the self-development work; the structural test lists
it explicitly so the set of gate callers cannot grow silently.
