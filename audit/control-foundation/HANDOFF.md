# Control Foundation — backend handoff (BR-10, BR-11, BR-12, BR-18)

Branch `feat/control-foundation`, based on CORE3 `feat/autonomy-core3-goal-planner-dag` @ `9472de7` (simulated merge with `6ee81be`: clean).
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

## Client rules (how the cockpit must use the contract)

- **idempotencyKey**: one fresh UUID per owner intent. Reuse it ONLY to retransmit the same request
  after a transport failure (timeout, dropped connection). The server derives `commandId` from
  (actor, key), so a retransmission can never execute twice: it returns the stored result
  (`replayed: true`) or, if the first request never arrived, executes once now. Never reuse a key for a
  different payload (`IDEMPOTENCY_KEY_REUSED`, 409).
- **Lost response**: the client does not know `commandId` until it receives a response, so the
  recovery is "retransmit with the SAME key", not "GET by id". `GET /api/control/commands/:commandId`
  is for commands whose response WAS received (e.g. to follow a 202).
- **A key names one attempt, including its rejection.** Any final rejection is replayed as-is for that
  key. To try again after fixing the cause (new version, new proof, confirmation), send a NEW key.
- **Stale version** (`VERSION_CONFLICT`, 409, body `version` = current): refetch
  `GET /api/control/state`, show the owner what changed, and only on a new explicit action send a new
  key with the new `expectedVersion`. Never auto-resend.
- **State changed** (`INVALID_TRANSITION` 409 at admission, or `FAILED` 409 after admission): nothing
  changed; refresh and re-evaluate. `FAILED` still bumped the version.
- **Unknown outcome** (`UNKNOWN_EXECUTION_STATE`, 202): do NOT send a new command. Poll
  `GET /api/control/commands/:commandId` (the id is in the 202 body) until it settles to `EXECUTED`; if
  it stays unknown, show it as unknown — the server never re-executes it implicitly.
- **Re-auth** (HIGH / CRITICAL): on `428` with `REAUTH_REQUIRED`, `REAUTH_EXPIRED` or `REAUTH_INVALID`,
  prompt for the password, `POST /api/control/reauth`, then send a NEW key with `reauthProof`. A proof
  lives 5 minutes, is bound to this user AND this session, and is consumed only by an ADMITTED command
  (a rejection such as `CONFIRMATION_REQUIRED` or `VERSION_CONFLICT` does not consume it). Keep it in
  memory only; never persist or log it. A wrong password returns 401 from `/reauth` (audited).
- **Session too old** (`SESSION_TOO_OLD`, 428, MEDIUM): the session is > 12 h old — sign in again.
- **Typed confirmation** (CRITICAL, `CONFIRMATION_REQUIRED`, 428): the owner must type exactly
  `confirmationPhrase(type, target)` = `"<TYPE> <kind>:<id>"`, today only `EXIT_SAFE_MODE runtime:global`.
- **Risk class comes from the server** (`COMMAND_SPECS` / `riskClass` in every result). The cockpit's
  local risk table must be replaced by it (e.g. CANCEL_MISSION is HIGH on the backend, MEDIUM in the
  current cockpit placeholder).
- **Route-level errors**: 401 (no/expired session or no session evidence), 403 (cross-origin or no
  `cockpit.read`), 503 `persistence_unavailable` (control plane not composed). Nothing is recorded.

## Proofs

Authoritative detail: `audit/control-foundation/STATE.md`.

- Unit: `pnpm test` → 151 files / 1865 tests, 0 failed.
- Integration (dedicated DB, never the shared `icos_test`):
  `ICOS_TEST_DATABASE_URL=postgres://$USER@localhost:5432/icos_control_test pnpm test:integration`
  → 70 files, 463 passed / 0 failed / 2 skipped (pre-existing live-Hermes tests, not this branch).
  Control PostgreSQL suites: 12 tests (races, restart, whole-container restart, crash reconciliation,
  audit atomicity, fail-closed flags, production composition, cancel CAS).
- Mutations: `python3 audit/control-foundation/mutation-proofs.py` → 17/17 killed by behavioural
  assertions, 0 invalid, 0 survived (`audit/control-foundation/mutation-results.txt`).
- Structure: `no-bypass.test.ts` — only the control store/schema touch control tables, only the bus
  writes holds/flags/versions/proofs, only the commands route executes, no client code imports
  server control code, no mutating verb on `/api/control/state`.

## Remaining backend requirements (open)

- **BR-23 — canonical manual RETRY_TASK.** Must define: eligible states; interaction with QC/repair
  retry budgets; attempt numbering; dispatch-ledger lineage; idempotency; workspace reuse vs new;
  stale/foreign owner handling; restart behaviour; audit; reviewer/integration consequences;
  exactly-once. No implementation now.
- **BR-24 — integration hold and re-drive (CORE3 decision needed).** With integration or external
  actions disallowed, the gate/applier refuse correctly, but `WorkspaceExecutionCoordinator` turns ANY
  refusal into workspace `blocked` + execution `failed`, and nothing re-drives integration later.
  Safe mode therefore protects the canonical branch but a result finished during safe mode is not
  integrated after exit. Deliberately NOT changed here (CORE3 semantics, actively evolving).
- **BR-25 — re-auth rate limiting.** `POST /api/control/reauth` is audited but not rate-limited.
- **BR-26 — per-flag commands.** `dispatchEnabled`, `integrationEnabled`, `externalActionsEnabled` are
  durable and enforced but only safe mode is commandable.
- **BR-27 — passkey / second factor for CRITICAL** (hook present, not enforced).
- Cockpit BR-01…09, BR-13…17, BR-19…22 remain open.

Pre-existing defect (separate): `goal.*` audit events are rejected by the database
`audit_event_type_check`, which makes `PostgresGoalRepository.create` fail — see STATE.md.

## Merge-conflict risk with CORE3

Per-file LOW/MEDIUM/HIGH table and the migration merge-time rule: `audit/control-foundation/STATE.md`
› "CORE3 merge risk". Simulated merge with CORE3 `6ee81be`: clean. Any dispatch path CORE3 adds after
this branch must get a control-hold admission check; the dispatcher backstop is only the fail-closed
fallback.

## Cockpit integration (later, on feat/cockpit-control-center — not started)

1. Replace `notWiredTransport` in `src/components/cockpit/command-button.tsx` with an HTTP transport:
   `submit` → `POST /api/control/commands` (retransmit with the SAME key on transport failure);
   follow a 202 with `GET /api/control/commands/:commandId`.
2. Map cockpit actions to backend commands:

   | Cockpit action           | Backend command                                                |
   | ------------------------ | -------------------------------------------------------------- |
   | `mission.pause`          | `PAUSE_MISSION`                                                |
   | `mission.resume`         | `RESUME_MISSION`                                               |
   | `mission.stop`           | `CANCEL_MISSION` (HIGH)                                        |
   | `worker.pause`           | `DISABLE_WORKER` (stops routing; does not kill running work)   |
   | `worker.resume`          | `ENABLE_WORKER` (HIGH; worker routes only after a fresh probe) |
   | `system.enter_safe_mode` | `ENTER_SAFE_MODE`                                              |
   | `system.exit_safe_mode`  | `EXIT_SAFE_MODE` (CRITICAL)                                    |

   Remain **NOT YET WIRED**: `worker.retry` (BR-23), `worker.stop` (no backend command terminates a
   running worker), `mission.change_priority` (no backend priority command), `system.pause_new_work`,
   `system.freeze_integrations`, `system.lock_self_modification` (BR-26), `system.stop_external_workers`
   (no backend command). ASK ICOS stays NOT YET WIRED (BR-17).

3. Read `expectedVersion` from `GET /api/control/state?missionId=…&workerId=…` (replace the `updatedAt`
   placeholder); `runtime.version` for safe-mode commands.
4. HIGH/CRITICAL: password prompt → `POST /api/control/reauth` → send `reauthProof`; CRITICAL also
   sends `confirmation = confirmationPhrase(type, target)`.
5. Show `status`, `rejection.code`, `reauth`, `version`, `auditEntryId` from the typed result.
6. System page: show `runtime.stored` / `effective` / `version` instead of `UNKNOWN (BR-12)`; `stored:
null` must render as "flags unreadable — everything effectively off".
7. Mission views: `missions[].held` from `/api/control/state`.
