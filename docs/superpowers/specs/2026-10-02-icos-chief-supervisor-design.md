# ICOS Chief Supervisor — Objective-Level Orchestration

Date: 2026-10-02
Lane: `feat/icos-chief-supervisor`
Start HEAD: `660b41f`
Status: approved design

## 1. Purpose

Geoffrey gives ICOS an objective. ICOS must order it against everything else
it has been asked to do, admit it into execution within explicit bounds, and
report truthfully on what it is doing — without Geoffrey operating workers.

This lane builds **only what does not already exist**. Reconnaissance (section 2)
found canonical owners for understand / plan / delegate / supervise / review /
recover / escalate / learn. What is missing is the layer *above* a single
objective: ordering between objectives, bounding how many run at once, and a
read model that answers "what is ICOS doing?".

## 2. Ownership map (reconnaissance result)

Canonical owners that this lane **consumes and never replaces**:

| Capability | Canonical owner |
| --- | --- |
| Goal model | `core/contracts/high-level-goal.ts`, `goals` table |
| Goal intake | `server/cognitive/mission-gateway.ts` (`CanonicalGoalLauncher`) |
| Mission model / machine | `core/mission/contracts.ts`, `core/mission/machine.ts` |
| Mission planner | `server/autonomy/canonical-mission-planner.ts` |
| Objective execution loop | `server/autonomy/autonomous-mission-runner.ts` |
| Task dispatch, leases, ledger | `server/supervisor/supervisor-service.ts` |
| Readiness / DAG | `server/supervisor/readiness.ts` |
| Worker registry + routing | `server/routing/capability-router.ts`, `core/workers/*` |
| Delegation + hierarchy bounds | `core/workforce/delegation.ts`, `core/workforce/contracts.ts` |
| Review + independence | `server/review/*`, `server/autonomy/reviewer-independence.ts`, `server/usecases/quality-control-service.ts` |
| Recovery | `server/recovery/*`, `server/autonomy/*-recovery-sweeper.ts` |
| Human escalation + resume | `core/contracts/approval-request.ts`, `server/autonomy/autonomy-wakeup-service.ts` |
| Memory writeback | `server/memory/recorders.ts`, `missionMemoryEntries` |
| Event → situation → proposal | `core/proactive/contracts.ts`, `core/proactive/policy.ts` |
| Scheduler | `server/scheduler/durable-scheduler.ts` |
| Runtime control / holds | `core/control/*`, `server/control/runtime-control.ts` |

### Gaps this lane fills

1. **No cross-objective priority.** `goals.priority` is persisted and mapped
   (`mappers.ts:703`) and read by no consumer. No call site passes `priority`
   to `SchedulerService.enqueue`, so every `start_mission` job is enqueued at
   the default `0`. ICOS is strictly FIFO across objectives.
2. **No portfolio governor.** No allocation of concurrency or compute budget
   across work classes exists anywhere in `src/`.
3. **No objective-level read model.** `features/cockpit/*` projects missions,
   DAGs, workforce and compute. Nothing spans *goals*.

### Naming collision (recorded deliberately)

`SupervisorService` already exists and is CORE3's **task dispatcher**. The new
component is `ObjectiveCoordinator`. The name `SupervisorService` is not reused,
not wrapped and not renamed.

## 3. Invariants

These are binding on every part of the implementation.

- `ObjectiveCoordinator` is a thin coordinator: it loads facts, calls pure
  functions, and enqueues. It owns no loop, no lease, no retry, no state.
- `RuntimeControlGuard` remains the only authority that holds *running* work.
  The Portfolio Governor acts only on *admission at launch*.
- No new scheduler loop. The Durable Scheduler is the only job runner.
- No persisted objective lifecycle. Objective state is derived on read.
- No duplicate review, recovery or escalation authority.
- Portfolio allocation applies only at the existing mission launch point.
- Missing business evidence is reported as missing. It is never inferred,
  defaulted to a plausible number, or hidden.
- Invariants owned by other subsystems are referenced through an evidence map,
  not re-asserted as competing tests here.
- No new table, no migration.

## 4. Component 1 — Priority Governor

`src/core/supervisor/priority.ts` — pure, no I/O, no clock of its own.

### 4.1 Work classes

```
USER | CLIENT | REVENUE | SECURITY | MAINTENANCE | SELF_IMPROVEMENT | RESEARCH
```

### 4.2 Classification

Classification is **policy data**, not branches. The policy carries an ordered
list of `ClassificationRule { when: {metadataKey, equals} | {riskAtLeast} , class }`.
The first matching rule wins; evaluation order is the array order, so it is
deterministic and reviewable.

When no rule matches, the result is the policy's declared `defaultClass`, tagged
`source: "default"`. This is a **declared policy decision**, not an inferred
fact: the read model surfaces `classSource` so a consumer can tell a classified
objective from a defaulted one.

### 4.3 Factors

Ten factors, each a named contributor with a declared evidence source. A factor
whose evidence is absent contributes **nothing** and is listed in `missing[]`.

| Factor | Evidence today | Absent when |
| --- | --- | --- |
| `userPriority` | `goal.priority` (1–5) | never — but see note |
| `deadlinePressure` | `goal.deadline` vs `now` | no deadline |
| `risk` | `goal.riskLevel` | never |
| `reversibility` | `goal.riskLevel` (`sensitive` ⇒ not reversible) | never |
| `cost` | `goal.budget` | no budget recorded |
| `clientImportance` | `policy.clientWeights[metadata.clientId]` | no client, or client unweighted |
| `urgency` | `metadata.urgency` (proactive severity) | not proposal-originated |
| `businessImpact` | `metadata.businessImpact` | not recorded |
| `expectedValue` | `metadata.expectedValue` | not recorded |
| `dependencyBlocking` | `facts.blockedObjectiveCount` | caller cannot compute it |

`goal.priority` is `NOT NULL DEFAULT 3`, so an unset priority is indistinguishable
from an explicit 3. The factor therefore records `evidence: "goal.priority=3
(indistinguishable from unset)"` at that value, rather than claiming the user
chose it.

With today's data roughly half the factors report missing on a typical goal.
That is the truthful result and is surfaced, not smoothed over.

### 4.4 Score

```
priority = clamp(classBase[class] + factorBonus, -100, 100)
```

`classBase` encodes ICOS doctrine as versioned policy data:

```
USER 90 · CLIENT 75 · REVENUE 75 · SECURITY 60 · MAINTENANCE 40
SELF_IMPROVEMENT 20 · RESEARCH 5
```

`factorBonus ∈ [-7, +7]`, the weighted sum of present factors normalised to
`[-1, 1]`. Band spacing (≥ 15) exceeds the maximum factor swing (14), so factors
reorder objectives **within** a class and can never promote a class above the
one above it. `CLIENT` and `REVENUE` share a band by design (doctrine rank 2);
factors break that tie.

Self-improvement can therefore never outrank user, client, revenue or security
work by scoring well — the band arithmetic makes it structurally impossible,
not merely unlikely.

### 4.5 Tie-breaking

Deterministic, total order:

```
score DESC, deadline ASC (absent last), createdAt ASC, goalId ASC
```

### 4.6 Output

```ts
{
  priority: number;            // fed to SchedulerService.enqueue
  class: WorkClass;
  classSource: "rule" | "default";
  policyVersion: string;
  factors: { name, raw, normalized, weight, contribution, evidence }[];
  missing: string[];
}
```

The evidence array is what makes the decision auditable: a reader can
reconstruct the score from it without re-running the scorer.

## 5. Component 2 — Portfolio Governor

`src/core/supervisor/portfolio.ts` — pure, deterministic.

```ts
allocate(policy, state, candidate) ->
  | { admit: true; evidence }
  | { defer: true; reason; retryAfterMs; evidence }
```

### 5.1 Caps

Per class: `maxConcurrent`, `reserved`, `computeBudgetUnits` (per window).
Global: `maxConcurrentObjectives`, `windowMs`.

### 5.2 No starvation

```
slotsAvailableTo(c) = min(
  maxConcurrent[c] - active[c],
  globalMax - totalActive - Σ_{c' ≠ c} max(0, reserved[c'] - active[c'])
)
```

Reserved slots are deducted from the global pool before any other class may
draw on it, so a flood of `USER` work can never consume `SECURITY`'s or
`CLIENT`'s reserved capacity. Every class has `reserved ≥ 1`.

### 5.3 Defer, never reject

The governor has no reject outcome. Concurrency pressure defers to the next
expected slot; compute-budget exhaustion defers to the next window boundary.
A deferred objective is expressed as `runAt` on the existing durable
`start_mission` job — the scheduler already orders and retries it. Nothing new
holds it.

### 5.4 Relationship to RuntimeControlGuard

The Portfolio Governor is consulted **once**, at launch, before the job is
enqueued. It never inspects or alters running work. A mission already running
is held, paused or cancelled only by `RuntimeControlGuard` and the control
plane. There is no path by which an admission decision bypasses, overrides or
substitutes for a control hold.

## 6. Component 3 — Objective read model

### 6.1 Derived state

`src/core/supervisor/objective-state.ts` — pure projection, zero persisted state.

```ts
deriveObjectiveState(input) -> { state, phase, blockedReason, unknown: string[] }
```

Inputs: goal status, mission (optional), mission tasks, autonomous runtime
state (optional), pending approval flag, control-hold flag.

| Derived state | Condition |
| --- | --- |
| `RECEIVED` | goal exists, no mission |
| `CONTEXTUALIZED` | mission exists, status `draft` |
| `PLANNING` | mission status `planning` |
| `DELEGATING` | mission `ready`, tasks queued, none running |
| `EXECUTING` | a task is `running` |
| `REVIEWING` | a task is `review_pending` |
| `REPAIRING` | a task returned to `queued` after a review |
| `DECISION_READY` | all tasks terminal, mission not yet settled |
| `WAITING_FOR_HUMAN` | mission `awaiting_approval` or a pending approval request |
| `BLOCKED` | mission `blocked`, or a control hold is in force |
| `RECOVERING` | runtime reports a recovery in progress |
| `DEGRADED` | source truth incomplete (see below) |
| `COMPLETED` / `FAILED` / `CANCELLED` | mission terminal |

`DEGRADED` is returned when a referenced mission cannot be read, or a mission is
running with no readable runtime. `unknown[]` names each field that could not be
established. Nothing is filled in with a plausible value.

Because state is computed from current rows on every read, a restart cannot
leave a stale objective lifecycle behind, and there is no second source of truth
to reconcile.

### 6.2 Projection

`src/server/supervisor/objective-read-model.ts` emits, per objective:

`objectiveId · title · state · phase · priority {score, class, classSource,
policyVersion} · progress {tasksTotal, tasksSettled} · assignedWorkers[] ·
reviewState · blockedReason · humanDecisionRequired · cost · elapsedMs ·
latestMeaningfulResult · degraded {unknown[]}`

Every field that cannot be established is `UNKNOWN`, never zero and never a
guess. `cost` is `UNKNOWN` when no execution recorded `costCents`.

### 6.3 Surface

`GET /api/supervisor/objectives` — read-only, `protectRoute` with the existing
`cockpit.read` permission (this is a cockpit-class projection, not a new
permission surface), operational scope applied exactly as `/api/cockpit` does. No write
verbs on this route.

## 7. Component 4 — ObjectiveCoordinator

`src/server/supervisor/objective-coordinator.ts`

```ts
admit(goal, facts) -> { enqueued, jobId, missionId, priority, evidence }
                    | { deferred, retryAfterMs, evidence }
```

Sequence, with no step of its own invented:

1. read the goal (already persisted by the existing intake);
2. `scoreObjective(...)` — pure;
3. `allocate(...)` — pure;
4. `scheduler.enqueue({ kind: "start_mission", priority, runAt? })` — the
   existing durable scheduler, the existing job kind, the existing
   idempotency key supplied by the caller.

The coordinator holds no state between calls. If it is removed, launches
revert to priority `0` and unbounded admission — i.e. today's behaviour.

## 8. Integration points

Two call sites gain priority and admission; nothing else changes.

- `src/server/cognitive/mission-gateway.ts` — `CanonicalGoalLauncher.launch`
- `src/app/api/missions/autonomous/route.ts` — POST handler

One read-only repository addition:

- `GoalRepository.list(filter)` returning `{ goal, status, resultingMissionId,
  convertedAt }`, implemented for Postgres and in-memory. Required because no
  list method exists and the read model needs one. No schema change: `status`,
  `resultingMissionId` and `convertedAt` are existing columns that `rowToGoal`
  currently drops.

## 9. Testing

### 9.1 New deterministic suites (this lane's own)

- `SUPERVISOR_PRIORITY_USER_OVER_SELF` — a maximally favourable
  `SELF_IMPROVEMENT` goal scores below a minimally favourable `USER` goal.
- `SUPERVISOR_CLIENT_OVER_SELF` — same, for `CLIENT`.
- Priority: determinism, total tie-break order, explicit `missing[]`,
  reconstructable evidence, policy version recorded.
- `SUPERVISOR_BUDGET_EXHAUSTION` — compute budget exhausted ⇒ defer with a
  window-boundary `retryAfterMs`, never reject.
- Portfolio: per-class caps, reserved-slot no-starvation, determinism,
  and that no allocation outcome can admit work a control hold forbids.
- Objective state: every row of the table in 6.1, plus `DEGRADED` with a
  populated `unknown[]` when a mission is unreadable.
- `SUPERVISOR_STALE_MEMORY_NOT_LIVE_AUTHORITY` — a memory entry describing a
  past outcome does not alter derived state; live rows win.
- Read model: `UNKNOWN` propagation for cost, progress and workers.

### 9.2 E2E simulation (in-memory, no live DB)

`SUPERVISOR_E2E`: user objective → coordinator admits → plan → two workers →
independent review → one repair cycle → completed, asserted through the
existing in-memory composition. No external calls, no destructive action.

### 9.3 Evidence map (owned elsewhere)

The remaining brief scenarios are invariants of other subsystems. They are
referenced in `docs/supervisor/evidence-map.md` by test file, not re-implemented
here — a second assertion of another lane's invariant is a second authority over
it, and would drift.

Covered by evidence map: `SINGLE_OBJECTIVE`, `MULTI_TASK_DAG`,
`PARALLEL_DELEGATION`, `DEPENDENCY_ORDER`, `WORKER_FAILURE`, `MODEL_FAILURE`,
`REASSIGNMENT`, `FAILED_REVIEW`, `REPAIR_CYCLE`, `HUMAN_ESCALATION`,
`HUMAN_RESUME`, `RESTART_RESUME`, `NO_DUPLICATE_EXECUTION`, `NO_SELF_APPROVAL`,
`NO_AUTHORITY_ESCALATION`, `MEMORY_WRITEBACK`.

## 10. Out of scope

- `SupervisorObjective` as a persisted entity.
- Any re-expression of delegation, review, recovery or escalation at this layer.
- Cockpit redesign.
- Hierarchical mini-ICOS departments beyond what `core/workforce` already bounds.
- Any live-DB, live-runtime or integration-central change.

## 11. Decision record

`docs/decisions/0065-objective-priority-and-portfolio-are-admission-time-policy.md`
records the one architectural claim: ordering and bounding objectives is an
**admission-time policy over existing authorities**, not a new runtime.
