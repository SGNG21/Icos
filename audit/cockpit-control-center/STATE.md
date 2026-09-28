# Cockpit Control Center — Worker State (handoff file)

A replacement worker must be able to continue from this file alone.
Re-verify `CURRENT_HEAD` against `git log` before trusting it.

## CURRENT_HEAD
`4b570ec` at C0 start (branch `feat/cockpit-control-center`, forked from the CORE3 branch tip).
See the milestone log below for later heads.

## CURRENT_MILESTONE
C0 done → C1/C2/C3 in progress (see log).

## EXISTING_COCKPIT_PATHS (C0 forensic audit)
| Path | What | Verdict |
|---|---|---|
| `src/app/page.tsx` + `src/components/features/*` | legacy home cockpit (conversation composer, recent tasks, approvals, agent grid). Hardcoded "Système nominal", "Intégrations désactivées" banners — **not state-derived** | preserved untouched; superseded by `/cockpit` |
| `src/app/control-room/page.tsx` | "Control Room V1": reads `.icos/autonomy/worker-registry.json` from disk, previews markdown. **Auth defect**: calls `protectRoute` with a synthetic `new Request(...)` without cookies — never has a session → always "No data available". Reads a file, not the canonical registry | preserved untouched; replaced by `/cockpit/workers` (canonical `WorkerRegistryStore`) |
| `src/features/cockpit/projection.ts` + `status-presentation.ts` | pure task projection + French status labels | **reused** by the new cockpit |
| `src/components/cockpit/system-status-bar.tsx`, `task-rows.tsx` | small presentational components | kept |
| `src/app/business/**` | business OS UI (owned by `feat/business-os-ui` worktree) | MUST NOT TOUCH |
| `src/styles/globals.css` | light "forest" theme. **Defect**: import removed from `src/app/layout.tsx` in 5cbb42f → legacy pages render unstyled | recorded, not fixed here (owned by business-os-ui line) |

## EXISTING_DATA_SOURCES (canonical, consumed read-only)
- `container.tasks.listForScope(scope)` — canonical tasks (8 statuses)
- `container.mission.list() / listTasks(id)` — missions (9 statuses) + mission tasks with `dependsOn` (10 statuses) → DAG
- `container.workerRegistryStore.list()` — durable worker registry (health, availability, probe evidence, runtime, maxConcurrency, capacityPool)
- `container.dispatchAttempts.listActiveWorkerAssignments()` / `listNonTerminalByMissionTaskId()` — dispatch ledger (attempt, workerId, state, failureClass, lastError)
- `container.reviewDecisions.listByMissionId()` — review verdicts with reasons + reviewer provider/model
- `container.actions.listForScope(scope, {approvalStatus:"pending"})` — pending human approvals
- `container.audit.list()/query()` — append-only audit log (the only event log)
- `container.db` presence — persistence backend (`postgres` vs in-memory **demo seeds**)
- scope: `resolveOperationalScope()` (`src/server/administration/mission-scope.ts`), `isMissionInScope()`

## EXISTING_APIS
`GET /api/cockpit` (projection), `GET /api/missions`, `GET /api/missions/[id]`, `GET /api/audit` (audit.read.full), `GET /api/tasks`, `GET /api/agents`, `GET/POST /api/actions`, `POST /api/actions/[id]/decision`, `/api/scheduler/jobs`, `/api/goals`, `/api/conversation`, `/api/missions/autonomous` (memory notes open auth gap — not touched).
No command bus; mutations are scattered per resource.

## EXISTING_REALTIME_PATHS
None. No SSE/WebSocket/EventSource anywhere in `src/`. → BR-01.

## AVAILABLE_TELEMETRY
Real: task/mission/mission-task counts and statuses, DAG edges, worker health/availability/probe outcome+timestamp, capacity limits, active assignments per worker, attempt number/state/failure class, review decisions, pending approvals, audit entries (task/auth/admin/capability/skill/goal event types).
Not available: cost, tokens, latency, provider health, autonomy score, improvement candidates, integration backlog, leases/fencing, routing rationale, safe-mode flags.

## MISSING_BACKEND_CAPABILITIES
See `BACKEND_REQUIREMENTS.md` (BR-01 … BR-20).

## ALLOWED_FILE_SCOPE
- `src/app/cockpit/**` (new control center routes + `cockpit.css`)
- `src/features/cockpit/**` (read models, DAG, commands, live — pure + one server loader)
- `src/components/cockpit/**`
- `src/app/manifest.ts`, `src/app/icon.svg`, `src/app/apple-icon.tsx`, `public/sw.js`, `public/offline.html` (PWA)
- `src/proxy.ts` matcher only (let PWA assets through unauthenticated — they carry no data)
- `audit/cockpit-control-center/**`

## MUST_NOT_TOUCH (CORE3 worker scope)
`src/server/{autonomy,supervisor,execution,workers,recovery,scheduler,workspace-manager,routing,mission,review,services}/**`, `src/server/container.ts`, `src/server/database/**`, `drizzle/**`, `src/core/**` (read-only import only), `src/app/api/**` (existing routes), `src/app/business/**`, `audit/self-build-bootstrap/**`.

## ARCHITECTURE (C1)
- Route tree `/cockpit/*` with its own layout (auth gate = `resolveCockpitAccess`, same as `/`), own dark design system `src/app/cockpit/cockpit.css` scoped under `.cx`.
- One server loader `src/features/cockpit/load.ts` (React `cache()` per request) reads canonical sources **with operational scope**; every source read is isolated so one failing source turns into `UNKNOWN`, never a crash and never a fake value.
- Pure builders (`snapshot.ts`, `dag.ts`) → view models where every metric is a `Truth<T>` (`real | unknown | not_available | not_yet_wired`, `truth.ts`).
- Commands: `commands.ts` defines `ControlCommand` + risk classes + a client state machine (`UNKNOWN_EXECUTION_STATE`, no blind retry). Transport is `notWiredTransport` until BR-10 exists → every control renders **NOT YET WIRED** after its risk-appropriate confirmation preview.
- Live: `LiveRefresh` heartbeats `GET /api/cockpit` then `router.refresh()`; exponential backoff on failure; visible STALE banner. Replace with SSE when BR-01 lands.
- PWA: manifest (start_url `/cockpit`), SW caches only immutable `/_next/static` + `offline.html`; navigations are network-only → no authoritative state ever served from cache.

## MILESTONE LOG
(appended per milestone: HEAD, MILESTONE, FILES_CHANGED, TESTS, OPEN_UI_DEFECTS, BACKEND_REQUIREMENTS, MUST_NOW, SHOULD_NEXT, NEXT_ACTION)

### C0 — forensic audit
- FILES_CHANGED: `audit/cockpit-control-center/STATE.md`, `BACKEND_REQUIREMENTS.md`
- TESTS: n/a (baseline `pnpm typecheck` clean at 4b570ec)
- OPEN_UI_DEFECTS: D-01 `/control-room` synthetic Request auth; D-02 root layout lost `globals.css`; D-03 legacy `/` hardcoded status banners
