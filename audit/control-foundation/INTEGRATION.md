# CORE3 + control-foundation reconciliation (2026-09-28)

Owner decision: **CORE3 migration 0047 is canonical; the control-plane migration becomes 0048.**
This file is the durable record of that reconciliation. Re-verify hashes with `git log` before use.

| Item                           | Value                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Integration worktree           | `/Users/coco/icos-worktrees/core3-control-integration`                                                |
| Integration branch             | `integration/core3-control-foundation` (created from the CORE3 tip; CORE3 branch itself NOT modified) |
| Base CORE3 HEAD                | `18a51b8` (`feat/autonomy-core3-goal-planner-dag`)                                                    |
| control-foundation source HEAD | `6794e21` (`feat/control-foundation`, left unchanged)                                                 |
| Reconciliation merge           | `c04ee24` (parents `18a51b8`, `6794e21`)                                                              |
| Cockpit                        | NOT touched (`feat/cockpit-control-center` unchanged)                                                 |

## Final migration sequence (tail)

| idx | file                                           | origin                                            |
| --- | ---------------------------------------------- | ------------------------------------------------- |
| 43  | `0046_dispatch_execution_lease_and_resume.sql` | CORE3                                             |
| 44  | `0047_audit_goal_events.sql`                   | CORE3 — **unchanged, canonical**                  |
| 45  | `0048_control_plane.sql`                       | control foundation (authored as 0047, renumbered) |

46 migrations, numbers unique, journal idx 0..45 contiguous, `when` strictly increasing
(0047: 1790886402287, 0048: 1790886403287).

## Conflict resolutions

HIGH:

- `drizzle/meta/_journal.json` — CORE3's journal kept byte-for-byte; control appended as idx 45
  `0048_control_plane`. Diff vs CORE3 is a pure append.
- `drizzle/0047_control_plane.sql` → `drizzle/0048_control_plane.sql` (git rename). Because 0048 runs AFTER
  CORE3 0047 and both re-create `audit_event_type_check`, 0048's allow-list is now the exact UNION:
  CORE3 0047's 41 values + the 4 `control.command.*` values = 45 (verified mechanically: set equality,
  no duplicates). Header, data-safety and rollback notes updated (rollback must never drop `goal.*`).
- `src/server/database/schema.ts` — the CHECK literal is generated from 0048's list (45 values). CORE3's
  literal had drifted from the database (it lacked the three `task.execution.*` values the database allows);
  it now mirrors what migrations enforce. Control tables kept as authored.

MEDIUM (auto-merged, reviewed):

- `src/server/container.ts`, `src/server/repositories/postgres/mission-repository.ts` — verified that NO
  CORE3 line was removed; the only replaced lines are the intended control-plane changes (backstop install,
  gate/applier `control`, sticky-cancel predicate + CAS import).
- `src/server/system/production-services.ts`, `src/server/supervisor/supervisor-service.ts` — not changed
  by CORE3 since the branch point (`9472de7`); carry only the control-plane edits.

References updated to 0048: `schema.ts` comment, `postgres-control-store.ts` header, ADR 0044.
No test pins the migration count (both journal tests derive it from the journal).

## Admission re-audit (whole reconciled tree)

CORE3 commits since the branch point (`6ee81be`, `9444447`, `18a51b8`) add **no** dispatch, admission,
supervisor, integrate or apply call site. Every live `dispatch()` in the tree:

| Call site                                                              | Path                                       | Control                                               |
| ---------------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------- |
| `supervisor-service.ts` run loop (2 sites)                             | autonomous admission                       | explicit hold: held ⇒ no ready task admitted          |
| `supervisor-service.ts` `reconcilePreparedDispatches`                  | prepared replay                            | explicit hold: stays PREPARED                         |
| `workspace-execution-coordinator.ts` `executeInWorkspace`              | only called from the supervisor run loop   | covered by the run-loop hold                          |
| `recovery-actions.ts` `redispatch`                                     | only called from the sweeper orphan branch | explicit hold in the sweeper: `deferred CONTROL_HELD` |
| `record-mission-task-execution.ts` correction                          | correction                                 | explicit hold: stays PREPARED                         |
| `production-services.ts` QC `dispatchPrepared`                         | QC retry                                   | explicit hold: stays PREPARED                         |
| `runtime-dispatch-router.ts`, `composite-task-execution-dispatcher.ts` | dispatcher internals                       | beneath the backstop                                  |
| `create-and-dispatch-task.ts`                                          | **no production caller** (tests only)      | backstop only; Task stays draft                       |
| `phase6-e2e-harness.ts`                                                | test harness                               | n/a                                                   |

Integration: `governed-self-development-coordinator.ts` and `workspace-execution-coordinator.ts` call
`IntegrationGate.integrate` / `IntegrationApplier.apply`, both guarded inside the gate/applier.
The dispatcher backstop (`installDispatchBackstop`) remains the fail-closed fallback only.

Defect 28 (CORE3: "the gate runs before any independent review can exist") is **named as open upstream
and has no committed fix** at `18a51b8` — nothing to preserve or recertify. Note: the CORE3 worktree has
UNCOMMITTED edits to `supervisor-service.ts` and `workspace-execution-coordinator.ts` (apparently that
fix in progress). They were not read into this reconciliation; when they land, `supervisor-service.ts`
will need a re-merge (this branch adds an 8th optional constructor argument and two guard lines there).

## Migration proofs (fresh databases)

`node audit/control-foundation/migration-proofs.mjs` → **32/32 PASS**
(raw output: `audit/control-foundation/migration-proofs-results.txt`).

- Journal: no duplicate migration number (46 files), journal ↔ files bijection, idx contiguous, `when`
  strictly increasing, order 0047_audit_goal_events → 0048_control_plane.
- A. empty database: 46/46 applied; CHECK = 45 values incl. `goal.*` and `control.*`; all four `goal.*`
  inserts succeed; `control.command.executed` insert succeeds; an unknown event type is still rejected;
  5 control tables exist; flags row seeded to normal operation.
- B. upgrade: migrated through CORE3 0047 only (45 applied; `goal.*` allowed, `control.*` not yet, no
  control tables); four `goal.*` rows written; then full folder ⇒ exactly one more migration (45 → 46);
  CHECK = 45-value union; the pre-0048 `goal.*` rows survive; `goal.*` and `control.*` insertable; flags
  row seeded; re-running `migrate` is a no-op.

## Gates on the reconciled tree (`c04ee24` + this record)

| Gate                                                                                                                                                                                                                                 | Result                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| typecheck                                                                                                                                                                                                                            | PASS                                                                            |
| build                                                                                                                                                                                                                                | PASS                                                                            |
| `git diff --check 18a51b8..HEAD`                                                                                                                                                                                                     | PASS                                                                            |
| lint                                                                                                                                                                                                                                 | 0 errors, 289 warnings — identical to CORE3 `18a51b8` (289): adds 0             |
| unit                                                                                                                                                                                                                                 | 152 files, 1873 tests, 0 failed                                                 |
| integration (fresh `icos_core3ctl_test`, `pnpm test:integration`)                                                                                                                                                                    | 71 files (69 passed, 2 skipped), 466 tests: **463 passed, 0 failed, 3 skipped** |
| CORE3 regression + exactly-once, integration (orchestration, chaos certification, runner restart, supervisor ×9, recovery ×4, governed worker integration e2e, multiworker routing, QC postgres, e2e failure, scheduler, real probe) | 20 files, 127 tests, 0 failed                                                   |
| CORE3 regression + exactly-once, unit (supervisor, recovery, applier, self-dev coordinator e2e, QC sweeper, scheduler, autonomous route)                                                                                             | 14 files, 132 tests, 0 failed                                                   |
| control PostgreSQL (races, restart, whole-container restart, crash reconciliation, audit atomicity, fail-closed flags, safe mode in production graph, mission hold, cancel CAS)                                                      | 12/12                                                                           |
| control unit (bus, idempotency, re-auth single use, version conflicts, hold, safe mode, no-bypass, routes)                                                                                                                           | 57/57                                                                           |
| mutation suite                                                                                                                                                                                                                       | 17/17 killed by behavioural assertions, 0 invalid, 0 survived                   |

Skips (3, none from this branch):

- `live-external-worker.integration.test.ts` × 2 — live Hermes (same two as before).
- `self-development-e2e.integration.test.ts` × 1 — CORE3 M12 opt-in live E2E (`ICOS_SELF_DEV_E2E=1`),
  added upstream in `9444447`.

Environmental note: one earlier run of the same suite reported 16 skips — the 13 tests of
`user-agent-administration.integration.test.ts` are `describe.skipIf(!dockerAvailable)` and its Docker probe
failed while a unit run and a build were competing for the machine. The authoritative run above (nothing
else running) executed them all.

## Status after reconciliation

```
GOAL_AUDIT_EVENTS_DEFECT=FIXED (CORE3 0047, preserved and widened by 0048; proven on empty + upgrade DBs)
CONTROL_FOUNDATION_CERTIFIED=TRUE (re-proven on the reconciled tree)
CORE3_REGRESSION=PASS (no failures; defect 28 still open upstream, not introduced or changed here)
MIGRATION_COLLISION=RESOLVED on integration/core3-control-foundation (0047 CORE3, 0048 control)
```

Remaining backend requirements (unchanged, none closed): BR-23 manual RETRY_TASK, BR-24 integration
hold/re-drive (CORE3 decision), BR-25 re-auth rate limiting, BR-26 individual flag commands, BR-27 passkey
for CRITICAL; cockpit BR-01…09, BR-13…17, BR-19…22.
