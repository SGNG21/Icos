# Cockpit Control Center — Backend Requirements

The cockpit is a projection of ICOS, never a second authority. Every capability
below is **missing on the backend**; the UI renders it as `UNKNOWN`,
`NOT_AVAILABLE` or `NOT_YET_WIRED` until the canonical source exists. No UI
feature fabricates the value in the meantime.

Legend — BLOCKING: `yes` = the UI feature cannot show anything real without it;
`no` = the feature degrades honestly.

---

### BR-01 — Realtime event stream
- UI_FEATURE: live cockpit (C5), timeline auto-update, mobile push of P0 alerts
- NEEDED_DATA_OR_COMMAND: ordered, resumable event stream (`seq`, `type`, `occurredAt`, subject ids)
- EXPECTED_CANONICAL_SOURCE: audit log (`AuditRepository`) — already the append-only event authority
- RISK: low (read-only); must apply the same operational scope as `/api/audit`
- BLOCKING_OR_NOT: no — cockpit currently re-renders from server snapshots on an interval (`LiveRefresh`)
- SUGGESTED_INTERFACE: `GET /api/cockpit/events` (SSE) with `Last-Event-ID` = audit sequence; needs `AuditRepository.listSince(cursor, limit)` (current `query()` has no cursor → full scan)

### BR-02 — Runtime event vocabulary in the audit log
- UI_FEATURE: timeline (C8), system map flow states, WHY
- NEEDED_DATA_OR_COMMAND: `worker.started|health_changed|failed`, `task.ready|started|completed`, `review.required|rejected`, `integration.started|completed`, `mission.blocked`, `provider.degraded`, `improvement.proposed`
- EXPECTED_CANONICAL_SOURCE: `auditEventTypeSchema` (`src/core/contracts/audit.ts`) — today it only covers task/auth/admin/capability/skill/goal events
- RISK: medium (schema change owned by CORE3/runtime)
- BLOCKING_OR_NOT: no — timeline shows the events that exist
- SUGGESTED_INTERFACE: extend `auditEventTypeSchema`; emit from supervisor/dispatcher/integration gate

### BR-03 — Worker model / provider / account identity
- UI_FEATURE: worker cards (Worker ≠ Runtime ≠ Model ≠ Provider ≠ Account ≠ Capacity Slot)
- NEEDED_DATA_OR_COMMAND: `model`, `provider`, `account` per worker (not secrets — identifiers only)
- EXPECTED_CANONICAL_SOURCE: `WorkerRegistryEntry` (`src/core/contracts/worker-registry.ts`)
- RISK: low
- BLOCKING_OR_NOT: no — shown as NOT_AVAILABLE; `metadata` is shown verbatim as "declared, unverified"
- SUGGESTED_INTERFACE: typed optional fields `model`, `provider`, `accountRef` on the registry entry

### BR-04 — Provider health / latency / throughput
- UI_FEATURE: PROVIDERS view, overview PROVIDER HEALTH, LATENCY, TOKEN THROUGHPUT, system map flow intensity
- NEEDED_DATA_OR_COMMAND: per provider/account/model: health, p50/p95 latency, tokens/min, error rate, window
- EXPECTED_CANONICAL_SOURCE: provider gateway (OmniRoute) telemetry
- RISK: low
- BLOCKING_OR_NOT: yes for PROVIDERS view
- SUGGESTED_INTERFACE: `ProviderTelemetryPort.snapshot(): ProviderTelemetry[]`

### BR-05 — Cost / billing
- UI_FEATURE: COST (today, by provider/model/mission/client)
- NEEDED_DATA_OR_COMMAND: metered cost records with currency and source (billing vs estimate)
- EXPECTED_CANONICAL_SOURCE: FinOps ledger (does not exist)
- RISK: low; must never be estimated in the UI
- BLOCKING_OR_NOT: yes for COST
- SUGGESTED_INTERFACE: `CostLedgerPort.aggregate({ from, to, groupBy })`

### BR-06 — Autonomy score and level evidence
- UI_FEATURE: AUTONOMY view, overview AUTONOMY LEVEL
- NEEDED_DATA_OR_COMMAND: per-dimension autonomy measurement (planning, routing, recovery, review, integration, self-development, deployment) with evidence refs
- EXPECTED_CANONICAL_SOURCE: autonomy controller / self-development metrics (`SelfDevelopmentMetrics` exists but is not exposed on the container)
- RISK: low
- BLOCKING_OR_NOT: yes for the score; level is shown as UNKNOWN (never guessed)
- SUGGESTED_INTERFACE: `AutonomyAssessmentPort.current(): { level: "L0".."L6", dimensions: {...}, evidence: string[] }`

### BR-07 — Human intervention ledger (autonomy debt)
- UI_FEATURE: HUMAN INTERVENTIONS, MANUAL INTERVENTION DEBT
- NEEDED_DATA_OR_COMMAND: every manual action tagged as intervention (actor, reason, subject)
- EXPECTED_CANONICAL_SOURCE: audit log (`actor.kind = "human"` entries are a partial proxy; the cockpit counts them and labels them as such)
- RISK: low
- BLOCKING_OR_NOT: no
- SUGGESTED_INTERFACE: audit `details.intervention = true` + reason code

### BR-08 — Improvement candidates (ICOS improves ICOS)
- UI_FEATURE: SELF-DEVELOPMENT view
- NEEDED_DATA_OR_COMMAND: persisted `ImprovementCandidate` list with impact/risk/reversibility/effort/confidence/gains/state
- EXPECTED_CANONICAL_SOURCE: `ImprovementBacklog` (`src/core/autonomy/improvement-backlog.ts`) — only `InMemoryImprovementBacklog` exists, not on the container
- RISK: low (read-only)
- BLOCKING_OR_NOT: yes for SELF-DEVELOPMENT
- SUGGESTED_INTERFACE: `container.improvementBacklog.list()` backed by Postgres

### BR-09 — Routing decision evidence (WHY)
- UI_FEATURE: WHY this worker / provider / model / priority / retry
- NEEDED_DATA_OR_COMMAND: persisted routing decision: candidates considered, scores, rejected alternatives + reason, policy refs
- EXPECTED_CANONICAL_SOURCE: `CapabilityRouter` / `AISelectionEngine` decisions (computed, not persisted)
- RISK: low
- BLOCKING_OR_NOT: no — UI shows "WHY DATA NOT AVAILABLE"; review reasons (`ReviewDecisionRecord.reasons`) and dispatch `lastError`/`failureClass` are shown where they exist
- SUGGESTED_INTERFACE: `routing_decisions` table keyed by dispatch attempt id

### BR-10 — Governed command bus
- UI_FEATURE: PAUSE / RESUME / STOP / RETRY / CHANGE PRIORITY (workers, missions), ASK ICOS execution
- NEEDED_DATA_OR_COMMAND: single endpoint accepting `ControlCommand` (see `src/features/cockpit/commands.ts`) → authorization → policy → risk → state validation (`expectedStateVersion`) → execution → audit; idempotent on `idempotencyKey`; status query by `commandId`
- EXPECTED_CANONICAL_SOURCE: new command service (server), NOT the UI
- RISK: high — this is the mutation surface
- BLOCKING_OR_NOT: yes for all controls (all rendered NOT YET WIRED)
- SUGGESTED_INTERFACE: `POST /api/commands` → `{ status: "accepted"|"rejected"|"requires_confirmation"|"requires_reauth", commandId }`; `GET /api/commands/:commandId`

### BR-11 — State versions for optimistic concurrency
- UI_FEATURE: `expectedStateVersion` on every command
- NEEDED_DATA_OR_COMMAND: monotonic version on mission, mission task, worker registry entry
- EXPECTED_CANONICAL_SOURCE: repositories (today only `updatedAt` exists; the UI uses `updatedAt` as provisional version)
- RISK: medium
- BLOCKING_OR_NOT: blocks BR-10
- SUGGESTED_INTERFACE: `version: integer` column incremented on each write

### BR-12 — Emergency / safe mode
- UI_FEATURE: PAUSE NEW WORK, FREEZE INTEGRATIONS, STOP EXTERNAL WORKERS, LOCK SELF-MODIFICATION, ENTER SAFE MODE
- NEEDED_DATA_OR_COMMAND: durable global flags read by supervisor/dispatcher/integration gate/self-dev coordinator, + a read of current flag state
- EXPECTED_CANONICAL_SOURCE: runtime control flags table (does not exist)
- RISK: critical (must be fail-safe: flag read failure ⇒ no new dispatch)
- BLOCKING_OR_NOT: yes for SYSTEM › Emergency
- SUGGESTED_INTERFACE: `RuntimeControlPort.get(): { pauseNewWork, freezeIntegrations, stopExternalWorkers, lockSelfModification, safeMode, version }`; mutations via BR-10

### BR-13 — Fine-grained task lifecycle
- UI_FEATURE: DAG statuses READY / CLAIMED / DISPATCHED / VALIDATING / REPAIR_REQUIRED / READY_FOR_INTEGRATION / INTEGRATING / FAILED_RETRYABLE / FAILED_TERMINAL / ESCALATED / QUARANTINED
- NEEDED_DATA_OR_COMMAND: canonical lifecycle state per mission task
- EXPECTED_CANONICAL_SOURCE: `MissionTaskStatusSchema` has 10 coarse states; CORE3 owns the lifecycle
- RISK: low
- BLOCKING_OR_NOT: no — UI maps only what is provable (see `dag.ts` `deriveNodeStatus`); DISPATCHED/RUNNING derived from the dispatch ledger
- SUGGESTED_INTERFACE: extend status enum or expose `lifecycleState` on MissionTask

### BR-14 — Integration backlog / state
- UI_FEATURE: INTEGRATION BACKLOG, DAG integration state
- NEEDED_DATA_OR_COMMAND: list of results awaiting / in integration with gate verdict
- EXPECTED_CANONICAL_SOURCE: `IntegrationGate` / `IntegrationApplier` (no list/read API)
- RISK: low
- BLOCKING_OR_NOT: no (UNKNOWN)
- SUGGESTED_INTERFACE: `IntegrationGate.listPending()`

### BR-15 — Worker lease / fencing visibility
- UI_FEATURE: worker detail lease + fencing token/state
- NEEDED_DATA_OR_COMMAND: current lease owner, expiry, fencing token per active attempt
- EXPECTED_CANONICAL_SOURCE: dispatch attempt lease columns (only `holdsExecutionLease(id, owner)` boolean exists)
- RISK: low; must not expose credentials
- BLOCKING_OR_NOT: no (NOT_AVAILABLE)
- SUGGESTED_INTERFACE: `DispatchAttemptRepository.listActive(): { attemptId, workerId, leaseOwner, leaseExpiresAt, fencingToken }[]`

### BR-16 — Cross-mission active dispatch listing
- UI_FEATURE: worker "current mission / current task", ACTIVE WORKERS
- NEEDED_DATA_OR_COMMAND: non-terminal attempts across missions with workerId
- EXPECTED_CANONICAL_SOURCE: dispatch ledger — `listActiveWorkerAssignments()` returns only workerId strings; `listNonTerminalByMissionTaskId` is per task
- RISK: low
- BLOCKING_OR_NOT: no — cockpit iterates scoped mission tasks (O(tasks) queries; fine at current scale, not at 100+ missions)
- SUGGESTED_INTERFACE: `DispatchAttemptRepository.listNonTerminal(limit)`

### BR-17 — Natural-language intent compilation (ASK ICOS)
- UI_FEATURE: ASK ICOS → ProposedIntent → ProposedAction → risk → preview → confirm → execute → audit
- NEEDED_DATA_OR_COMMAND: server endpoint that compiles NL into a `ControlCommand` proposal (no execution)
- EXPECTED_CANONICAL_SOURCE: CEO service / conversation service (exists for chat, not for command compilation)
- RISK: high (prompt injection → command); proposal must be re-validated by BR-10
- BLOCKING_OR_NOT: yes for ASK ICOS execution
- SUGGESTED_INTERFACE: `POST /api/commands/propose { text } → ProposedAction[]`

### BR-18 — Step-up re-authentication
- UI_FEATURE: HIGH / CRITICAL risk confirmation
- NEEDED_DATA_OR_COMMAND: fresh-auth assertion (passkey/WebAuthn) bound to commandId
- EXPECTED_CANONICAL_SOURCE: Better Auth
- RISK: high
- BLOCKING_OR_NOT: yes for HIGH/CRITICAL commands
- SUGGESTED_INTERFACE: `POST /api/auth/step-up { commandId } → assertion` verified by BR-10

### BR-19 — Notification delivery (P0 push)
- UI_FEATURE: alert preferences, P0 phone notification
- NEEDED_DATA_OR_COMMAND: Web Push subscription storage + server sender
- EXPECTED_CANONICAL_SOURCE: none
- RISK: medium (VAPID keys are secrets — server only)
- BLOCKING_OR_NOT: no (preferences UI shows NOT YET WIRED)
- SUGGESTED_INTERFACE: `POST /api/notifications/subscriptions`

### BR-20 — Queue metrics (READY queue, review backlog)
- UI_FEATURE: READY QUEUE, REVIEW BACKLOG, queue pressure
- NEEDED_DATA_OR_COMMAND: counts of ready-not-dispatched tasks and QC jobs pending
- EXPECTED_CANONICAL_SOURCE: supervisor readiness (`readiness.ts`) and `QualityControlRepository`
- RISK: low
- BLOCKING_OR_NOT: no — cockpit derives READY (queued tasks whose deps all succeeded) and REVIEW (`review_pending` tasks) from scoped mission tasks and labels them "derived"
- SUGGESTED_INTERFACE: `SupervisorReadModel.queueDepths()`
