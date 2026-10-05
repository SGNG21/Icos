# Twelve-brain load-bearing audit, 2026-10-05

Are the twelve canonical brains (decisions 0066, 0068) load-bearing — do they change what
ICOS actually does — or are they rows? Every claim below is either a code reference (file,
function) or a read-only query against the live database `icos_n23_probe` run on 2026-10-05.
Nothing was written.

```
LIVE_DB=icos_n23_probe   BRANCH=feat/fable5-product-layer @ 3644cda (read-only inspection)
```

## Verdict in one line

**Seeded, certified, delegated, and NOT load-bearing: no live dispatch has ever been
influenced by a brain, because Chief records assignments under stage ids that CORE3 never
dispatches.**

## The chain, link by link

| # | Link | Code | Live evidence | State |
|---|---|---|---|---|
| 1 | Roles certified + activated by a human | `certifyRole` has no production path (0068) | `workforce_roles`: the 9 brain roles are `active`, 15 others `draft`; `role.certified` ×9, `role.activated` ×9 on 2026-10-04 | **DONE (human act)** |
| 2 | Twelve brains seeded through the single writer | `seedBrains` → `WorkforceService.createAgent` | `workforce_agents`: 12 rows, all `DURABLE_AGENT`, all `active`, created 2026-10-04; `agent.created` ×12 | **DONE** |
| 3 | Chief can plan a delegation from a goal | `chiefDelegation(chief).delegateGoal` (`src/server/workforce/chief-delegation.ts`), wired in `production-services.ts#chiefDelegate` into `igniteAutonomousMission` | `assignment.created` ×10 across 5 missions, each mission getting `brain-research` + `brain-reviewer`, supervisor `brain-chief` | **TRAVERSED** |
| 4 | Governance bounds delegation | `evaluateDelegation` → `CONCURRENCY_LIMIT`, `NO_ELIGIBLE_REPORT` | `governance.denied` ×14: 13 × `assignment.plan` refused for `CONCURRENCY_LIMIT` on research/reviewer, 1 × `assignment.synthesize` refused `CHILDREN_NOT_SETTLED` | **TRAVERSED** — and it bit: the stranded-assignment defect of 0067 item 1 |
| 5 | A terminal mission gives its brains back | `cancel` (migration 0060) + `chiefRelease` | all 10 assignments are `cancelled` (`from: assigned → cancelled`), none stranded | **DONE** |
| 6 | CORE3 asks the workforce before dispatch | `SupervisorService.routeReadyTask` → `workforceCompute.forTask(missionTask.missionId, missionTask.taskId)` (`supervisor-service.ts:153`) | call site is composed in production (`container.workforce?.core3Compute`) | **WIRED** |
| 7 | The brain's need reaches the router | `workforceTaskCompute.forTask` filters `a.missionId === missionId && a.taskId === taskId` (`core3-task-compute.ts`) | **0** of the dispatch attempts of the 5 delegated missions carry a brain: `routing_decision.requirement = {complexity: "low", requiredCapabilities: []}`, no `brain` in any routing decision, handoff or prompt; `spend_ledger.brain_id` is NULL on 14,404 / 14,404 rows | **NEVER TRAVERSED** |
| 8 | A brain's spend is attributed to it | `spend_ledger.brain_id` | 0 rows | **NEVER TRAVERSED** (consequence of 7) |

## Root cause of link 7: two task identities

Chief records an assignment per *stage*:

```
stageTaskId(missionId, stage) = `${missionId}:${stage.toLowerCase()}`
→ workforce_assignments.task_id = "27ca6bf7-…:research", "27ca6bf7-…:reviewer"
```

CORE3 dispatches *mission tasks*:

```
mission_tasks.task_id = "task-e28f331c-…", "task-c866f4d8-…"
```

`forTask` requires `a.taskId === taskId`. For mission `27ca6bf7` the two assignments were
alive from 18:21 to 22:49 and the mission's tasks were dispatched at 19:52 and 21:48 — inside
that window — and the routing requirement still shows no brain input. The seam is composed,
tested with matching ids in unit tests, and structurally unable to match in production.

This is not a seeding problem, a certification problem, or a capacity problem. Those three
were real and are closed. It is an identity mismatch at the one join that would make a brain
matter.

## Why this matters for the product layer

- The self-model reports `durableBrains = 12` and the cockpit will show 12 brains. Both are
  true and both describe rows, not influence. The new `workforce.delegate` evidence line
  therefore says "12 cerveau(x) durable(s)" beside the *routable worker* count rather than
  claiming delegation happens through them.
- Mission memory (0067 item 8) will attribute outcomes to a mission, not a brain, until link
  7 holds — a brain has nothing to remember yet.

## The fix (NOT made here — CORE3 / workforce lifecycle is the other worker's critical path)

One of two, decided by whoever owns the settlement path:

1. **Chief assigns by mission task.** `delegateGoal` runs after the DAG exists (it already
   receives `missionId`); map each planned stage to the mission task(s) carrying that stage's
   role and record `taskId = missionTask.taskId`. `stageTaskId` stays as the idempotency key
   inside the assignment spec. Smallest change, keeps `forTask` untouched.
2. **`forTask` matches by stage.** Carry the stage on the mission task (`mission_tasks` has
   no such column today) and match `a.taskId === stageTaskId(missionId, task.stage)`. Needs a
   migration; wider.

Either way the proof is one assertion: after a delegated dispatch,
`dispatch_attempts.routing_decision.requirement.requiredCapabilities` contains the brain's
skill capabilities and `spend_ledger.brain_id` is non-null on that attempt's rows.

## What is honestly load-bearing today

- The **gates**: role certification, human-principal seeding, the autonomy ceiling, the
  concurrency bound, and cancellation on release all executed on real rows and refused real
  requests. The organisation is governed.
- The **dispatch**: unchanged by any brain. Routing is the capability router + the model
  allowlist + the budget seam, exactly as before 0066.

```
BRAINS_SEEDED=12   ROLES_ACTIVE=9/24   ASSIGNMENTS_CREATED=10   ASSIGNMENTS_STRANDED=0
GOVERNANCE_DENIALS=14   DISPATCHES_INFLUENCED_BY_A_BRAIN=0   LEDGER_ROWS_WITH_BRAIN=0/14404
LOAD_BEARING=NO   BLOCKING_LINK=7 (task identity)   OWNER=CORE3/workforce lifecycle worker
```
