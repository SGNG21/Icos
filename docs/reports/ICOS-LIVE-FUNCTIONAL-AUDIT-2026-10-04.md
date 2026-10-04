# ICOS — Live functional audit, 2026-10-04

What ICOS actually does today, on the running system. Not a code-presence audit: every row
below is backed by a persisted row, an HTTP response, or a command I ran against the live
runtime. Where I could not observe something, it says so rather than inferring.

```
RUNTIME_PID=64204          HEAD=28f88bc          NODE_ENV=production
CANONICAL_ORIGIN=https://macbook-pro-de-renault.tail2ea2a5.ts.net
LIVE_DB=icos_n23_probe @ localhost:5432        MIGRATIONS=54/54
AUDITOR_LIMIT=no browser automation was available; everything marked
              BROWSER_PENDING needs your session to close.
```

## The five states, kept distinct

`IMPLEMENTED` code exists · `TESTED` has automated tests · `INTEGRATED` wired into the
container/routes · `RUNNING` active in this process · `LIVE_PROVEN` observed producing a
real result today. A capability can be all of the first four and still be **BROKEN** live —
three of them are, and all three are configuration, not code.

## Master matrix

| # | Capability | Impl | Test | Integ | Run | Live proven | Status | Evidence | Root cause if not proven | Next action |
|---|---|:--:|:--:|:--:|:--:|:--:|---|---|---|---|
| 1 | Canonical HTTPS origin | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | `tailscale serve` → 127.0.0.1:3310; `/login` 200 | — | — |
| 2 | Login | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | `auth.login.succeeded` 2026-10-04 00:33:47, after 3 rejections during the origin misconfig | — | — |
| 3 | Route protection | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 16/16 protected routes → 307 `/login?next=<self>`; none leaked | — | — |
| 4 | CSRF / origin guard | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | `Origin: evil.test` → 403; canonical → 401 on a fake credential | — | — |
| 5 | Session persistence | ✓ | ✓ | ✓ | ✓ | ~ | **PARTIAL** | 7 session rows | Reload/expiry not observed in a browser | BROWSER_PENDING |
| 6 | Logout | ✓ | ✓ | ✓ | ✓ | ✗ | **PARTIAL** | route exists | No logout event in audit | BROWSER_PENDING |
| 7 | Cockpit ↔ home navigation | ✓ | ✓ | ✓ | ✓ | ~ | **PARTIAL** | 34 unit tests incl. nav list; build clean (`28f88bc`) | Unauth curl gets the login redirect | BROWSER_PENDING |
| 8 | Text conversation | ✓ | ✓ | ✓ | ✓ | ✗ | **BROKEN** | 51 turns, 48 completed, last one `TimeoutError` 2026-10-03 | `ICOS_COGNITIVE_MODEL` / `ICOS_CEO_MODEL` both unset → `not_connected`; 7 turns contain `NOT_CONNECTED` | Set the model (P0-1) |
| 9 | Cognitive pipeline itself | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | Live turn on an isolated test DB: `COMPLETED`, 5.0s, events `conversation.created → … → memory.written` | — | — |
| 10 | Conversation memory write | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 24 `memory.written` events; 30 `memory_records` | — | — |
| 11 | Normal voice | ✓ | ✓ | ✓ | ✓ | ✗ | **BROKEN** | status line `STT=NOT_CONFIGURED TTS=NOT_CONFIGURED` | `ICOS_VOICE_STT_MODEL` / `_TTS_MODEL` unset | Set both (P0-2) |
| 12 | Voice gateway path | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | FR text → 48,576 B mp3 (`gtts/fr`) → `whisper-large-v3-turbo` → transcribed back correctly | — | — |
| 13 | Voice auth gate | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | unauth WS upgrade refused; `/api/voice/status` 401 | — | — |
| 14 | Continuous voice / barge-in | ✓ | ✓ | ✓ | ✓ | ✗ | **PARTIAL** | 26 state-machine proofs | `voice-e2e.ts` needs the owner password, which is compromised and pending rotation | Rotate, then run |
| 15 | Wake word | ~ | ✓ | — | — | — | **MISSING** | stub, off by default | Deliberate — you chose design-only | — |
| 16 | Goal intake | ✓ | ✓ | ✓ | ✓ | ~ | **PARTIAL** | 1 goal persisted 2026-10-01, status `pending` | Never leaves `pending` | See #17 |
| 17 | Goal → Mission linkage | ✓ | ✓ | ✗ | ✓ | ✗ | **BROKEN** | `goals.resultingMissionId` 0/1; `missions.goal_id` 0/12 — a mission with the same text succeeded 2s later, unlinked | No writer sets either side | **P0-3** |
| 18 | Mission → DAG → tasks | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | `mission_tasks` 12/12 with both `mission_id` and `task_id`, 12 distinct missions | — | — |
| 19 | Task execution | ✓ | ✓ | ✓ | ✓ | ~ | **PARTIAL** | 15 `task_execution_results`; 9 succeeded / 1 failed / 2 cancelled; 12 dispatched | No run since 2026-10-01 | Re-run after P0-1/3 |
| 20 | Scheduler | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 3,338 succeeded jobs; newest 7.8s old | — | — |
| 21 | Sweepers | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | `probe_workers` 61/h, `supervisor_observe` 4/h, both succeeding | — | — |
| 22 | Dead scheduler jobs | — | — | — | — | — | **PROVEN OK** | 11 dead, all `SCHEDULER_NO_HANDLER`, all 2026-10-01 — historical | Handlers registered since | — |
| 23 | Worker registry + routing | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | **12/15 healthy+available** (was 0/15 before today's migration) | — | — |
| 24 | 3 unroutable workers | — | — | — | — | — | **BROKEN** | `nemotron-3-super-120b-a12b` HTTP 400 BAD_MODEL_ID; `oc/*` 401/403 AUTH_FAILURE | Dead ids + OpenCode free tier is in-app only | Deregister or repoint |
| 25 | OmniRoute compute | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 442 models; nvidia ultra-550b, codex gpt-5.6-sol, claude opus/sonnet/haiku all answer in 1–2s | — | — |
| 26 | Execution gateway + sandbox | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | `certify:gateway` 2/2: hermes + codex, `confinement=seatbelt`, exit 0, `PROBE_OK`, 4/4 credential grants revoked | — | — |
| 27 | Per-endpoint network policy | ~ | — | — | — | — | **MISSING** | `networkEnforced: false` | Seatbelt has no hostname matching | Container/proxy backend |
| 28 | Budget reserve/settle | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 3,756 ledger rows, 175,323 tokens; **0 stuck reservations** | — | — |
| 29 | Budget attribution | ✓ | ✓ | ✓ | ✓ | ~ | **PARTIAL** | 0/3,756 rows attributed — all `UNATTRIBUTED` | Correct *so far*: all current traffic is probe overhead, deliberately uncapped and unattributed. Untested for goal traffic | Re-check after a real mission |
| 30 | Money caps | ✓ | ✓ | — | — | — | **MISSING** | no price registry | Intended fail-closed | Use token caps |
| 31 | Review / quality control | ✓ | ✓ | ✓ | ✓ | ~ | **PARTIAL** | 13 jobs: 10 `action_applied`, 3 `escalated` | No review since 2026-10-01 | Re-run |
| 32 | Integration gate | ✓ | ✓ | ✓ | ~ | ✗ | **PARTIAL** | no live integration observed | Blocked behind #17 and #8 | After P0s |
| 33 | Durable memory | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 30 records, 54 retrievals, 24 write events | — | — |
| 34 | Memory cockpit metric | ✗ | — | — | — | — | **MISSING** | `snapshot.ts:808` hardcodes `not_available` (BR-02) | The tile never queries memory | **Now satisfiable — see P1-1** |
| 35 | Approvals | ~ | ✓ | ~ | ✓ | ✗ | **MISSING** | `actions` table 0 rows | **No code path writes an approvable action.** The UI says NON CONNECTÉE deliberately, so silence is not read as "nothing awaits you" | Real approvals arrive as conversation proposals |
| 36 | Self-development | ✓ | ✓ | ~ | ✓ | ✗ | **PARTIAL** | `DurableImprovementBacklog` persists candidates; **no `/api/self-development` route exists** | Missing cockpit read path (BR-08) | Add read path |
| 37 | 12 brains | ✓ | ✓ | ✓ | ✗ | ✗ | **MISSING** | `workforce_agents` = **0 rows** | Bootstrap is a deliberate human act | `pnpm workforce:bootstrap` — your call |
| 38 | Chief supervisor | ✓ | ✓ | ✓ | ✗ | ✗ | **MISSING** | cannot route with 0 brains | Depends on #37 | After bootstrap |
| 39 | Audit trail | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | 85,156 entries; 24h: 24 denied, 3 rejected, 1 succeeded | — | — |
| 40 | Secret isolation | ✓ | ✓ | ✓ | ✓ | ✓ | **PROVEN** | ephemeral HOME, scoped grants revoked on exit, gateway credential struck from probe errors | — | — |

## Totals

```
TOTAL_CAPABILITIES=40
PROVEN=19    PARTIAL=12    BROKEN=4    MISSING=5

ORDINARY_E2E=BLOCKED        (not FAIL — it was never able to start; see P0-1/3/4)
SELF_BUILD_E2E=NOT_RUN
AUTONOMY_LIVE_READY=NO
BRAINS_LIVE_ROWS=0
ROUTABLE_WORKERS=12/15
```

## Blockers

**P0 — nothing autonomous can run until these are closed**

1. `ICOS_COGNITIVE_MODEL` unset → every conversation answers `NOT_CONNECTED`. The pipeline
   is proven working; only the id is missing. *One line.*
2. `ICOS_VOICE_STT_MODEL` / `ICOS_VOICE_TTS_MODEL` unset → voice cannot start. Both values
   are documented in `.env.example` and I verified both live. *Two lines.*
3. **Goal → Mission linkage never written.** Your objective sits at `pending` forever while
   its mission succeeded. This is the defect behind "no mission becomes active" in the UI.
   *Real code fix.*
4. `ICOS_PLANNER_MODEL` and `ICOS_WORKER_MODEL` both point at
   `nvidia/nvidia/nemotron-3-super-120b-a12b`, which returns **HTTP 400 — not in the active
   live catalog**. The first real mission will fail on this. `nemotron-3-ultra-550b-a55b`
   is verified working. *One line.* `ICOS_REVIEWER_MODEL` (`groq/openai/gpt-oss-20b`)
   returns an empty upstream response and needs repointing too.
5. 0 brains live. Deliberate — but Chief cannot route without them.

**P1**

1. Memory cockpit metric (BR-02) is hardcoded unavailable while 30 records exist. The tile
   is honestly labelled but now misleading: the data is there.
2. No `/api/self-development` route, so a durable backlog is invisible (BR-08).
3. Approvals queue cannot fill — no writer exists.
4. Three dead workers still registered and probed every cycle.

**P2** — owner password rotation (still outstanding); `voice-e2e` blocked on it;
per-endpoint network policy remains declarative.

## What changed today, and what it proved

The headline finding: **two migrations were missing from the live database**
(`0055_spend_ledger`, `0056_spend_reservations` — 52 of 54 applied). Every worker probe runs
through the metered fetch, which reserves against `spend_reservations`; with the table
absent, all 15 probes failed regardless of model health. Applying them took routable workers
**0 → 12** and the ledger from empty to 3,756 rows. "0 routable workers" was never a model,
credential or gateway problem.

Second: the cockpit's `NOT AVAILABLE` tiles are **deliberate honesty markers carrying
requirement codes** (BR-02, BR-06, BR-08, BR-09, BR-14), not failures. The system is
declining to show data it cannot source. That is the right default — but BR-02 is now
satisfiable, so leaving it is the misleading choice.

## Top 10 next actions

1. Set `ICOS_COGNITIVE_MODEL=nvidia/nvidia/nemotron-3-ultra-550b-a55b` — restores conversation.
2. Repoint `ICOS_PLANNER_MODEL` and `ICOS_WORKER_MODEL` off the dead 120b id.
3. Repoint `ICOS_REVIEWER_MODEL` to a model that answers.
4. Set the two voice model ids — restores voice.
5. Fix goal → mission linkage (both `resultingMissionId` and `goal_id`).
6. Rotate the owner password; then run `voice-e2e.ts` for continuous voice and barge-in.
7. `pnpm workforce:bootstrap` — 12 brains, on your explicit go-ahead.
8. Run one ordinary E2E and re-check that spend stops being `UNATTRIBUTED`.
9. Give the memory tile a real volume metric (BR-02).
10. Deregister or repoint the three dead workers.

Items 1–4 are four configuration lines against values I verified live today. They convert
four BROKEN rows and unblock the ordinary E2E.

## Honest limits of this audit

No browser automation was available, so everything user-facing is proven from HTTP responses
and persisted rows, never from watching a screen. Session persistence, logout, the new
navigation, and all of section 21 (dead controls, mobile layout, misleading status) remain
**BROWSER_PENDING**. The ordinary E2E was not run because it requires a test credential and
would have failed on P0-1/3/4 regardless; calling it FAIL would overstate what I observed.
