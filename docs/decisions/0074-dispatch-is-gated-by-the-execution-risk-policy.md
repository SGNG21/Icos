# 0074: Dispatch is gated by the execution risk policy

## Status

Proposed (P0 autonomy unblock, worker W2). The number is provisional; the integrator assigns
the final one.

## Context

`mission.launch` is decided by `classifyMissionAutonomy` from the capabilities a goal declares.
After launch nothing re-checked risk: the planner (a model) chooses each task's `riskClass`, the
supervisor read `riskClass` only to allocate a workspace, and the goal's `humanApprovalPolicy`
and `allowedCapabilities` were never read on the dispatch path. A goal launched on policy could
therefore be planned into a task that deploys, deletes or pays, and it would be dispatched. The
only pre-existing park in `awaiting_approval` (a reviewer's ESCALATE_TO_HUMAN) happens AFTER
execution.

## Decision

1. **One table.** `src/core/autonomy/execution-risk-policy.ts` holds eight action risk classes
   (READ_ONLY, REVERSIBLE_ISOLATED, REVERSIBLE_EXTERNAL, PRIVILEGED, SECRET_SENSITIVE,
   DESTRUCTIVE, FINANCIAL, IRREVERSIBLE), an explicit capability → class table, and the
   decision rules (AUTONOMOUS | GOVERNED | APPROVAL_REQUIRED). Unknown capabilities, capabilities
   outside the goal's allowlist, a `sensitive` kernel or goal risk, and owner policy `always`
   all require a human. `classifyMissionAutonomy` derives its sets from this table, unchanged.
   `customer_communication` is IRREVERSIBLE: a delivered message has no rollback.
2. **Enforced per task, before dispatch.** `SupervisorService.run()` asks `TaskRiskGate` for
   every task before routing, before any dispatch attempt is prepared and before any workspace
   is allocated. APPROVAL_REQUIRED parks the task: canonical `draft → queued →
   awaiting_approval` through the canonical task transition, each audited with the class, the
   reasons, the policy version and a verdict fingerprint; the mission task goes to
   `awaiting_approval`. No dispatch attempt exists for a parked task. The gate fails closed on
   any classification error. "Writer" means what the workspace allocation policy means (only
   `read_only` mutates nothing); a writer counts as isolated only when its allocation is
   GOVERNED, and a writer the allocation REFUSES keeps blocking exactly as before.
3. **Human approval reuses the mission approval.** `POST /api/missions/[id]/approval`
   (`approvals.decide`, operational scope, decider = session user) now calls
   `approveRiskGatedTasks`, which moves each gate-parked canonical task `awaiting_approval →
   queued` AS THAT HUMAN, recording the fingerprint it approved, and returns the mission task to
   `draft`. That audited transition is the approval record; the gate accepts only a
   human-attributed approval whose fingerprint and policy version match the current verdict.
   The task then takes the ordinary ledger path, where `prepare()` is idempotent: exactly once.
4. **One lifecycle edge.** `awaiting_approval → queued` is added to the task lifecycle: work
   approved before any attempt existed returns to the dispatch queue rather than claiming to run.
5. **Reported, not declared.** `SupervisorService.riskGate` is `{ enforced, policyVersion }`;
   `enforced` is true only when the gate is composed (it is, in `composeAutonomyRuntime`).

## Consequences

- Owner policy `always` parks every task of the goal. The cognitive gateway sets `always` for
  every human-approved conversational goal, and the proactive adapter for every non-read-only
  proposal, so such missions now need one more approval at dispatch (one per wave of ready
  tasks). This is the policy as specified; whether a launch approval should also cover dispatch
  is an owner decision.
- A goal with a non-empty `allowedCapabilities` that omits `code_write` cannot run writer tasks
  unattended.
- `TaskRepository.transition` gained an optional `audit` argument (actor + extra details).

## Known limits

- A pending correction attempt whose verdict became APPROVAL_REQUIRED is held (not claimed) and
  its mission task set to `awaiting_approval`, but `approveRiskGatedTasks` releases only
  tasks parked before any attempt; such a task needs operator action.
- No deployment grants unattended external changes or secret scopes yet, so REVERSIBLE_EXTERNAL
  and SECRET_SENSITIVE always require approval at dispatch; REVERSIBLE_EXTERNAL has no member.
- Runtime tool effects remain governed separately by the Tool Gateway (grants, HIGH/CRITICAL
  approvals); this gate classifies the task, not each tool call.
