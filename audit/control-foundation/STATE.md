# Control Foundation — durable certification state

A replacement worker must be able to continue from this file alone.
Re-verify every hash below with `git log` before trusting it.

- Worktree: `/Users/coco/icos-worktrees/control-foundation`
- Branch: `feat/control-foundation` (backend only; NOT merged into CORE3; cockpit NOT wired)
- Base: CORE3 `feat/autonomy-core3-goal-planner-dag` @ `9472de7` (merge-base)
- Decision: `docs/decisions/0044-canonical-control-command-bus.md`
- Cockpit contract: `audit/control-foundation/HANDOFF.md`
- MILESTONE: control foundation — CLOSED (this file's commit is the closure commit)

## Certification

| BR    | Scope                                           | Status   |
| ----- | ----------------------------------------------- | -------- |
| BR-10 | canonical command bus                           | **PASS** |
| BR-11 | durable state versions, typed conflicts         | **PASS** |
| BR-12 | durable runtime flags + mission holds, enforced | **PASS** |
| BR-18 | risk-based freshness + password re-auth proofs  | **PASS** |

```
COMMAND_BUS_CERTIFIED=TRUE
STATE_VERSIONING_CERTIFIED=TRUE
RUNTIME_CONTROL_FLAGS_CERTIFIED=TRUE
REAUTH_CERTIFIED=TRUE
CONTROL_FOUNDATION_CERTIFIED=TRUE
```

`CONTROL_FOUNDATION_CERTIFIED=TRUE` covers exactly the seven commands below, on PostgreSQL:
commands (unit + route + PostgreSQL), restart (new store and whole new container), concurrency
(two independent connections), crash (ADMITTED on PostgreSQL, reconciled, never re-executed),
audit (same-transaction, rollback-proven), mutations (17/17 behavioural kills), production
composition (the real `buildPostgresContainer` graph). It does NOT claim anything in the open
requirements (BR-23…BR-27) — in particular BR-24: work finished while integration is held is refused
correctly but not re-driven after release.

## Milestone commits (oldest first)

| Commit    | Content                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `5ae3436` | domain contract, `ControlCommandBus`, in-memory store, runtime guards, re-auth proofs                                        |
| `4f42ec0` | migration `0047_control_plane` + `PostgresControlStore` (row locks, advisory lock)                                           |
| `197fd40` | ADR renumbered 0043 → 0044 (0043 was taken by CORE3 D1)                                                                      |
| `f1e0114` | enforcement at admission points, gate/applier guards, cancel CAS, worker reactivate, auth evidence, HTTP routes, composition |
| `de73900` | cancel CAS race test (closed a surviving mutation) + mutation harness                                                        |
| `8b54275` | dispatch backstop installed in place (preserves CORE3-certified dispatcher identity)                                         |
| `c299b68` | unused import                                                                                                                |
| `0d459db` | QC retry dispatch held at admission (5th path, found after rebasing on M11)                                                  |
| `a0412ae` | backend handoff                                                                                                              |
| closure   | this STATE.md, PostgreSQL crash-reconciliation test, mutation results, HANDOFF client rules                                  |

## Migrations

Introduced: `drizzle/0047_control_plane.sql` + journal entry idx 44 (`when` 1790800003287). Nothing else.

Collision status (2026-09-28, CORE3 tip `6ee81be`): **no collision**. The only branch in the repository
containing a `0047_*` migration is this one; CORE3 tops out at `0046_dispatch_execution_lease_and_resume`.
Not renumbered.

**Merge-time rule:** if, at merge time, both sides contain a migration numbered 0047, renumber exactly
ONE of them (which one depends on the actual merge topology — decide then, not now), update
`drizzle/meta/_journal.json` consistently (contiguous `idx`, strictly increasing `when`, tag = file
name), then run `migration-journal.test.ts` and the full integration suite on a fresh database before
integrating.

## Supported command matrix

Common to every command:

- **auth**: authenticated session with `cockpit.read`; mutation route same-origin only; Better Auth
  session evidence (id + issue time) required, else 401 and nothing is recorded.
- **expectedVersion**: must equal the target's current control version (`GET /api/control/state`);
  otherwise `REJECTED / VERSION_CONFLICT` (HTTP 409) with `version` = current value, nothing changed,
  version not bumped. Every ADMITTED command bumps the version by 1 (also when its canonical effect then
  FAILS). Rejections never bump.
- **idempotency**: `commandId` derived from (actor, idempotencyKey). Same key + same payload ⇒ stored
  result with `replayed: true` (success AND rejection). Same key + different payload ⇒
  `IDEMPOTENCY_KEY_REUSED` (409, audited, original untouched).
- **audit**: every authenticated attempt writes `control.command.*` in the SAME transaction as the
  durable command record (`rejected` | `executed`, or `admitted` then `executed`/`failed`).
- **restart**: result, version and effect are durable; a replay after restart returns the stored result.
- **success**: HTTP 200, `status: "EXECUTED"`, `version` = new version, `auditEntryId`.
- **rejections common to all**: `FORBIDDEN` 403, `TARGET_KIND_MISMATCH` 422, `VERSION_CONFLICT` 409,
  `IDEMPOTENCY_KEY_REUSED` 409, `INVALID_TRANSITION` 409; body-schema failure 400 `invalid_input`
  (audited as `INVALID_REQUEST`).

| Command         | Risk     | Permission                           | Extra auth                                                                                                 | Canonical state mutated                                                                                                                                                                                          | Specific rejections                                                                                                                                                                                                                      |
| --------------- | -------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAUSE_MISSION   | LOW      | `missions.write` + operational scope | none                                                                                                       | inserts `mission_control_holds` row, atomic with record/audit/version (MissionStatus unchanged)                                                                                                                  | `TARGET_NOT_FOUND` 404 (unknown or out of scope); `INVALID_TRANSITION` if terminal or already paused                                                                                                                                     |
| RESUME_MISSION  | MEDIUM   | `missions.write` + scope             | session < 12 h                                                                                             | deletes the hold row, atomic                                                                                                                                                                                     | `SESSION_TOO_OLD` 428; `INVALID_TRANSITION` if not paused                                                                                                                                                                                |
| CANCEL_MISSION  | HIGH     | `missions.write` + scope             | re-auth proof ≤ 5 min, single use                                                                          | `missions.status` via `MissionRepository.transitionMissionStatusIf(validated → cancelled)` after `isValidMissionTransition`; two-phase (ADMITTED then outcome)                                                   | `REAUTH_REQUIRED` / `REAUTH_INVALID` / `REAUTH_EXPIRED` 428; `INVALID_TRANSITION` if the machine forbids; **FAILED** 409 if status changed underneath (nothing written); **UNKNOWN_EXECUTION_STATE** 202 if the effect's outcome is lost |
| DISABLE_WORKER  | MEDIUM   | `agents.manage`                      | session < 12 h                                                                                             | worker registry `status = inactive` via `WorkerRegistrationService.deactivate`; two-phase                                                                                                                        | `TARGET_NOT_FOUND`; `SESSION_TOO_OLD`; `INVALID_TRANSITION` if not active; UNKNOWN 202                                                                                                                                                   |
| ENABLE_WORKER   | HIGH     | `agents.manage`                      | re-auth proof                                                                                              | `WorkerRegistrationService.reactivate`: `status = active` AND evidence reset (`health/availability = unknown`, `lastProbeOutcome = never`, `lastProbeAt = null`) ⇒ routes nothing before a real probe; two-phase | `REAUTH_*` 428; `INVALID_TRANSITION` if already active; UNKNOWN 202                                                                                                                                                                      |
| ENTER_SAFE_MODE | MEDIUM   | `config.manage`                      | session < 12 h                                                                                             | `runtime_control_flags.safe_mode = true`, atomic                                                                                                                                                                 | `SESSION_TOO_OLD`; `INVALID_TRANSITION` if already on                                                                                                                                                                                    |
| EXIT_SAFE_MODE  | CRITICAL | `config.manage`                      | re-auth proof + `confirmation` exactly `EXIT_SAFE_MODE runtime:global` (second-factor hook `not_enforced`) | `safe_mode = false`, atomic                                                                                                                                                                                      | `REAUTH_*` 428; `CONFIRMATION_REQUIRED` 428 (proof NOT consumed); `INVALID_TRANSITION` if off                                                                                                                                            |

Two-phase commands (CANCEL/DISABLE/ENABLE): the record is committed `ADMITTED` (+ `admitted` audit,
version bumped) BEFORE the canonical effect runs; the outcome is stored with `executed`/`failed`
audit. If the outcome is lost, `GET /api/control/commands/:id` reconciles by observing canonical
state (`cancelled` / `inactive` / `active`) and otherwise answers `UNKNOWN_EXECUTION_STATE`. The effect
is never re-run implicitly — replaying the same request returns the stored ADMITTED/UNKNOWN result.

**RETRY_TASK is not supported** (no canonical manual-retry semantics exist) — open as BR-23.

## Runtime control semantics

Stored flags (`runtime_control_flags`, single row `global`): `safeMode`, `dispatchEnabled`,
`integrationEnabled`, `externalActionsEnabled`. Effective (`effectiveFlags`, `src/core/control/policy.ts`):

| Stored state              | dispatch            | integration            | external actions                               |
| ------------------------- | ------------------- | ---------------------- | ---------------------------------------------- |
| normal (`safeMode=false`) | = `dispatchEnabled` | = `integrationEnabled` | = `externalActionsEnabled`                     |
| `safeMode=true`           | **false**           | **false**              | **false**                                      |
| row missing / unreadable  | **false**           | **false**              | **false** (reason `CONTROL_STATE_UNAVAILABLE`) |

Mission hold: held ⇒ that mission admits no new work; unreadable hold ⇒ held.
Running work is never terminated by a flag or a hold. Only `safeMode` is commandable today (BR-26).
Proven: `runtime-control.test.ts` "safe mode forces dispatch, integration and external actions off",
"an unreadable flags row turns everything off", "does not collapse integration and external actions";
PostgreSQL: `postgres-control-store.integration.test.ts` "fails closed when the flags row is missing",
`postgres-composition.integration.test.ts` "safe mode refuses dispatch, integration and applier writes in the production graph".

### Enforcement points wired today

Admission (preferred — work is HELD, never failed):

1. `SupervisorService.run` — no ready task admitted for a held mission / when dispatch is not allowed;
   status bookkeeping still runs (`src/server/supervisor/supervisor-service.ts`).
2. `SupervisorService.reconcilePreparedDispatches` — held attempts stay PREPARED.
3. `RuntimeRecoverySweeper` orphan redispatch — verdict `deferred / CONTROL_HELD`
   (`src/server/recovery/runtime-recovery-sweeper.ts`, wired via `compose-runtime-recovery.ts`).
4. Correction dispatch — attempt left PREPARED (`src/server/usecases/record-mission-task-execution.ts`).
5. QC retry `dispatchPrepared` — attempt left PREPARED (`src/server/system/production-services.ts`,
   `composeAutonomyRuntime`).
6. `create-and-dispatch-task` — Task stays `draft`, caller told the control plane held it.
   Supervisor guard is wired at every production construction site: `production-services.ts`,
   `app/api/internal/executions/completed/route.ts`, `app/api/missions/autonomous/route.ts`.

Last line (fail-closed FALLBACK, not the preferred behaviour): `installDispatchBackstop` on the
container's `taskExecution` (memory + PostgreSQL) — `dispatch` throws `ControlHeldError` if a dispatch
reaches it while not allowed. Installed in place so the dispatcher's concrete class is unchanged.

IntegrationGate: `integrate()` throws `ControlHeldError` (`code: "CONTROL_HELD"`) when
`guard.integration()` is not allowed, before any workspace read or transition.

IntegrationApplier: `apply()` calls `assertExternalActionAllowed` first (external actions), before
any read or git operation.

Future external-action guard (exported, canonical): `assertExternalActionAllowed(guard, action)` in
`src/server/control/runtime-control.ts`. Every future irreversible executor (external APIs, messages,
deployment, publishing, spend, customer-system writes) must call it. No such executor exists yet.

## Restart / crash / concurrency evidence (PostgreSQL unless noted)

| Property                                                                                                                                                                         | Test                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| same-version race: exactly one EXECUTED, other VERSION_CONFLICT, two pools                                                                                                       | `src/server/control/postgres-control-store.integration.test.ts` › "serializes conflicting commands from two independent connections: exactly one wins"                                                                                                                                       |
| duplicate command-id race: one row, one audit entry, one `replayed`                                                                                                              | same file › "dedupes the same command id racing on two connections"                                                                                                                                                                                                                          |
| single-use proof race: one success, token never stored                                                                                                                           | same file › "consumes a re-auth proof exactly once, even under concurrency"                                                                                                                                                                                                                  |
| restart with new pool / store / bus                                                                                                                                              | same file › "persists holds, versions and results across a restart (new pool, new store, new bus)"                                                                                                                                                                                           |
| restart with a whole new PostgreSQL container; held mission still admits nothing, stays unfailed                                                                                 | `src/server/control/postgres-composition.integration.test.ts` › "a mission hold survives a full container restart and still admits nothing"                                                                                                                                                  |
| crash after admission: ADMITTED row, UNKNOWN on a new pool, replay does not re-run the effect (1 call), reconciled to EXECUTED from canonical state, audit `admitted`+`executed` | `postgres-control-store.integration.test.ts` › "crash after admission: UNKNOWN on a new pool, never re-executed, reconciled from canonical state" (in-memory twin: `command-bus.test.ts` › "reports UNKNOWN_EXECUTION_STATE, never retries implicitly, and reconciles from canonical state") |
| audit atomic with the command (rollback proven)                                                                                                                                  | `postgres-control-store.integration.test.ts` › "writes the audit entry in the same transaction as the command record"                                                                                                                                                                        |
| production graph composes store, backstop, gate/applier guards                                                                                                                   | `postgres-composition.integration.test.ts` › "composes one durable control plane behind the runtime dispatcher", "safe mode refuses dispatch, integration and applier writes in the production graph"                                                                                        |
| cancel CAS + sticky `cancelled` on the real repository                                                                                                                           | `postgres-composition.integration.test.ts` › "the mission repository compare-and-set never overwrites a changed status, and cancelled is sticky"                                                                                                                                             |
| no bypass (static)                                                                                                                                                               | `src/server/control/no-bypass.test.ts` (5 tests)                                                                                                                                                                                                                                             |
| HTTP (401, CSRF 403, no evidence, 403 FORBIDDEN audited, 400 audited, 409 stale, 428 → reauth → 200)                                                                             | `src/app/api/control/control-routes.test.ts` (8 tests)                                                                                                                                                                                                                                       |

## Mutation evidence

Harness: `python3 audit/control-foundation/mutation-proofs.py` (removes one check, runs the control unit
suites — 57 tests in `src/server/control`, `src/app/api/control`, `src/core/control` — restores the
file). A mutation that fails to compile is reported `INVALID MUTATION` and is NOT counted as a kill.
Raw output of the final run: `audit/control-foundation/mutation-results.txt`.

| #   | Target                                 | Final result          |
| --- | -------------------------------------- | --------------------- |
| 1   | state version check                    | KILLED (3 assertions) |
| 2   | authorization                          | KILLED (4)            |
| 3   | re-auth / freshness                    | KILLED (6)            |
| 4   | proof single-use                       | KILLED (1)            |
| 5   | mission hold check (guard)             | KILLED (5)            |
| 6   | hold check (supervisor admission)      | KILLED (4)            |
| 7   | safe-mode guard                        | KILLED (1)            |
| 8   | fail-closed read                       | KILLED (3)            |
| 9   | integration guard (gate)               | KILLED (1)            |
| 10  | external-action guard (applier)        | KILLED (1)            |
| 11  | dispatcher backstop                    | KILLED (2)            |
| 12  | audit write                            | KILLED (7)            |
| 13  | idempotency                            | KILLED (3)            |
| 14  | QC retry hold (production composition) | KILLED (1)            |
| 15  | cancel compare-and-set                 | KILLED (1)            |
| 16  | sticky cancelled                       | KILLED (1)            |
| 17  | enable resets evidence                 | KILLED (1)            |

**Final: 17/17 killed by behavioural assertion failures; 0 invalid; 0 survived.**

History (not counted in the final number):

- Gap found and fixed: in the first battery **cancel compare-and-set SURVIVED** (no test drove the real
  effects adapter under a status race). Fixed by a test in `de73900`.
- Invalid mutation corrected: the first **audit write** mutation did not compile (trailing comma in
  `void (…,)`); it had been reported as a kill. The harness now detects transform/syntax failures; the
  mutation was rewritten to a compiling no-op and is now a genuine kill.
- Pattern repaired: **dispatcher backstop** matched nothing after formatting; pattern updated.
- Gap found by review, not by mutation: the QC retry `dispatchPrepared` path had no admission hold
  (found after rebasing onto CORE3 M11). Fixed in `0d459db`; mutation #14 added.
- Scope limit: the harness mutates source and runs the UNIT suites; PostgreSQL-only behaviour (row locks,
  advisory lock, SQL CAS) is covered by the integration tests above, not by mutation.

## Final gates (on the closure content)

| Gate                                        | Result                                                                     |
| ------------------------------------------- | -------------------------------------------------------------------------- |
| `pnpm typecheck`                            | PASS                                                                       |
| `pnpm build`                                | PASS (routes `/api/control/{commands,commands/[id],reauth,state}` dynamic) |
| `git diff --check` (merge-base..HEAD)       | PASS                                                                       |
| `pnpm lint`                                 | 0 errors, 289 warnings — identical to the merge base (289); branch adds 0  |
| unit `pnpm test`                            | 151 files, 1865 tests, 0 failed                                            |
| integration (dedicated `icos_control_test`) | 463 passed, 0 failed, 2 skipped (pre-existing live-Hermes)                 |
| control PostgreSQL suites                   | 2 files, 12 tests, 0 failed                                                |
| mutation suite                              | 17/17 killed                                                               |

Integration: `ICOS_TEST_DATABASE_URL=postgres://$USER@localhost:5432/icos_control_test pnpm test:integration`
→ 70 files (69 passed, 1 skipped), 465 tests: **463 passed, 0 failed, 2 skipped**, exit 0.

Skips: exactly two, both pre-existing and unrelated to this branch —
`src/server/workers/execution/live-external-worker.integration.test.ts` › "LAUNCHES A REAL HERMES AGENT
non-interactively and reads back the injected task" and "records which live runtimes were available,
so the evidence is unambiguous" (require a live Hermes). This branch adds no `skip`/`only`/`todo`.

## Open backend requirements (none closed silently)

Cockpit list (`feat/cockpit-control-center:audit/cockpit-control-center/BACKEND_REQUIREMENTS.md`):
BR-01…BR-09, BR-13…BR-17, BR-19…BR-22 remain OPEN. BR-10, BR-11, BR-12, BR-18: done on this branch.

Opened by this milestone (all OPEN, not started):

- BR-23 manual RETRY_TASK semantics (eligible states, retry budgets, attempt numbering, ledger lineage,
  idempotency, workspace reuse, stale/foreign owners, restart, audit, reviewer/integration effects,
  exactly-once).
- BR-24 integration hold / re-drive (CORE3 decision: coordinator turns any refusal into `blocked` +
  `failed`; nothing re-drives integration after release).
- BR-25 re-auth rate limiting (`POST /api/control/reauth` audited, not limited).
- BR-26 individual runtime flag commands (only safe mode is commandable).
- BR-27 passkey / second factor for CRITICAL (hook `secondFactor: "not_enforced"`).

## Pre-existing defect (separate, not fixed)

`goal.*` audit events: `src/server/repositories/postgres/goal-repository.ts` appends `goal.created`
(and other `goal.*`) to `audit_entries`, and the Zod `auditEventTypeSchema` allows them, but the database
`audit_event_type_check` (last defined by migration 0008, extended as a strict superset by 0047) does
NOT allow `goal.*`. Verified 2026-09-28 on `icos_control_test` (rolled-back transaction): inserting
`event_type = 'goal.created'` fails with `violates check constraint "audit_event_type_check"`. Because
`PostgresGoalRepository.create` inserts the goal, its preview and that audit row in ONE transaction,
goal creation itself fails on PostgreSQL. Migration 0047 intentionally did not add `goal.*` (out of
scope; it would change unrelated behaviour). Owner: goal intake / CORE3.

## CORE3 merge risk

Simulated merge with CORE3 tip `6ee81be` (`git merge-tree`, no ref created): **clean, 0 conflicts**.
On the simulated merged tree: unit 152 files / 1873 tests passed. `tsc` reports 2 errors in
`src/server/autonomy/hermes-planner-provider.test.ts:77` — **identical on the CORE3 tip alone**
(CORE3 M12's own type error, not caused by this branch); no merge-induced type error.

| File                                                                                             | Change here                                                                          | CORE3 activity                                                                          | Risk                             | Why                                                                                   |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------- |
| `drizzle/meta/_journal.json`                                                                     | +1 entry (idx 44)                                                                    | none since base                                                                         | HIGH _if_ CORE3 adds a migration | any new CORE3 migration takes idx 44 / number 0047 → apply the merge-time rule        |
| `src/server/container.ts`                                                                        | control composition, backstop, gate/applier `control` (+53/−6)                       | touched in 4 of last 10 CORE3 commits, incl. M12 after base (auto-merges cleanly today) | MEDIUM                           | hottest shared file; both sides edit the Postgres builder                             |
| `src/server/system/production-services.ts`                                                       | supervisor guard arg, sweeper `control`, QC hold (+11)                               | M11 rewrote `composeAutonomyRuntime`                                                    | MEDIUM                           | CORE3 adds new runtime paths here — each new dispatch path needs a hold               |
| `src/server/repositories/postgres/mission-repository.ts`                                         | `transitionMissionStatusIf`; `updateMissionStatus` never leaves `cancelled` (+16/−2) | 2 recent CORE3 commits                                                                  | MEDIUM                           | small textual change but a SEMANTIC change for every status writer (sticky cancelled) |
| `src/server/database/schema.ts`                                                                  | 5 tables + audit CHECK mirror (+81/−1)                                               | CORE3 adds tables periodically                                                          | MEDIUM                           | append region + the audit CHECK literal both edited by future migrations              |
| `src/server/supervisor/supervisor-service.ts`                                                    | optional 8th ctor arg + 2 guard lines (+21/−1)                                       | none recent                                                                             | MEDIUM                           | constructor signature + `run` readiness line are CORE3 hot spots when they change     |
| `src/server/mission/ports.ts`                                                                    | optional `transitionMissionStatusIf?` + doc (+14)                                    | 1 recent commit                                                                         | LOW                              | additive optional member                                                              |
| `src/server/services/in-memory/mission-repository.ts`                                            | CAS + sticky cancelled (+13)                                                         | 1 recent commit                                                                         | LOW                              | additive                                                                              |
| `src/server/recovery/runtime-recovery-sweeper.ts`, `compose-runtime-recovery.ts`                 | optional ctor arg + deferred verdict (+11, +3)                                       | none                                                                                    | LOW                              | additive, isolated case branch                                                        |
| `src/server/workspace-manager/integration-gate.ts`                                               | optional dep + first-line guard (+11)                                                | none                                                                                    | LOW                              | additive; BR-24 is the semantic open point, not a textual one                         |
| `src/server/workspace-manager/integration-applier.ts`                                            | optional dep + first-line guard (+11)                                                | none                                                                                    | LOW                              | additive                                                                              |
| `src/server/usecases/record-mission-task-execution.ts`                                           | optional dep + 1 guard (+6)                                                          | none                                                                                    | LOW                              | additive                                                                              |
| `src/server/usecases/create-and-dispatch-task.ts`                                                | truthful held message (+7/−2)                                                        | none                                                                                    | LOW                              | local catch block                                                                     |
| `src/server/services/worker-registry/worker-registration-service.ts`                             | `reactivate()` (+25)                                                                 | none                                                                                    | LOW                              | additive method                                                                       |
| `src/server/auth/ports.ts`, `authentication-service.ts`                                          | optional `readSessionEvidence`, `verifyPassword` (+9, +22)                           | none                                                                                    | LOW                              | additive optional members                                                             |
| `src/core/contracts/audit.ts`                                                                    | 4 event types (+5)                                                                   | none                                                                                    | LOW                              | enum append (append-order conflicts only)                                             |
| `src/app/api/internal/executions/completed/route.ts`, `src/app/api/missions/autonomous/route.ts` | one ctor argument each                                                               | none                                                                                    | LOW                              | one line                                                                              |
| `src/server/container.test.ts`                                                                   | backstop assertion (+6/−4)                                                           | none                                                                                    | LOW                              | test only                                                                             |

Standing rule: **any dispatch path CORE3 added after this branch was cut must be checked for a
control-hold admission check.** The dispatcher backstop is a fail-closed FALLBACK (it throws); it is
not the intended admission behaviour, and a path relying on it will surface holds as errors.

## Next step (not started)

Cockpit integration on `feat/cockpit-control-center`, per `HANDOFF.md` › "Cockpit integration": replace
`notWiredTransport` with the HTTP transport against `/api/control/commands`, read `expectedVersion` from
`/api/control/state`, implement the HIGH/CRITICAL re-auth prompt. Merge order and migration numbering to
be decided when the merge topology is known.
