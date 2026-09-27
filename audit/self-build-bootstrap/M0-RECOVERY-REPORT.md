# M0 — Repository Forensic Recovery Report

Date: 2026-09-27
Worktree: /Users/coco/icos-worktrees/autonomy-core3-goal-planner-dag
Branch: feat/autonomy-core3-goal-planner-dag
HEAD at audit: ec5dcf5113f5f3a30bd99663a3b0c61edd2dbc96 ("fix(core3): persist immutable autonomous plan lineage")

## 1. Verdict on the suspected destructive rewrite

The warning (mission §5) was that `src/server/repositories/postgres/mission-repository.ts`
had been shrunk by hundreds of lines and that mature CORE1/CORE2 behavior may have been deleted.

**Finding: no CORE1/CORE2 behavior was deleted.** The shrink is not a behavioral deletion.

Evidence:
- worktree = 744 lines, HEAD = 849 lines, index/staged = 855 lines.
- `original.ts` (untracked) is byte-identical to `HEAD:src/server/repositories/postgres/mission-repository.ts`
  (verified by `diff`) — it is a manual backup taken by a previous session, not new work.
- `git diff` hunk ranges are confined to `applyPlan()` and `replacePlan()` only
  (hunks @195, @255, @442, @476, @614; the last hunk terminates at `findById`).
  Every other method in the file is untouched.
- The 105-line reduction is explained by style collapse: the mature file used a very narrow
  multi-line formatting style with semicolons; the rewrite reflowed it to compact style and
  dropped semicolons, and condensed several block comments to single-line comments.

**However** the rewrite is still not acceptable as-is: it destroyed the explanatory
CORE1/CORE2 rationale comments (e.g. "Planner keys are intentionally resolved BEFORE
persistence", the N2.7 invariant blocks) and reformatted ~500 lines of certified code for no
behavioral gain, which is exactly what makes a diff unreviewable. Recovery approach: restore the
HEAD file verbatim and re-apply only the genuine semantic deltas surgically.

## 2. Real defects found in the uncommitted CORE3 work

### D1 (CRITICAL) — plan fingerprint is blind to plan content
`applyPlan`/`replacePlan` computed:
```js
JSON.stringify(plan, Object.keys(plan).sort())
```
The second argument of `JSON.stringify` is a **replacer**, not a key-sort. Passing an array
makes it a property whitelist applied at every nesting level. Since the whitelist is
`["tasks","version"]`, every task object is stripped to `{}`.

Proven by execution: two completely different plans serialize identically to
`{"tasks":[{},{}],"version":1}` and hash to the same value
`0b97a20050880f63e363410fbfbff34a123d9fbd2ee237dfda312d69756ad37a`.

Consequence: any two plans with the same task count share a fingerprint. `applyPlan` would
reuse P1 and silently skip a genuine semantic replan. This defeats the entire idempotency
scheme of mission §8.

### D2 (CRITICAL) — planId conflated with planFingerprint (forbidden by §8 / §39)
`src/server/services/in-memory/mission-repository.ts` sets
`planId = stablePlanId = sha256(plan)`. The mission forbids conflating the two concepts.

### D3 (CRITICAL) — replacePlan does not create a new plan identity (in-memory)
In-memory `replacePlan` sets `planId = existingPlan.planId` (same identity, bumped version).
§8 requires a genuine replan to allocate a NEW planId P2 with `predecessorPlanId = P1`.

### D4 (HIGH) — predecessor references the internal surrogate id (in-memory)
In-memory sets `predecessorPlanId = existingPlan.id` (surrogate `id`). §9 requires
`predecessor_plan_id` to reference `autonomous_plans(plan_id)`. The Postgres path is correct.

### D5 (HIGH) — Drizzle schema does not match the migration
`drizzle/0040_autonomous_plan_lineage.sql` creates `plan_fingerprint` and
`predecessor_plan_id`, but `schema.ts` declares neither. `foreignKey` is imported and unused.
This is the direct cause of the typecheck failure. The `predecessorPlanId` column + FK
definition were present in `stash@{0}` and were lost when a later session overwrote `schema.ts`.

### D6 (HIGH) — fake green test evidence
`src/server/services/in-memory/__tests__/mission-repository-lineage.test.ts` contains tests
D, L, M, N with empty bodies that PASS unconditionally, and comments claiming the behavior is
"tested in PostgreSQL" where no such test exists. §37 forbids this.

### D7 (MEDIUM) — test F asserts a governance-violating behavior
Test F asserts that re-applying an older plan after a replan moves `Mission.planId` *back* to
P1. That regresses the mission current-plan pointer to a superseded plan. Tests E and F pass
only accidentally, via the D1 fingerprint collision behavior.

### D8 (MEDIUM) — in-memory/Postgres divergence on the already-applied invariant
Postgres `applyPlan` throws `MISSION_PLAN_ALREADY_APPLIED`; the in-memory implementation does
not, so test B can call `applyPlan` twice. Parity is required before CORE3 certification.

### D9 (LOW) — fingerprint implementations differ between the two repositories
Postgres used the broken replacer form; in-memory used plain `JSON.stringify(plan)`
(content-sensitive but key-order dependent). Neither is canonical. One canonical authority is
required (§2).

## 3. File classification

| File | Class | Action |
|---|---|---|
| `src/server/repositories/postgres/mission-repository.ts` | REPAIR | restore HEAD verbatim, re-apply semantic deltas surgically; fix D1 |
| `src/server/services/in-memory/mission-repository.ts` | REPAIR | fix D2, D3, D4, D8, D9 |
| `src/server/database/schema.ts` | REPAIR | restore predecessorPlanId + FK from stash@{0}; add planFingerprint; fix unused import (D5) |
| `src/core/contracts/autonomous-plan.ts` | KEEP+EXTEND | prefer stash `nullish()` over worktree `optional()`; add planFingerprint |
| `drizzle/0040_autonomous_plan_lineage.sql` | KEEP | table is created only by this migration; verified no earlier migration touches it |
| `drizzle/meta/_journal.json` | KEEP | idx 37 / tag 0040 entry is consistent |
| `src/server/usecases/ignite-autonomous-mission.test.ts` | KEEP | legitimate: goalId is now required |
| `src/server/usecases/phase6-autonomous-e2e.test.ts` | KEEP | legitimate: goalId is now required |
| `.../__tests__/mission-repository-lineage.test.ts` | REPAIR | remove fake placeholders, fix F, assert real lineage (D6, D7) |
| `original.ts` | SESSION_RESIDUE | delete; byte-identical to HEAD, recoverable from git |
| `stash@{0}` | KEEP (harvested) | schema columns + FK harvested into the repair; do not drop until M1 is committed |
| `stash@{1}`, `stash@{2}` | UNRELATED | belong to `feat/phase-7a-scheduler`; left untouched |

## 4. Baseline facts

- `pnpm run typecheck`: **FAIL**, 5 errors (4x missing `planFingerprint` on the Drizzle table,
  1x `'mission' is possibly 'null'` in the lineage test). Recorded pre-repair.
- No `git reset --hard` was used. No stash was popped or dropped.

## 5. Integrity conclusion

Repository integrity is **restorable without loss**. The uncommitted work contains genuine,
wanted CORE3 semantics (fingerprint-based idempotency, immutable predecessor lineage) mixed
with a broken fingerprint implementation, an identity-model violation, schema drift and fake
test evidence. Nothing of value is missing from disk: every lost piece exists either in HEAD,
in `original.ts`, or in `stash@{0}`.
