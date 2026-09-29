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
