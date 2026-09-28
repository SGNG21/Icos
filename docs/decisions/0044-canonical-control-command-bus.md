# 0044: One control command bus, durable runtime flags, and admission holds

## Status

Accepted (owner-validated design, 2026-09-28)

## Context

The Control Center needs to pause, resume and cancel missions, disable and enable workers,
and put ICOS into safe mode. Until now nothing could do that safely: there was no durable
place for a runtime flag, no state version to detect a stale click, no fresh-authentication
proof for a dangerous action, and nothing in dispatch, recovery or integration that would
honour a "stop" even if one existed. Cockpit backend requirements BR-10, BR-11, BR-12, BR-18.

Two properties of the existing runtime shaped the design:

1. **Callers disagree about what a failed `dispatch()` means.** The supervisor leaves the
   attempt PREPARED "so a later recovery can safely retry"; `create-and-dispatch-task`
   reports `dispatch_failed`; recovery records worker failures. A stop implemented as a
   throwing dispatcher would therefore turn safe mode into spurious task failures and
   burned retry budgets.
2. **Mission status writes are last-write-wins** (`updateMissionStatus` is an unconditional
   UPDATE), while the canonical machine declares `cancelled` terminal. A cancel racing an
   in-flight completion could be silently undone.

## Decision

### 1. One authority: `ControlCommandBus`

Every control mutation is a `ControlCommand` handled by `src/server/control/command-bus.ts`,
reachable only through `POST /api/control/commands`. The pipeline is fixed:

authenticate → validate (Zod) → authorize (permission + operational scope) → classify risk →
check auth freshness / re-auth proof → idempotency → lock target version → state validation →
admission → execution through the EXISTING authority → durable result + audit → new version.

- **Command id** is derived on the server from `(actor, idempotencyKey)`; the client never
  chooses it. A replay returns the stored result (`replayed: true`); the same key with a
  different payload is `IDEMPOTENCY_KEY_REUSED`. Rejections are stored and replayed too: an
  idempotency key names one attempt.
- **Internal effects** (holds, flags) are applied in the same transaction as the command
  record, the audit entry and the version bump.
- **External effects** (mission cancel, worker enable/disable) go through the canonical
  repositories/services after admission. The command is stored `ADMITTED` first; if the
  process dies before the outcome is stored, reading the command reconciles it against
  canonical state (the effect is idempotent and observable) or reports
  `UNKNOWN_EXECUTION_STATE`. It is never silently re-executed.
- **Every attempt that passed authentication is audited** (`control.command.*`), accepted or
  rejected, in the same transaction as its durable record. Unauthenticated attempts are
  already audited by `protectRoute` (`auth.access.denied`).

Supported commands — only those with canonical semantics: PAUSE_MISSION, RESUME_MISSION,
CANCEL_MISSION, DISABLE_WORKER, ENABLE_WORKER, ENTER_SAFE_MODE, EXIT_SAFE_MODE.
RETRY_TASK is deliberately absent (no canonical manual-retry semantics exist; see BR-23).

### 2. State versions (BR-11)

`control_state_versions(target_kind, target_id, version)` holds a monotonic control version
for every controllable target (`mission:<id>`, `worker:<id>`, `runtime:global`). Commands
carry `expectedVersion`; the bus takes `SELECT … FOR UPDATE` on the row, rejects a mismatch
with `VERSION_CONFLICT`, and bumps the version at admission. Two commands on the same
version serialize on that row lock: exactly one is admitted. The version counts control-plane
changes; canonical state is additionally validated (a mission already `succeeded` cannot be
cancelled whatever the version says).

### 3. Risk and re-authentication (BR-18)

| Risk     | Commands                                        | Requirement                                              |
| -------- | ----------------------------------------------- | -------------------------------------------------------- |
| LOW      | PAUSE_MISSION                                   | authenticated + authorized                               |
| MEDIUM   | RESUME_MISSION, DISABLE_WORKER, ENTER_SAFE_MODE | session issued < 12 h ago                                |
| HIGH     | ENABLE_WORKER, CANCEL_MISSION                   | password re-auth proof ≤ 5 min                           |
| CRITICAL | EXIT_SAFE_MODE                                  | re-auth proof ≤ 5 min + typed confirmation of the target |

`POST /api/control/reauth` verifies the password server-side (Better Auth `verifyPassword`
against the CURRENT session) and returns a random 256-bit token. Only its SHA-256 is stored,
bound to user and session, expiring after 5 minutes, consumed exactly once inside the
command transaction. No password or secret ever enters a command payload or the audit log.
`secondFactor` is carried in the policy as `"not_enforced"` so passkey/2FA can be required
for CRITICAL without changing the contract.

### 4. Runtime control flags (BR-12) and mission holds

`runtime_control_flags` is a single durable row: `safe_mode`, `dispatch_enabled`,
`integration_enabled`, `external_actions_enabled`, `version`. Effective flags:

- `safeMode` ⇒ effective dispatch, integration and external actions are all **false**;
- if the row cannot be read, **everything is false** (fail closed);
- running work is never terminated by a flag.

`mission_control_holds(mission_id)` is the durable pause (MissionStatus is NOT changed).
An unreadable hold is treated as held.

### 5. Enforcement at admission, backstop at the dispatcher

Guards sit where work is ADMITTED, and hold it instead of failing it:

- `SupervisorService.run`: no ready task is admitted (status bookkeeping continues);
- `SupervisorService.reconcilePreparedDispatches`: held attempts stay PREPARED;
- recovery sweeper orphan redispatch: deferred `CONTROL_HELD` (re-examined later);
- correction dispatch: the attempt is prepared and left PREPARED for reconciliation;
- QC retry dispatch (`composeAutonomyRuntime` → `dispatchPrepared`): the retry attempt stays PREPARED;
- `create-and-dispatch-task`: the dispatcher backstop refuses; the Task stays `draft` (this use case
  never fails a Task on dispatch refusal) and the caller is told the control plane held it.

The container's `taskExecution` carries an in-place backstop (`installDispatchBackstop`): its
`dispatch` refuses with `ControlHeldError` if a dispatch reaches it while dispatch is not allowed —
the last line of defence, reached only by a path that missed its admission guard. It is installed
IN PLACE rather than as a wrapper so the dispatcher keeps its concrete class: which dispatcher
production uses (Temporal vs runtime router) is a fact CORE3 certifies, and the control layer must
not change it.

`IntegrationGate.integrate` refuses with `CONTROL_HELD` when integration is not allowed.
`IntegrationApplier.apply` refuses when external actions are not allowed.
`assertExternalActionAllowed()` is the one guard every future irreversible external executor
(APIs, messages, deploys, publishing, spend, customer-system writes) must call.

### 6. Cancellation

CANCEL_MISSION uses the canonical machine (`isValidMissionTransition(current, "cancelled")`)
and a new optional compare-and-set `MissionRepository.transitionMissionStatusIf(id, from,
to)`, so it never overwrites a status that changed underneath it. Readiness already yields
no task for a cancelled mission. In-flight work is not killed: its result is recorded as
usual. Because every other `updateMissionStatus` caller is unconditional, the Postgres and
in-memory repositories now refuse to move a mission OUT of `cancelled` — the machine already
declares it terminal; this makes the database agree.

### 7. Worker enable

ENABLE_WORKER re-activates the registry entry AND resets its evidence to "never probed"
(`health/availability = unknown`, `lastProbeOutcome = never`). Routing requires a successful
probe, so an enabled worker routes nothing until a real probe passes.

## Consequences

- One additive migration (`0048_control_plane`; authored as 0047, renumbered after CORE3 `0047_audit_goal_events`): five new tables and an extended
  `audit_event_type_check`. Rollback: drop the five tables and restore the previous check.
  No existing row is modified.
- Shared CORE3 files receive one localized guard call each; the supervisor gains one optional
  constructor argument, wired at every production composition site.
- The cockpit contract is published in `src/core/control/contracts.ts`; wiring the cockpit is
  a later step (backend-only branch by decision).
