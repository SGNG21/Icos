# 0053: Accepted is not integrated, withdrawn work never lands, finished attempts free their slot

## Status
Accepted

## Context

After 0052 there is one review/gate/settlement authority. Three defects remained on it, each
reproduced by a failing proof before its fix.

- **INLINE_GATE_NEEDS_REBASE_DEFECT.** When a canonical review already existed as execution
  ended (QC reviewed the recorded result first — a real race), the coordinator gated inline and
  reported `success: decision === "ACCEPT"` regardless of what the apply returned. On
  NEEDS_REBASE the supervisor marked the task `succeeded` and released the workspace: the
  dependency was "satisfied" with nothing integrated, and the evidence was reaped.
- **CANCELLED_WORK_INTEGRATION_DEFECT.** A review judges the work, not whether it is still
  wanted. Approved work of a MissionTask cancelled while it waited was gated and applied. 0052's
  policy denial (cancel the started mission) depends on this refusal.
- **STUCK_EXECUTION_CAPACITY_DEFECT.** The external worker dispatcher settled a FAILED attempt
  but left a successful one `dispatched`; only the legacy callback route ever completed one.
  Durable load counts non-terminal attempts, so every successful governed attempt held its
  worker's slot for ever.

## Decision

1. An ACCEPT whose apply integrated nothing is `awaitingIntegration`: not success, not failure.
   The supervisor treats it like awaiting review — no status change, workspace kept — and
   completion stays with integrated settlement (0049). The pending-review pass reports success
   on the same rule.
2. `refuseWithdrawnWork` runs before every gate (inline and pending-review pass): a cancelled
   or superseded MissionTask's workspace is abandoned and released, never gated. Its branch
   survives as evidence.
3. The dispatcher marks the attempt `completed` once a successful result is durable. The
   attempt's lifecycle is the execution; review and integration are the task's.

## Evidence

`core3-dag-settlement.integration.test.ts`:

| Defect | Proof | Mutation | Result |
|---|---|---|---|
| inline NEEDS_REBASE | INLINE GATE (real QC wins the race; target moves between gate and apply) | supervisor ignores `awaitingIntegration` | fails |
| cancelled work | cancelled WHILE AWAITING REVIEW ×2 (recovery sweep, completion callback) | guard returns `null` | both fail |
| stuck capacity | TWO_TASK_DAG_E2E, CORRECTION_DAG_E2E: 0 non-terminal attempts at the end | no `markCompletedByWorkflowId` | fails (2 stuck) |

## Amendment — SUPERSEDED_ATTEMPT_WORKSPACE_HELD (found by self-build run 1)

The first real self-build run after 0053 stopped: the worker exceeded its timeout, the
canonical review answered RETRY, QC prepared attempt 2 — and attempt 1's workspace was never
released. A REQUEST_CHANGES predecessor is freed by the pending-review gate's REJECT; a FAILED
one has no review, so nothing freed it and every allocation of the retry collided
(WORKFLOW_COLLISION) for ever. Evidence:
`audit/self-build-bootstrap/evidence/icos-self-build-e2e-run1-2026-09-29-stranded-retry.md`.

Decision: when the supervisor governs attempt N > 1 it first calls
`retireSupersededWorkspaces(taskId, workflowId)`: every unreleased workspace of the task bound
to another workflow is abandoned and released under its lease (skipped if a live owner holds
it). A successor intent exists only because QC refused the predecessor, so that work can never
integrate. Proof: `core3-dag-settlement` "A's attempt 1 fails → QC RETRY → attempt 2 governed →
… → B" (worker timeout, as in the run); it failed before the fix exactly as the run did.
