# Cockpit Control Center — integration manifest

Lane B, branch `feat/cockpit-control-center`. Partner refs audited (COMMITTED state only):
`feat/control-foundation` @ `6794e21`, `integration/core3-control-foundation` @ `2156ddd`,
`feat/autonomy-core3-goal-planner-dag` @ `518fa0b` (d110f96..518fa0b re-audited: ignition/scheduler routes only, no contract read by the cockpit changed), `feat/cognitive-runtime` @ `3ea6f49`,
`feat/digital-workforce` @ `6f344e0`.

Rule for every dependency: when the backend is absent the cockpit renders an explicit
NOT_CONNECTED / UNAVAILABLE / UNKNOWN state; it never shows a success, a value or an answer it
did not receive. No cockpit code change is expected at merge unless stated.

---

## CONTROL_FOUNDATION_REQUIRED (decision 0044)

- **Contract expected**
  - `src/core/control/contracts.ts` — byte-identical copy on this branch (add/add merge, no conflict). Never edit one side alone.
  - `GET /api/control/state?missionId=&workerId=` → `ControlState` (versions; `runtime.stored=null` = fail-closed).
  - `POST /api/control/reauth {password}` → `{proof, expiresAt}` (single use, 5 min, user+session bound; 401 = wrong password).
  - `POST /api/control/commands` (`ControlCommandRequest`, same-origin) → typed `ControlCommandResult`; HTTP 200 EXECUTED · 202 UNKNOWN_EXECUTION_STATE · 409 FAILED / VERSION_CONFLICT / INVALID_TRANSITION / IDEMPOTENCY_KEY_REUSED · 422 · 403 · 404 · 428 SESSION_TOO_OLD / REAUTH_* / CONFIRMATION_REQUIRED · 503 CONTROL_STATE_UNAVAILABLE.
  - `GET /api/control/commands/:id` → stored result (202 while UNKNOWN).
  - Commands: PAUSE_MISSION (LOW), RESUME_MISSION (MEDIUM), CANCEL_MISSION (HIGH), DISABLE_WORKER (MEDIUM), ENABLE_WORKER (HIGH), ENTER_SAFE_MODE (MEDIUM), EXIT_SAFE_MODE (CRITICAL + phrase `EXIT_SAFE_MODE runtime:global`).
- **Current adapter**: `src/features/cockpit/commands.ts` (`httpControlTransport`, `loadVersion`, `executeCommand`, `reconcileCommand`, `reauthenticate`, `dialogMode`, `proofUsable`, `resultTrail`, `runtimeFlagRows`); UI `src/components/cockpit/command-button.tsx`, `control-state.tsx`; placements: mission detail, worker cards, System page.
- **Fallback UI state**: route absent (404 without ICOS envelope) → NOT CONNECTED, nothing executed; 503 on reads → UNAVAILABLE; after a mutation any 5xx/unreadable reply → UNKNOWN + "Check server state" (idempotent). Not commandable: retry (BR-23), per-flag (BR-26), change priority, stop external workers.
- **Tests to run after merge**
  - `pnpm vitest run src/features/cockpit/control-matrix.test.ts src/features/cockpit/commands.test.ts src/app/api/control` (matrix + backend route tests together).
  - Live, against real Postgres: each of the 7 commands; HIGH with a proof older than 5 min (UI must re-ask before sending; forced send → REAUTH_EXPIRED → Start over); resend after a dropped response (`replayed: true`, version unchanged); two tabs racing the same target (one VERSION_CONFLICT); ENTER/EXIT safe mode reflected in `ControlStatePanel`.
- **Merge hazard (not this lane)**: control migration 0047 vs CORE3 0047 (recorded on feat/control-foundation, resolved on integration/core3-control-foundation).

## CORE3_REQUIRED (decision 0054 + d110f96)

- **Contract expected**
  - Registry metadata `model`, `provider`, `modelFamily` (open string; d110f96 adds CLAUDE_FABLE), `tierHint`, budgets; `capacityPool = provider:<prefix>`.
  - `DispatchAttempt.routingDecision` (ROUTING_DECISION evidence: `decidedAt`, `requiredTier`, `escalationReason`, `candidateSet[].{workerId,family,fallback,excludedBecause,history}`, `selected.{workerId,model,family,score,modelSteered}`, `policyVersion`).
  - Existing reads already used: worker registry, dispatch ledger (`listNonTerminalByMissionTaskId`, `listActiveWorkerAssignments`), `qualityControlJobs.listPending`, `workspaceManager.list`, review decisions, missions.
- **Current adapter**: `src/features/cockpit/compute.ts` (`routingEvidenceOf` — structural cast, `buildCompute`), `pipeline.ts`, `load.ts`.
- **Fallback UI state**: attempts without evidence → router facts NOT CONNECTED (never 0); cold start / missing history → UNKNOWN; finished-attempt rates NOT AVAILABLE (BR-16); steered model (selection + `modelSteered=true`, an inference, not an execution record) UNKNOWN when `modelSteered=false` (CLI default ran); latency NOT AVAILABLE (BR-04); settlement NOT CONNECTED (defect-36 branch).
- **Tests to run after merge**
  - `pnpm vitest run src/features/cockpit/compute.test.ts src/features/cockpit/pipeline.test.ts`.
  - Drop the structural cast in `routingEvidenceOf` (contract declares `routingDecision`) and add one test typed against `RoutingDecisionEvidence` from `@/server/routing/capability-router`.
  - Live: one routed dispatch → `/cockpit/providers` shows routing reason, effective model, exclusions for that worker.
- **Still required from CORE3 (BR-16)**: a cross-mission terminal-attempt read for finished-attempt rates; `AuditRepository` bounded read (time window + limit / cursor, BR-01) — the cockpit still calls unbounded `audit.list()` (overview, audit page, executive counts). Not changed here: it is a repository change outside this lane.

## COGNITIVE_BR28_REQUIRED (lane C, decision 0056 — committed API)

- **Contract expected** (as committed on feat/cognitive-runtime; the cockpit adapted to it)
  - `GET /api/cognitive/conversations` (cockpit.read) → `{conversations, engine}`; `POST` (tasks.write, same-origin) `{title?}` → 201 `{conversation}`.
  - `GET /api/cognitive/conversations/:id` → `{conversation, participants, turns, proposals, recoveredTurnIds}` (resume).
  - `POST …/:id/turns` (tasks.write) `{text, idempotencyKey}` → 201 / 200 `replayed` `{turn, reply, proposal, replayed}`; synchronous until the turn settles; 409 `invalid_transition` = turn in flight.
  - `GET …/:id/events?after=N` with `Accept: text/event-stream` → SSE of `ConversationEvent` (`id` = seq), closes after ~25 s.
  - `POST …/:id/turns/:turnId/cancel`; `POST …/:id/proposals/:refId/decision {decision}` (missions.write).
  - Memory mode → 503 `persistence_unavailable`. Engine label `not_connected` → canned reply.
- **Current adapter**: `src/features/cockpit/ask.ts` (`httpCognitiveTransport`, `askReducer`, `submitPhase`, `needsRefresh`, `readEventStream`); UI `src/components/cockpit/ask-icos.tsx`.
- **Fallback UI state**: routes absent → NOT CONNECTED (nothing sent to a model, no answer shown); 503 → UNAVAILABLE (PostgreSQL required); engine `not_connected` → banner "replies are the runtime's notice, not ICOS analysis"; submit 5xx/unreadable → UNKNOWN + "Check again" (same idempotency key → replay); 409 → busy; goal proposal approved → pending goal id shown, never a started mission.
- **Gaps in lane C's API the cockpit does not paper over**: no token streaming (whole assistant turn); no interrupt (cancel only); `memory.written` / context provenance (`…/turns/:turnId/context`) not rendered yet.
- **Tests to run after merge**
  - `pnpm vitest run src/features/cockpit/ask.test.ts src/app/api/cognitive`.
  - Live: create → submit → events show received/processing/context.assembled → completed; kill the tab mid-turn and reopen (resume + cursor); double-click send (same key → replayed); MISSION_REQUEST → approve → `proposal.submitted` with goal id; memory-mode deployment → UNAVAILABLE.
- **Merge hazard (not this lane)**: lane C and lane D both use decision number 0056 and migration 0050.

## WORKFORCE_READMODEL_REQUIRED (BR-29 · lane D, decision 0056 — service only, no HTTP yet)

- **Contract expected**: a server-side projection built from `WorkforceService.listAgents/listAssignments/performance` (+ store `listDepartments/listRoles/listSkills`) with the caller's principal (`cockpit.read`), shaped as `workforceProjectionSchema` (`src/features/cockpit/workforce.ts`). Read-only: the cockpit has no workforce mutation.
- **Current adapter**: `workforce.ts` (`WorkforceReadPort`, `parseWorkforce`, `buildWorkforceView`), seam `loadReadModels()` in `src/features/cockpit/load.ts` (currently `notConnectedWorkforce`); Executive tiles (agents, attention, assignments awaiting approval).
- **Fallback UI state**: NOT CONNECTED; malformed projection → UNKNOWN; KPI measurements NOT AVAILABLE (contract carries targets only); performance with no observation → UNKNOWN (never 0%); live aggregates exclude terminal agents (retired/blocked) and terminal assignments (blocked/synthesized); 'awaiting approval' = `assigned` + required + not approved. The integrator must call `performance()` without `includeNonReal`.
- **Tests to run after merge**: `pnpm vitest run src/features/cockpit/readmodels.test.ts src/server/workforce`; replace `notConnectedWorkforce` in `loadReadModels()` with a port calling the service; add a test feeding the real bootstrap (`src/core/workforce/bootstrap`) through `parseWorkforce`.

## BUSINESS_READMODEL (BR-30 · no owner yet)

- **Contract expected**: `businessReadModelSchema` (`src/features/cockpit/business.ts`): clients, leads, pipeline, marketing (open channel set: seo, ads, …), KPIs — each row with `source: REAL | SIMULATED | NOT_CONNECTED` and `asOf`.
- **Current adapter**: `business.ts` (`BusinessReadPort`, `parseBusiness`, `buildBusinessView`), seam `loadReadModels()`; Executive tiles (clients/at risk, leads, pipeline, marketing channels, KPIs).
- **Fallback UI state**: NOT CONNECTED; non-REAL rows withheld and counted, never displayed as values; a section with only non-REAL rows is UNKNOWN (never a measured 0); `asOf` must be a timestamp (no freshness TTL yet — known gap).
- **Tests to run after merge**: `pnpm vitest run src/features/cockpit/readmodels.test.ts`.

---

## Global post-merge certification

`pnpm typecheck && pnpm test && pnpm lint && pnpm build && git diff --check`, then the live
headless sweep (390×844 and 1440×900, 0 console errors, 0 horizontal overflow) described in
`STATE.md`, with the control API and Cognitive Runtime routes present.
