# Cockpit Control Center — surface → truth matrix

Lane B (Cockpit + Control), branch `feat/cockpit-control-center`, lane baseline `437b18c`.
Classification of the source **as rendered on this branch**: REAL · DERIVED (computed from REAL) ·
NOT_CONNECTED (canonical owner exists on another branch/lane, not integrated here) ·
NOT_AVAILABLE (no canonical source anywhere yet) · UNKNOWN (source exists, read failed at runtime).
Nothing is STATIC or MOCK on `/cockpit/**`: every missing value renders its gap with a requirement id.

| Cockpit surface | Required truth | Current source (this branch) | Class | Canonical backend owner | Gap | Implementation |
|---|---|---|---|---|---|---|
| Auth / session gate | authenticated owner, scope | `resolveCockpitAccess`, `resolveOperationalScope` | REAL | auth (Better Auth) | — | `load.ts getCockpitContext` |
| Link state (header) | is the screen current | heartbeat `GET /api/cockpit` | REAL | cockpit API | SSE BR-01 | `live.ts linkState`: LIVE/STALE/OFFLINE/ERROR/UNAVAILABLE |
| Missions list / detail | missions, status, tasks | `mission.list/listTasks` | REAL | CORE3 mission repo | — | `snapshot.summarizeMissions` |
| Plans / DAG | task graph, deps, critical path | mission tasks `dependsOn` + dispatch ledger | DERIVED | CORE3 | fine lifecycle BR-13 | `dag.ts` |
| Task state / attempts | attempt, worker, failure class | `dispatchAttempts.listNonTerminalByMissionTaskId` | REAL | CORE3 ledger | cross-mission listing BR-16 | `load.nonTerminalAttempts` |
| Review verdicts | decision, reasons, reviewer model | `reviewDecisions.listByMissionId` | REAL | CORE3 review | — | mission detail |
| Review queue / reviewer outage / decisions | QC jobs | `qualityControlJobs.listPending` (scoped to visible missions) | REAL | CORE3 QC | applied actions history | `pipeline.ts` → `/cockpit/pipeline` |
| Corrections | CORRECT/RETRY actions | QC `decision_ready` (pending only) | REAL (pending) | CORE3 QC | applied-action history not listable | pipeline stage "Decision ready" |
| IntegrationGate / integration backlog | ready_for_integration + integrating | `workspaceManager.list` (global scope) | DERIVED | workspace manager | — (BR-14 closed cockpit-side) | `pipeline.integrationBacklog`, overview metric + map domain |
| Apply state | accepted / rejected / blocked | `workspaceManager.list` | REAL | workspace manager / applier | — | pipeline workspaces table |
| Leases / fencing | workspace lease owner, expiry, fencing token | `workspaceManager.list` | REAL | workspace manager | dispatch-attempt execution lease (BR-15 remainder) | worker card, pipeline table, expired-lease alert |
| Settlement | per-task DAG settlement | — | NOT_CONNECTED | CORE3 defect-36 branch | merge | pipeline stage |
| Recovery activity | sweeper actions | — | NOT_AVAILABLE | CORE3 recovery | runtime events BR-02 | pipeline stage |
| Workers | registry, health, probe, load | `workerRegistryStore.list`, `listActiveWorkerAssignments` | REAL | CORE3 registry | — | worker cards |
| Compute / OmniRoute | provider, route, family, model, health, load | registry metadata (`provider`, `model`, `modelFamily`), capacity pool, probe | REAL (declared) | CORE3 0054 (registration) | — | `compute.ts` → `/cockpit/providers` |
| Compute: timeout / infra-failure rate, exclusions, cooldown, steering, fallback, routing reason | router facts | `dispatch_attempts.routing_decision` (ROUTING_DECISION) | NOT_CONNECTED here (0054 not merged); REAL once attempts carry evidence | CORE3 0054 | merge with `e652469` | `compute.routingEvidenceOf` (defensive parse) |
| Provider latency / tokens / cost | telemetry, billing | — | NOT_AVAILABLE | OmniRoute telemetry / FinOps | BR-04, BR-05 | explicit tiles |
| Credential health | provider auth state | — | NOT_AVAILABLE (deliberately not exposed) | OmniRoute | AUTH_FAILURE visible as cooldown via 0054 | compute footnote |
| Alerts | derived incidents | snapshot + pipeline derivations | DERIVED | — (BR-22 persisted alerts) | ack/history BR-22 | `deriveAlerts` + `buildPipeline().alerts` |
| Autonomy level / score | assessment | — | NOT_AVAILABLE | autonomy controller | BR-06 | explicit |
| Self-development / proposals | improvement candidates | — | NOT_CONNECTED | durable backlog on control/CORE3 branches | BR-08 | executive tile, self-dev page |
| Audit trail | append-only log | `audit.list` (permission `audit.read.full`, scoped) | REAL | audit repo | cursor BR-01 | audit page |
| Governed controls | 7 commands | `POST /api/control/commands` etc. | NOT_CONNECTED here (route absent) | control-foundation (0044) | merge | `commands.ts` + `CommandButton` |
| Runtime flags / safe mode | stored + effective flags | `GET /api/control/state` | NOT_CONNECTED here | control-foundation | merge | `ControlStatePanel` |
| Ask ICOS | streamed turn | `/api/ask/turns` (proposed) | NOT_CONNECTED | Cognitive Runtime (lane C) | BR-28 | `ask.ts` + `AskIcos` |
| Executive: objectives, milestones, blockers, workforce | missions, alerts, workers | snapshot | DERIVED | CORE3 | — | `executive.ts` |
| Executive: autonomous vs human actions 24h | audit actor kinds | full `audit.list` (not capped timeline) | DERIVED | audit | — | `executive.ts` |
| Executive: digital workforce / clients / KPIs | business data | — | NOT_CONNECTED | lane D / business OS | contracts | explicit tiles |
| Settings / devices | sessions | — | NOT_AVAILABLE | auth | BR-21 | settings page |
| PWA / offline | shell only | SW caches `/_next/static` + `offline.html`; navigations network-only | REAL (no data cached) | — | — | `public/sw.js` |
| Mobile | 390px usable | — | verified | — | — | headless Chrome sweep, 0 overflow, 0 console errors |

## Control command mapping (cockpit ↔ decision 0044)

| Cockpit control | Backend command | Risk (server) | Cockpit collects |
|---|---|---|---|
| Mission Pause | `PAUSE_MISSION` | LOW | reason |
| Mission Resume | `RESUME_MISSION` | MEDIUM | reason + ack (session < 12 h server-side) |
| Mission Cancel | `CANCEL_MISSION` | HIGH | reason + ack + password proof |
| Worker Disable | `DISABLE_WORKER` | MEDIUM | reason + ack |
| Worker Enable | `ENABLE_WORKER` | HIGH | reason + ack + password proof |
| Enter safe mode | `ENTER_SAFE_MODE` | MEDIUM | reason + ack |
| Exit safe mode | `EXIT_SAFE_MODE` | CRITICAL | reason + ack + password proof + exact phrase `EXIT_SAFE_MODE runtime:global` |
| Retry task | — | — | NOT COMMANDABLE (BR-23) |
| Change priority | — | — | NOT COMMANDABLE |
| Pause new work / freeze integrations / lock external actions (separately) | — | — | NOT COMMANDABLE (BR-26) |
| Stop external workers | — | — | NOT COMMANDABLE |

Lifecycle: REQUESTED (version read) → AUTH_REQUIRED (HIGH/CRITICAL) → AUTHORIZED → EXECUTING →
SUCCEEDED (only on `EXECUTED`) / REJECTED / FAILED / UNKNOWN (+ NOT_CONNECTED, UNAVAILABLE).
UNKNOWN reconciles by `GET /api/control/commands/:id`, or — when no answer ever arrived — by
resending the IDENTICAL request (server dedupes on actor + idempotency key and returns the stored
result with `replayed: true`). A fresh idempotency key is only minted by "Start over".
