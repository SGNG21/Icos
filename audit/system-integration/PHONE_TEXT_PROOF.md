# First phone/text end-to-end proof — 2026-09-30

Trunk state: `integration/icos-central` at the I2 checkpoint (control + P0 + cognitive + cockpit) plus
`compute:register`. Server: `next start` (production mode) on `127.0.0.1:3100`, `PERSISTENCE=postgres`,
database `icos_phone_proof` (fresh, migrated 0000→0050, ledger 48 OK, owner bootstrapped with a
throwaway password that lives only in the session scratchpad). Real OmniRoute gateway, real Hermes
CLI workers (13 registered and probed healthy across 6 families by `pnpm compute:register`), real
planner (Nemotron-120B via OmniRoute), real reviewer (routed), cognition on `claude/claude-sonnet-5`.

LDS context does not exist in ICOS (no client entity, no facts), so — as instructed — the controlled
internal fixture was used: the ICOS repository itself (clone at `scratchpad/proof-repo`, branch
`proof-main`), objective "inventory `docs/architecture`, analyse, write a prioritised report; read-only".

## Mission used

« ICOS, lance une mission autonome en plusieurs tâches sur le projet ICOS … (1) inventorier les documents
de docs/architecture, (2) analyser leur cohérence, lacunes et sections obsolètes, (3) rédiger un rapport
priorisé des améliorations (impact / effort). Lecture seule … Commence le travail. »

## Boundaries crossed (all real, in order)

| # | Boundary | Evidence |
|---|---|---|
| 1 | "Phone" (HTTP client) → Better Auth sign-in, session cookie | `POST /api/auth/sign-in/email` 200; `/cockpit` 200 with session, 307 → `/login` without |
| 2 | Cognitive: conversation created | `conv-4a547e35…` (201) |
| 3 | Cognitive: turn accepted **durably**, idempotent on `proof-p1-turn-6`, context snapshot `ctx-…` | turn `turn-3df8b790…` `completed` / `MISSION_REQUEST` |
| 4 | Turn policy → `goal_proposal` `approval_required` (`read_only`) | `tref-b6d600e5…` |
| 5 | Human decision (owner, `missions.write`) | `POST …/proposals/tref-b6d600e5…/decision {approve}` 200 |
| 6 | `CanonicalGoalLauncher`: goal intake + `scheduler.enqueue(start_mission)`; MissionReference persisted | turn ref → `launched`, `goalId`, `missionId d48b3347…`, `launchJobId da710775…` |
| 7 | Durable Scheduler (production composition, `startProductionServices`) picks the job | job `running` at 12:20:49, later `succeeded` |
| 8 | `igniteAutonomousMission` with the governed supervisor → planner (OmniRoute) → DAG | mission + runtime rows; 1 task `read_only`, `review_policy never` |
| 9 | Capability + compute routing (0054) | attempt 1 → `cc/claude-haiku-4-5`, `requiredTier 1`, reasons "complexity low → tier 1" |
| 10 | **Real worker**: Hermes CLI process (`-m cc/claude-haiku-4-5…`, `--yolo`) runs ~2 min in an ad-hoc worktree of the proof repo | `task_execution_results.outcome=success`, 1 142-char summary; artifact: branch `icos/worker/b0717611-…-r-fratL5`, commit `577bf6d` adding `RAPPORT_ARCHITECTURE_ANALYSE.md` (313 lines); canonical `proof-main` untouched |
| 11 | Frontend disconnected the whole time (curl closed after each request); no restart of the server was needed for the mission to progress | mission advanced 12:20 → 12:24 with no client attached |
| 12 | Quality control + **independent review** (reviewer routed to Nemotron-120B; writer's worker `EXCLUDED_WORKER`, writer's model `SAME_MODEL_AS_WRITER` excluded) | `decisions.decision=APPROVE`; `quality_control_jobs state=action_applied action=ACCEPT` |
| 13 | Settlement by the wake-up/recovery path, no operator action | `missions.status=succeeded`, `autonomous_mission_runtime.state=succeeded` at 12:24:10 |
| 14 | "Phone" reconnects: conversation resume, mission API, cockpit pages, task page with the result text | `GET /api/cognitive/conversations/:id` (proposals `[rejected, launched(d48b…)]`), `GET /api/missions/:id` `succeeded`, `/cockpit/missions/:id` 200 rendering `succeeded`, `/tasks/:id` renders the report summary, `GET /api/tasks/:id/execution` 200 |

Exactly-once: 1 `scheduled_jobs` row for the mission (`succeeded`), 1 mission for the goal, 1 dispatch
attempt, **0 non-terminal attempts** at the end. Audit: `auth.login.succeeded`, `goal.created`,
`task.created`, `task.execution.completed`.

## Verdicts

| Item | Verdict |
|---|---|
| PHONE_TEXT_E2E | **PASS (HTTP path)** — the exact HTTP contract the cockpit's `httpCognitiveTransport` uses, driven by an HTTP client standing in for the phone browser. Interactive browser drive of the cockpit UI: **NOT_RUN** (Chrome extension unavailable in this session); the cockpit pages render with a real session and show the mission as `succeeded`. Real phone over the tailnet: NOT_RUN (see `INTEGRATION.md` "HTTPS / phone access"). |
| CONVERSATION_DURABLE | PASS — turns, refs, snapshot and events in PostgreSQL; resume returns them from rows |
| MISSION_DURABLE | PASS — mission, runtime, plan, task, attempt, result, review, QC rows |
| REAL_WORKER | PASS — Hermes CLI process on a routed real model; real planner and real reviewer |
| FRONTEND_DISCONNECT_SURVIVES | PASS — no client attached between approval and settlement |
| RESULT_DURABLE | PASS — `task_execution_results` + git artifact on the worker branch |
| MANUAL_STAGE_ADVANCEMENT_REQUIRED | **FALSE** — the only human act was the policy-required approval; scheduler, supervisor, executor, QC, reviewer and wake-up advanced every stage |

## Findings (not fixed here; owners named)

- **F1 (cognitive)** — a pure analysis/report request is classified `ACTION_REQUEST` (the prompt reserves
  `MISSION_REQUEST` for "analyse + correction"); actions have no backend (`not_connected`), so the first,
  natural phrasing dead-ended (`tref-c581101f…`, rejected). Research/report work must route to a mission.
- **F2 (cognitive)** — Nemotron returned a valid `MISSION_REQUEST` wrapped in `{"result": …}`; the strict
  parser degraded it to `ANSWER_ONLY` and showed raw JSON. Tolerate a wrapper / extract the schema object.
  Work-around used: cognition on Sonnet by configuration (`ICOS_COGNITIVE_MODEL`).
- **F3 (CORE3)** — `container.ts` never supplies `workspaceMode`, so a `read_only` task with no governed
  workspace defaults to the ad-hoc *writer* worktree: an `icos/worker/*` branch that no gate reviews and
  nothing reaps (it holds the 313-line report). Decide: reader shares the checkout (unsafe with a
  `--yolo` agent) vs ad-hoc worktree + branch reaping with the report kept as an artifact.
- **F4 (CORE3/cognitive)** — `goals.status` stays `pending` after its mission succeeded: no goal
  settlement from mission completion.
- **F5 (CORE3)** — goal ids are derived from title + objective with no length cap (this one is 298
  chars); the trunk's `max(200)` on the enqueue schema would have refused the launch (kept 5000 at I1).
- **F6 (cockpit)** — the new `/cockpit/missions/:id` page shows status/DAG/attempts but not the result
  text; the legacy `/tasks/:id` page does. A result/report view is missing on the phone surface.
- **F7 (ops)** — OmniRoute returned 503 twice in a row on the cognition call (turns 2, 3, 5); the runtime
  failed the turns durably with the reason, which is correct, but a retry policy for transient gateway
  errors would spare the user three resubmissions.
- **F8 (ops)** — there was no operator path to register workers; `pnpm compute:register` (this branch)
  fills it. `pkill -f "next start"` does not stop `next-server`; use the listening pid.

## LDS onboarding dependency (recorded)

To run the real LDS mission: a `lds-renov` client entity + human-asserted facts in cognitive memory
(`POST /api/cognitive/memory`), the LDS site/stack/access as memory facts, and (for anything beyond public
web reading) the connectors of `ICOS_INTEGRATION_PLAN.md` I6.

## Addendum (I6 build against the proof DB, 2026-09-30 afternoon)

- **F9 (ops/release)** — starting the I6 build against the proof DB still at migration 0050 failed every
  request with 500: production services seed the `supervisor_observe` job at boot and the
  `scheduled_jobs_kind_check` of 0050 refuses it. Code ahead of schema is a boot failure, not a degraded
  mode. `pnpm db:migrate` (0051 → 0053, ledger 51 OK) fixed it; the earlier mission `d48b3347…` and its
  rows survived the upgrade. Release policy must gate `next start` on `db:verify-ledger`.
- Origin guard behind a forwarded-HTTPS proxy: not verifiable here — the session cookie is bound to
  `localhost:3100`, so a request under the tailnet `Host` is 401 before the origin check. Verify with a
  session issued for the tailnet host (step 4 of the procedure in `INTEGRATION.md`).
