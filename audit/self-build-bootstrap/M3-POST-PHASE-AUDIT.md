# M3 Post-Phase Audit

Date: 2026-09-27
HEAD: 5bb5a2b294f8bd90a42578cf8946db75c8591119
Scope: CORE3 M3 — one canonical durable authority for dependency/readiness semantics

## Trace result (deliverable 1)

| Concern | Path | Authority |
|---|---|---|
| DAG edges | `mission_tasks.depends_on` — written by `applyPlan`/`replacePlan` (planner keys resolved to MissionTask ids) | **CANONICAL** |
| DAG edges | `tasks.dependencies` — 6 writers, all `[]`; settable via `POST /api/tasks`; read only by `rowToTask` | **NON-AUTHORITATIVE** (demoted) |
| Readiness | `supervisor/readiness.ts computeReadyTasks` | **CANONICAL** (sole engine) |
| Readiness | `autonomous-mission-runner.ts readyDraftTasks` | **DELETED** (was a duplicate engine) |
| Completion propagation | `updateMissionTaskStatus` — QC repo, dispatch-attempt repo, supervisor, record-mission-task-execution, load-mission-checkpoint | unchanged; readiness derives from its result |
| Scheduler unlock | `supervisor-service.ts:140` → `computeReadyTasks` | single call site |
| Restart recovery | `load-mission-checkpoint.ts` replays statuses; readiness recomputed from DB | pure derivation, no stored readiness |
| Replanning | `replacePlan` → succeeded preserved, rest `superseded` (decision 0029) | superseded never satisfies a dependency |

## Findings

### MUST_NOW
**NONE.**

### SHOULD_NEXT

**S1 (carried, M2) — Persisted planning envelope still not HONORED.**
`attemptBudget` bounds nothing, `reviewPolicy` branches nothing,
`requiredCapabilities` does not route, worker prompt is still
`task.description || task.title`. M4/M5 and bounded repair own these. M3 changed
nothing here.

**S2 — RESOLVED by decision 0030.** No longer open.

**S3 (carried) — Dead duplicate repository.**
`src/server/mission/postgres-mission-repository.ts`: zero importers, never touches
`autonomous_plans`, and now also the only remaining place with its own
`updateMissionTaskDependsOn` + unordered listTasks. It did NOT receive the M3
determinism fix, deliberately — it is unreachable. Removal still wants its own
commit + ADR.

**S4 (carried) — CERT-1 / CERT-2 unrun.** 11 capability tests + 3 audit
append-only tests still skipped for lack of a Docker daemon. CERT-1 blocks
CAPABILITY_ROUTING in M4.

**S5 (carried) — Two canonical-JSON implementations.**
`mission-plan.ts canonicalize()` vs `scheduler-service.ts canonical()`.

**S6 — NEW: `tasks.dependencies` and the `POST /api/tasks` field should eventually
be removed.** Demotion achieves the invariant, but an inert, externally-settable
field that resembles an authority is a trap for future work. Tracked as cleanup,
not a blocker; it is documented in the contract, the schema and decision 0030, and
its non-authority is proven by test.

**S7 — NEW: dispatch order is deterministic but arbitrary within a plan.**
`applyPlan` stamps one `createdAt` for every task in a plan, so ordering falls
through to `id` (a UUID). Order is now stable across reads, status churn and
restarts — which is what determinism requires — but it does NOT follow the
planner's declared task order. If plan-order dispatch ever matters (it may for
human-legible progress), add an explicit sequence column rather than relying on
insertion order.

### LATER
- L1 `format:check` fails on 243 files (pre-existing; repo never prettier-formatted).
- L2 drizzle-kit meta snapshots stop at 0009; migrations are hand-written.
- L3 empty applied migration `0039_task_core3_fields.sql`; 0041 supersedes it.
- L4 mixed column naming (`goals."goalId"` vs snake_case elsewhere).
- L5 `tasks` row is 22 columns / 5 jsonb.
- L6 **NEW** — Other unordered SELECTs may exist outside the mission-task path.
  M3 fixed the one that feeds dispatch. A sweep for unordered list queries whose
  order is observable is worth doing before CORE3 certification.

### REJECT
- **R1 Keep both edge representations synchronized.** Synchronization is not one
  authority; it is two plus a divergence failure mode.
- **R2 Promote `tasks.dependencies` to canonical.** Rewrites both readiness paths
  and changes an external API field's meaning for zero behavioral gain.
- **R3 Backfill `tasks.dependencies` from `depends_on`.** Entrenches the
  duplication it pretends to fix.
- **R4 Drop the column in M3.** Breaking external API change, off critical path.
  Demotion achieves the invariant.
- **R5 Store a materialized "ready" flag or a readiness cache.** Rejected: stored
  readiness is derived state that can disagree with the DAG, which is how
  double-unlock bugs appear. Readiness stays a pure derivation — that is precisely
  what makes exactly-once unlock free and restart-safe.

## Dimension review

| Dimension | Assessment |
|---|---|
| Architecture | Materially improved. Two duplicate authorities collapsed to one each (edges, readiness). One readiness engine, one completion status constant, one edge source. |
| Security | Improved. Ready-eligibility became an allow-list, so a future MissionTask status is not runnable by default. Unresolvable dependencies block instead of being ignored. |
| Concurrency | Improved. Readiness holds no bookkeeping, so concurrent recomputation cannot double-advance; exactly-once dispatch stays with the ledger where fencing lives. Existing `postgres-multiworker-concurrent` and `postgres-dag-multibranch` suites pass unchanged. |
| Persistence | Readiness is never persisted, only derived — deliberately (R5). Determinism now comes from an explicit ORDER BY rather than accidental heap order. |
| Resilience | Restart proven to reproduce identical readiness AND identical task order. |
| Provider replaceability | Unaffected. |
| Test quality | Improved twice: two mutations verified the gating rule at unit and integration level, and a genuine pre-existing flake was removed so the gate means something. |
| Observability | Unchanged. Deterministic ordering makes logs/diffs comparable run to run, which helps. |
| Cost | Negligible. One ORDER BY on an indexed, mission-scoped query. |
| Technical debt | Net reduced: one duplicate engine deleted, one duplicate authority demoted with proof, one non-determinism removed, one flaky test fixed, one unused variable removed (lint 289 vs 290 baseline). |
| Unnecessary abstractions | None added. No new readiness engine was built — the existing one was made canonical and the duplicate deleted. |
| Autonomy opportunity | DAG advancement now depends only on canonical persisted completion, which is the precondition for trusting unattended multi-worker execution in M5. |

## Verdict

MUST_NOW: NONE.
M3_CANONICAL_READINESS_AUTHORITY_CERTIFIED

Proceeding to M4 (capability routing). Note that CERT-1 (11 skipped capability
tests, Docker-gated) BLOCKS declaring CAPABILITY_ROUTING proven, so M4 must either
run them or state plainly that the claim is unproven.
