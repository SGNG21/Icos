# Cockpit Control Center — Worker State (handoff file)

A replacement worker must be able to continue from this file alone.
Re-verify `CURRENT_HEAD` against `git log` before trusting it.

## CURRENT_HEAD
`4b570ec` at C0 start (branch `feat/cockpit-control-center`, forked from the CORE3 branch tip).
See the milestone log below for later heads.

## CURRENT_MILESTONE
Cockpit UI scope complete against available backend (C1–C4, C6 contracts, C7–C9 honest shells, PWA). Remaining work is BACKEND-BLOCKED (BR-01, BR-10, BR-12, …) — see latest log entry.

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
- `src/app/manifest.ts`, `src/app/icon.tsx`, `src/app/apple-icon.tsx`, `public/sw.js`, `public/offline.html` (PWA)
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

### C1–C3 (partial) — design system, shell, real overview, missions/DAG, workers
- FILES_CHANGED: `src/features/cockpit/{truth,dag,snapshot,commands,live,load}.ts` (+ tests), `src/components/cockpit/{primitives,nav-items,cockpit-nav,live-refresh,system-map,command-button,dag-view,node-tone,alert-list,pwa-register}.tsx`, `src/app/cockpit/{layout.tsx,cockpit.css,page.tsx,missions/page.tsx,missions/[id]/page.tsx,workers/page.tsx}`
- TESTS: `pnpm vitest run src/features/cockpit/` → 41 passed (DAG layout/critical path/blocked/cycles/600 nodes, UNKNOWN propagation, alerts/health, secret metadata filter, 100 workers, command risk confirmation + idempotency + UNKNOWN_EXECUTION_STATE, reconnect backoff/staleness). `pnpm typecheck` clean, eslint clean on cockpit paths.
- NOT YET DONE / OPEN_UI_DEFECTS:
  - D-04 nav links 404: `/cockpit/{providers,alerts,autonomy,self-development,audit,system,settings,ask}` pages not written yet (building blocks exist: `AlertList`, `Unavailable`, `CommandButton` with `system.*` actions, `snapshot.timeline`, `loadSources().audit`).
  - D-05 PWA not wired: `src/app/manifest.ts`, `src/app/icon.svg`, `public/sw.js` (cache only `/_next/static` + `offline.html`, navigations network-only), `public/offline.html` missing; `PwaRegister` already registers `/sw.js` in production. `src/proxy.ts` matcher must exclude `manifest.webmanifest|sw.js|icon.svg|offline.html`.
  - D-06 no visual verification yet (needs `PERSISTENCE=postgres` + owner session, see memory `icos-owner-login-db-mismatch`); check mobile 390px + desktop 1440px.
  - D-07 no component render tests yet (repo has no jsdom; use `react-dom/server` renderToStaticMarkup + createElement in `.test.ts`).
- MUST_NOW: write the 8 missing pages (D-04) so nav doesn't 404.
- SHOULD_NEXT: D-05 PWA, D-06 visual pass, D-07 render tests, then C5 SSE (BR-01).
- NEXT_ACTION: create `src/app/cockpit/alerts/page.tsx` (render `snapshot.alerts` grouped by category; preferences = `Unavailable` BR-19), then `system/page.tsx` (emergency CommandButtons + safe-mode state UNKNOWN BR-12).

### C4–C9 — all sections, PWA, defect fixes, visual validation (2026-09-28)
- HEAD: see `git log` (checkpoints `a2dd4f0` pages · `bbf5cb5` PWA · `6633a3e` D-01/02/03 · `4a5426d` visual fixes · `dde4208` format)
- PAGES (all 12 routes live): overview, missions, mission/[id], workers, providers, alerts, autonomy, self-development, audit, system (emergency), settings, ask.
- FILES_CHANGED: `src/app/cockpit/{providers,alerts,autonomy,self-development,audit,system,settings,ask}/page.tsx`; `src/features/cockpit/{resources,audit-view,ask}.ts` (+tests), `load.ts` (`loadSystemFacts`); `src/components/cockpit/{ask-icos,worker-card,brand-mark}.tsx`, `render.test.ts`, `pwa.test.ts`; PWA `src/app/{manifest.ts,icon.tsx,apple-icon.tsx}`, `public/{sw.js,offline.html}`; `src/proxy.ts` (+test); defects `src/app/{layout.tsx,page.tsx,control-room/page.tsx}`, `src/components/layout/{sidebar,business-sidebar}.tsx`.
- DEFECTS CLOSED: D-01 control-room now gated on real headers (forged cookie → 307 login; real session now shows data, before: always "No data available"); D-02 globals.css restored; D-03 hardcoded "Système nominal"/"Intégrations désactivées"/"Exécution verrouillée" replaced by derived health + persistence fact; D-04 all pages; D-05 PWA; D-06 visual validation; D-07 render tests.
- TESTS: `pnpm test` → 150 files / 1850 passed. Cockpit-specific: 80 (DAG, snapshot/UNKNOWN propagation, commands/risk/idempotency, live/stale, resources, audit query+pagination, render: UNKNOWN/NOT AVAILABLE/NOT YET WIRED, nav 10 sections + 5-slot thumb bar, DAG view, system map (no animation w/o activity), worker card identity separation, emergency controls never LOW and never succeed, Ask ICOS never interprets, SW run in node:vm: navigations network-only, offline → data-free page, API/POST/foreign never intercepted, only `/_next/static` cached; manifest; proxy: PWA assets open, look-alike paths protected). `pnpm typecheck` clean, eslint clean on touched paths, prettier clean on touched files.
- VISUAL VALIDATION: headless Chrome over CDP (extension unavailable) at 390×844 (DPR2) and 1440×900 against a real Postgres ICOS (scratch DB `icos_cockpit_preview`, migrations applied, owner via `auth:bootstrap`, missions/workers written through ICOS services + real `workerHealthProber.probeAll()`). 30 renders, 0 console errors, no horizontal overflow after fixes. Verified: HIGH dialog (typed + passkey NOT YET WIRED → send disabled), MEDIUM safe-mode → "NOT YET WIRED — nothing was executed", Ask ICOS submit → nothing sent, offline → chip + desaturated data + stale health badge. Fixes found this way are in `4a5426d`.
  - Reproduce: `createdb icos_cockpit_preview`; migrate `drizzle/` with drizzle migrator (TCP `postgres://$USER@localhost:5432/icos_cockpit_preview`; postgres.js rejects `?host=`); env: PERSISTENCE=postgres, BETTER_AUTH_SECRET(32+), BETTER_AUTH_URL=http://localhost:3100, ICOS_OWNER_EMAIL; Postgres mode also REQUIRES OMNIROUTE_BASE_URL/OMNIROUTE_API_KEY/ICOS_REVIEWER_MODEL (use an unreachable URL + placeholder for a read-only preview); `ICOS_OWNER_PASSWORD=… pnpm auth:bootstrap` creates the owner but never exits (kill it after the row appears); `next dev -p 3100`; sign in via `POST /api/auth/sign-in/email` with `origin` header.
- OPEN_UI_DEFECTS:
  - D-08 legacy `/` still calls `forbidden()` although `experimental.authInterrupts` is off (would 500 for a forbidden user). Not cockpit scope.
  - D-09 legacy `/` panels show "SIMULATION"/"Session locale" badges while rendering real Postgres data (legacy labels, owned by the legacy home).
  - D-10 cockpit redirects every unauthenticated deep link to `/login?next=/cockpit` (server components cannot see the path without a proxy header).
  - D-11 DAG: single barycenter pass; very wide graphs open at 0.75 scale with the tail off-canvas (pan/fit available).
  - D-12 `auth:bootstrap` does not exit (open handle) — script owner, not cockpit.
- BACKEND_REQUIREMENTS: BR-01…BR-22 (added BR-21 device/session management, BR-22 persisted/acknowledgeable alerts).
- MUST_NOW (backend-blocked, not UI): BR-10 governed command bus (+BR-11 versions, BR-18 step-up) is the single blocker for ANY control; BR-12 runtime control flags for real safe mode.
- SHOULD_NEXT: BR-01 SSE over audit (replace `LiveRefresh` polling), BR-02 runtime event vocabulary, BR-03 worker model/provider/account fields, BR-06/08 autonomy + improvement backlog read models; cockpit side then: C5 SSE client with `Last-Event-ID` resume, alert ack UI (BR-22).
- NEXT_ACTION: when BR-10 lands, replace `notWiredTransport` in `command-button.tsx` with an HTTP transport (`POST /api/commands`, `GET /api/commands/:id`) — contract and tests already in `commands.ts`; nothing else in the UI needs to change.
