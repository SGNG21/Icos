# 0065: Ordering objectives is admission-time policy, not a new runtime

## Status

Numbering: authored as decision 0065 in `src/core/supervisor` / `src/server/supervisor`,
on `feat/icos-chief-supervisor` cut from `660b41f`. Central may move independently; the
number is provisional until integration, like 0055→0060 before it.

Accepted (foundation). No migration: this decision adds no table and no column.

## Context

The P0 asked for a "Chief Supervisor" that turns ICOS from a collection of workers into one
coherent digital employee: understand → prioritize → plan → delegate → supervise → review →
recover → decide → learn → report.

Reconnaissance found a canonical owner for almost all of it:

| Need | Canonical owner reused | Not rebuilt |
| --- | --- | --- |
| Goal model and intake | `high-level-goal.ts`, `goals`, `CanonicalGoalLauncher` | no second goal entity |
| Plan / DAG / execution loop | `AutonomousMissionRunner`, `canonical-mission-planner` | no second runner, no second planner |
| Dispatch, leases, ledger | `SupervisorService` (CORE3's dispatcher) | no second executor |
| Delegation + hierarchy bounds | `core/workforce/delegation.ts`, `contracts.ts` | no second delegation contract |
| Review + independence | `review/*`, `reviewer-independence.ts`, `QualityControlService` | no second reviewer, no second verdict set |
| Recovery + retries | `recovery/*`, `*-recovery-sweeper.ts`, `dispatch_attempts` | no second retry authority |
| Human escalation + resume | `approval-request.ts`, `AutonomyWakeupService` | no second approval authority |
| Memory writeback | `memory/recorders.ts`, `mission_memory_entries` | no second memory store |
| Scheduling | `DurableScheduler` (ADR-0025) | no second scheduler, no `setInterval` |
| Holding running work | `RuntimeControlGuard` (0055) | no second control plane |

Three things were genuinely absent:

1. **No cross-objective priority.** `goals.priority` was written at intake and mapped on
   read (`mappers.ts`), and consumed by nothing. No call site passed `priority` to
   `SchedulerService.enqueue`, so every `start_mission` job was enqueued at the default
   `0`. ICOS was strictly FIFO across objectives: a client incident queued behind a
   research idea because the research idea arrived first.
2. **No portfolio governor.** Nothing bounded how many objectives of which kind ran at
   once, or reserved capacity for a class that was not currently shouting.
3. **No objective-level read model.** The cockpit projects missions, DAGs, workforce and
   compute. Nothing answered "what is ICOS doing?" across *goals*.

## Decision

**Ordering and bounding objectives is a POLICY APPLIED AT ADMISSION, over the authorities
that already exist. It is not a runtime.**

Concretely: two pure functions and a thin coordinator sit in front of the one call that was
already there — `scheduler.enqueue({ kind: "start_mission" })` — and give it a `priority`
and, under pressure, a later `runAt`. Nothing else changes.

### 1. Doctrine is data, and the bands are uncrossable

`PriorityPolicy.classBase` encodes ICOS doctrine as a versioned data object:
USER 90 · CLIENT 75 · REVENUE 75 · SECURITY 60 · MAINTENANCE 40 · SELF_IMPROVEMENT 20 ·
RESEARCH 5. Ten factors contribute a bonus in `[-7, +7]`.

Band spacing (>= 15) exceeds the maximum factor swing (14). **Self-improvement cannot
outrank user, client, revenue or security work by scoring well** — that is arithmetic, not
a convention a future contributor must remember. Factors reorder *within* a class.

### 2. Absent evidence is named, never imputed

A factor with no evidence contributes nothing and appears in `missing[]`. It is never
scored as zero: "no client importance recorded" and "a client of zero importance" are
different facts. With today's data roughly half the factors report missing on a typical
goal — that is the truthful result and it is on the record, not smoothed over.

`goal.priority` is `NOT NULL DEFAULT 3`, so an unset priority cannot be told from an
explicit 3. The factor says so in its own evidence string rather than claiming the user
chose it.

### 3. The portfolio defers; it never rejects, and never starves

Per-class `maxConcurrent`, `reserved` and `computeBudgetUnits`, plus a global cap. Only the
*unused* part of another class's reservation is held back from the global pool — counting
the whole reservation would deadlock the pool as soon as several classes were busy.
`globalMaxConcurrent >= Σ reserved` is asserted by test.

There is no reject outcome. Pressure becomes `runAt` on the same durable job, so the
existing scheduler brings the work back and nothing new holds it.

### 4. Admission is not control

The governor is consulted ONCE, before enqueue. It never inspects or alters running work.
`RuntimeControlGuard` and the control plane remain the only authority that holds, pauses or
cancels a mission in flight. `ObjectiveCoordinator` holds no reference to either.

### 5. Objective state is derived, never persisted

`deriveObjectiveState` maps (goal status, mission status, task statuses, runtime state,
pending approval, control hold) onto the brief's vocabulary on every read. No table, no
transition guard, no write. A restart therefore cannot leave a stale objective lifecycle
behind, and there is no second source of truth to reconcile against the mission.

Source truth that cannot be read yields `DEGRADED` with the field named in `unknown[]`. A
mission id that does not resolve is **not** `RECEIVED`: "nothing was launched" and "the row
is unreadable" are different facts.

## Consequences

- `goals.priority` is a consumed field for the first time. A goal's priority now changes
  the order the scheduler claims its job in.
- Removing `ObjectiveCoordinator` reverts launches to priority 0 and unbounded admission —
  i.e. exactly the behaviour before this decision. It is additive and reversible.
- The read model reports `cost` as `UNKNOWN`, because no CORE3 execution record carries one
  (`task_execution_results` has no cost column). The budget gate in the portfolio governor
  is therefore inert until costs exist. Stating this is the point: a fabricated 0 would
  make an unmeasured system look measured.
- Classification falls back to a declared `defaultClass` when no rule matches, tagged
  `classSource: "default"`. A declared policy default is not an inferred fact, and the read
  model surfaces the difference.
- `GoalRepository` gains a read-only `list()`. No schema change: `status`,
  `resultingMissionId` and `convertedAt` are existing columns that `rowToGoal` dropped.
- The name `SupervisorService` is NOT reused. It belongs to CORE3's dispatcher and must
  keep belonging to it; this layer is `ObjectiveCoordinator`. Same reason CCD-18 moved the
  Proactive Supervisor out of `src/core/supervisor` in 0060.

## Alternatives rejected

- **A persisted `SupervisorObjective` with its own lifecycle.** Richer (it could hold
  CONTEXTUALIZED and DEGRADED distinctly), but it becomes a second source of truth that
  disagrees with the mission after a crash, and a restart-duplication surface. Derivation
  costs one join and cannot drift.
- **Enforcing the portfolio inside CORE3's dispatch path.** It would bound running work
  more precisely, and it would make this layer a second admission authority alongside
  `RuntimeControlGuard`. Rejected on that ground alone.
- **Re-expressing delegation, review, recovery and escalation at the supervisor layer**, as
  the brief's sections FOURTH–NINTH read literally. Each already has a canonical owner;
  restating them here would create exactly the duplicate authorities the same brief forbids
  in its CRITICAL OWNERSHIP RULES. See `docs/supervisor/evidence-map.md`.
