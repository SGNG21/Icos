# Control Foundation — backend handoff (BR-10, BR-11, BR-12, BR-18)

Branch `feat/control-foundation`, rebased on CORE3 `feat/autonomy-core3-goal-planner-dag` @ `9472de7`.
Decision: `docs/decisions/0044-canonical-control-command-bus.md`. Backend only: the cockpit is NOT wired.
Re-verify HEAD with `git log --oneline -10` before trusting anything below.

## Status

| BR    | What                                                         | State                                    |
| ----- | ------------------------------------------------------------ | ---------------------------------------- |
| BR-10 | one canonical command bus                                    | done, proven                             |
| BR-11 | durable target versions, typed conflicts                     | done, proven (two connections, row lock) |
| BR-12 | durable runtime flags + mission holds, enforced at admission | done, proven (restart, fail closed)      |
| BR-18 | risk-based freshness + password re-auth proofs               | done, proven                             |

## Commands (only those with canonical runtime semantics)

| Command         | Risk     | Permission (+ scope)                 | Effect, through which authority                                                                  |
| --------------- | -------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| PAUSE_MISSION   | LOW      | `missions.write` + operational scope | durable hold row (MissionStatus unchanged)                                                       |
| RESUME_MISSION  | MEDIUM   | `missions.write` + scope             | hold removed                                                                                     |
| CANCEL_MISSION  | HIGH     | `missions.write` + scope             | `MissionRepository.transitionMissionStatusIf(from → cancelled)` after `isValidMissionTransition` |
| DISABLE_WORKER  | MEDIUM   | `agents.manage`                      | `WorkerRegistrationService.deactivate`                                                           |
| ENABLE_WORKER   | HIGH     | `agents.manage`                      | `WorkerRegistrationService.reactivate` (evidence reset to never-probed)                          |
| ENTER_SAFE_MODE | MEDIUM   | `config.manage`                      | flags row `safe_mode = true`                                                                     |
| EXIT_SAFE_MODE  | CRITICAL | `config.manage`                      | flags row `safe_mode = false`                                                                    |

Not implemented on purpose: RETRY_TASK (BR-23), per-flag toggles for dispatch/integration/external (BR-26).

## Risk model / re-auth (BR-18)

- LOW: authenticated + authorized.
- MEDIUM: Better Auth session `createdAt` < 12 h ago, else `SESSION_TOO_OLD`.
- HIGH: re-auth proof ≤ 5 min.
- CRITICAL: re-auth proof ≤ 5 min AND `confirmation` exactly `"<TYPE> <kind>:<id>"`
  (e.g. `EXIT_SAFE_MODE runtime:global`). `authRequirement().secondFactor` is the passkey hook
  (`"not_enforced"` today; `"required"` makes the bus reject).
- Proofs: `POST /api/control/reauth {password}` → Better Auth `verifyPassword` against the CURRENT
  session → 256-bit random token. Stored: SHA-256 only, bound to user + session id, 5-minute TTL,
  consumed atomically by the admitting transaction (single use; a rejection does not consume it).
  Password and proof never reach the audit log (tested).

## Semantics

- **Mission hold**: `mission_control_holds`. Held ⇒ no new task admitted for that mission; READY stays
  READY, PREPARED stays PREPARED, running work continues, nothing is marked failed. Unreadable ⇒ held.
- **Flags** (`runtime_control_flags`, one row): effective = stored, except `safeMode` ⇒ dispatch,
  integration, external actions all false; unreadable/missing row ⇒ everything false.
  `integrationEnabled` and `externalActionsEnabled` are separate (gate vs applier).
- **Admission points** (hold, never fail): `SupervisorService.run`, `reconcilePreparedDispatches`,
  recovery sweeper orphan redispatch (`deferred CONTROL_HELD`), correction dispatch, QC retry
  `dispatchPrepared`, `create-and-dispatch-task` (Task stays draft).
- **Backstop**: `installDispatchBackstop` on the container dispatcher (in place: its class is unchanged,
  which CORE3 certifies). Throws `ControlHeldError` only for a path that missed its admission guard.
- **Integration**: `IntegrationGate.integrate` throws `ControlHeldError` (`code: CONTROL_HELD`) before any
  workspace read/transition. **External actions**: `IntegrationApplier.apply` calls
  `assertExternalActionAllowed` first; every future irreversible executor (APIs, messages, deploys,
  publishing, spend, customer-system writes) MUST call `assertExternalActionAllowed` from
  `src/server/control/runtime-control.ts`.
- **Cancel**: compare-and-set against the status the bus validated; `FAILED` (not success) if it changed.
  `updateMissionStatus` never moves a mission out of `cancelled` (machine: terminal). In-flight work is
  not killed; readiness yields nothing for a cancelled mission.
- **Versions (BR-11)**: `control_state_versions(kind, id)`, starting at 0, +1 on every ADMITTED command
  (also when the canonical effect then FAILS). Rejected commands never bump. Serialized by
  `SELECT … FOR UPDATE`. The version counts control-plane changes; canonical state is validated
  separately (a `succeeded` mission cannot be cancelled whatever its version).
- **Idempotency**: `commandId = uuidv5-like(sha256(actorId, idempotencyKey))`. Same key + same payload ⇒
  stored result, `replayed: true` (rejections included — a key names one attempt). Same key + different
  payload ⇒ `IDEMPOTENCY_KEY_REUSED` (audited, original untouched). Duplicate races serialize on
  `pg_advisory_xact_lock(command id)`.
- **Unknown outcome**: canonical effects run after an `ADMITTED` record commits. If the process dies
  before the outcome is stored, the command reads `UNKNOWN_EXECUTION_STATE`; `GET` reconciles against
  canonical state (cancelled / inactive / active observed ⇒ `EXECUTED`). Never re-executed implicitly.
- **Audit**: `control.command.{rejected,admitted,executed,failed}` for every attempt that passed
  authentication, in the SAME transaction as the command record. Unauthenticated / cross-origin
  attempts are audited by `protectRoute` (`auth.access.denied`); invalid bodies from an authenticated
  actor as `control.command.rejected` with `code: INVALID_REQUEST`; failed re-auth as
  `auth.login.rejected invalid_credentials`.

## HTTP contract (types: `src/core/control/contracts.ts`)

All routes: authenticated session with `cockpit.read`; mutations are same-origin only (CSRF).

### `POST /api/control/commands`

Request (`controlCommandRequestSchema`, strict — unknown keys such as `actor`, `riskClass` are refused):

```json
{
  "idempotencyKey": "uuid",
  "type": "CANCEL_MISSION",
  "target": { "kind": "mission", "id": "…" },
  "expectedVersion": 3,
  "reason": "why (3–500 chars)",
  "reauthProof": "…",
  "confirmation": "…"
}
```

Response body is always `ControlCommandResult`:

```json
{ "commandId": "uuid", "type": "…", "target": {…}, "riskClass": "HIGH", "status": "EXECUTED",
  "reauth": "SATISFIED", "rejection": null, "expectedVersion": 3, "version": 4,
  "auditEntryId": "ctl-<commandId>-executed", "replayed": false, "createdAt": "…", "completedAt": "…" }
```

| status / rejection.code                                                                                       | HTTP                                                                   |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| EXECUTED                                                                                                      | 200                                                                    |
| UNKNOWN_EXECUTION_STATE                                                                                       | 202                                                                    |
| FAILED                                                                                                        | 409                                                                    |
| INVALID_REQUEST, TARGET_KIND_MISMATCH                                                                         | 422 (body-schema failures are 400 `invalid_input` with `auditEntryId`) |
| FORBIDDEN                                                                                                     | 403                                                                    |
| TARGET_NOT_FOUND (also out-of-scope)                                                                          | 404                                                                    |
| VERSION_CONFLICT (`version` = current), INVALID_TRANSITION, IDEMPOTENCY_KEY_REUSED                            | 409                                                                    |
| SESSION_TOO_OLD, REAUTH_REQUIRED, REAUTH_INVALID, REAUTH_EXPIRED, CONFIRMATION_REQUIRED                       | 428                                                                    |
| CONTROL_STATE_UNAVAILABLE                                                                                     | 503                                                                    |
| Route-level: 401 no/expired session or no session evidence, 403 cross-origin, 503 control plane not composed. |

### `GET /api/control/commands/:commandId`

Stored result (actor or owner/admin only, else 404). `ADMITTED` is reconciled; 202 while unknown.

### `POST /api/control/reauth`

`{ "password": "…" }` → 200 `{ "proof": "…", "expiresAt": "ISO" }` | 401 `unauthenticated`.

### `GET /api/control/state?missionId=…&workerId=…` (repeatable, ≤ 200 each)

```json
{ "runtime": { "stored": { "safeMode": false, "dispatchEnabled": true, "integrationEnabled": true,
                           "externalActionsEnabled": true } | null,
               "effective": { … }, "version": 0 },
  "missions": [ { "id": "…", "held": false, "version": 2 } ],
  "workers": [ { "id": "…", "version": 1 } ] }
```

Out-of-scope missions are omitted. `stored: null` ⇒ flags unreadable ⇒ everything effectively off.

## Migration

`drizzle/0047_control_plane.sql` — additive, idempotent. Five tables; flags row seeded to normal
operation (deploying it changes no behaviour until a command is issued); `audit_event_type_check`
replaced by a strict superset of the LIVE list. Rollback steps are in the file header. Not applied to
any live database. `schema.ts`'s audit CHECK, which had drifted from the database, now mirrors it.

## Proofs

- Unit: `pnpm test` → 151 files / 1865 tests. Control-specific: `src/server/control/*.test.ts`,
  `src/app/api/control/control-routes.test.ts`.
- Integration (dedicated DB, never the shared `icos_test`):
  `ICOS_TEST_DATABASE_URL=postgres://$USER@localhost:5432/icos_control_test pnpm test:integration`
  → 69 files / 462 passed / 2 skipped (pre-existing live-Hermes tests, not this branch).
  - concurrency: two pools, same version → exactly one EXECUTED, one VERSION_CONFLICT; duplicate id
    race → one row, one audit entry; concurrent proof reuse → one success.
  - restart: new pool/store/bus (and a whole new PostgreSQL container) sees the hold, versions and
    results; the held mission still admits nothing.
  - audit atomicity: a failure after the audit insert rolls both back.
- Mutations: `python3 audit/control-foundation/mutation-proofs.py` → 17/17 KILLED by assertion
  failures (version check, authorization, freshness/re-auth, proof single-use, hold guard, supervisor
  hold, safe mode, fail-closed read, gate guard, applier guard, backstop, audit write, idempotency,
  QC retry hold, cancel CAS, sticky cancelled, enable evidence reset).
- Structure: `no-bypass.test.ts` — only the control store/schema touch control tables, only the bus
  writes holds/flags/versions/proofs, only the commands route executes, no client code imports
  server control code, no mutating verb on `/api/control/state`.

## Remaining backend requirements (new)

- **BR-23 — canonical manual RETRY_TASK.** Must define: eligible states; interaction with QC/repair
  retry budgets; attempt numbering; dispatch-ledger lineage; idempotency; workspace reuse vs new;
  stale/foreign owner handling; restart behaviour; audit; reviewer/integration consequences;
  exactly-once. No implementation now.
- **BR-24 — integration hold and re-drive (CORE3 decision needed).** With integration or external
  actions disallowed, the gate/applier refuse correctly, but `WorkspaceExecutionCoordinator` turns ANY
  refusal into workspace `blocked` + execution `failed`, and nothing re-drives integration later.
  Safe mode therefore protects the canonical branch but a result finished during safe mode is not
  integrated after exit. Needs: a held state for completed workspaces and a re-drive when released.
  Deliberately NOT changed here (CORE3 semantics, actively evolving).
- **BR-25 — re-auth rate limiting.** `POST /api/control/reauth` is audited but not rate-limited.
- **BR-26 — per-flag commands.** `dispatchEnabled`, `integrationEnabled`, `externalActionsEnabled` are
  durable and enforced but only safe mode is commandable; individual toggles need commands + risk.
- **BR-27 — passkey / second factor for CRITICAL** (hook present, not enforced).

Pre-existing defects observed (not fixed, not in scope): `goal-repository.ts` writes `goal.*` audit
events that the database CHECK does not allow; the Zod audit enum and the DB constraint disagree.

## Merge-conflict risk with CORE3

Shared files edited (all small, localized): `container.ts` (control composition, backstop, gate/applier
`control`), `supervisor-service.ts` (optional 8th ctor arg + two guard lines), `production-services.ts`
(guard wiring + QC hold), `runtime-recovery-sweeper.ts` + `compose-runtime-recovery.ts`,
`integration-gate.ts`, `integration-applier.ts`, `record-mission-task-execution.ts`,
`create-and-dispatch-task.ts`, `mission/ports.ts` + both mission repositories, `worker-registration-service.ts`,
`auth/ports.ts` + `authentication-service.ts`, `core/contracts/audit.ts`, `database/schema.ts`,
`drizzle/meta/_journal.json` (entry idx 44 — a CORE3 migration 0047 would collide: renumber on merge),
two API routes (`executions/completed`, `missions/autonomous`: one argument each).
CORE3 moved twice during this work; the branch was rebased each time with no conflict. Any NEW dispatch
site CORE3 adds must either go through an existing admission point or add a hold check (the backstop
will otherwise refuse it with a throw).

## Cockpit integration (later, on feat/cockpit-control-center)

1. Replace `notWiredTransport` in `src/components/cockpit/command-button.tsx` with an HTTP transport:
   `submit` → `POST /api/control/commands`; `status(commandId)` → `GET /api/control/commands/:id`
   (a 404 means `not_received`: resubmit the SAME idempotencyKey).
2. Map the cockpit's `COMMAND_ACTIONS` to the backend types; drop actions with no backend command
   (`worker.retry`, `mission.change_priority`, `system.pause_new_work`, `system.freeze_integrations`,
   `system.stop_external_workers`, `system.lock_self_modification` stay NOT YET WIRED — BR-23/26).
3. Read `expectedVersion` from `GET /api/control/state` (replace the `updatedAt` placeholder).
4. HIGH/CRITICAL: password prompt → `POST /api/control/reauth` → send `reauthProof`; CRITICAL also
   sends `confirmation = confirmationPhrase(type, target)`. Keep the proof in memory only.
5. Show `rejection.code` / `reauth` / `auditEntryId` from the typed result; `202` ⇒ UNKNOWN, then poll GET.
6. System page: show `runtime.stored` / `effective` / `version` instead of `UNKNOWN (BR-12)`.
7. Mission hold in mission views from `missions[].held`.
