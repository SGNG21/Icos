# ICOS — Central Integration Record

Branch: `integration/icos-central`. Started 2026-09-30 11:43 at CORE3 `d110f96`.
Rules: never integrate uncommitted lane state; never modify a source worktree; numbers are final only
on this branch (`docs/architecture/ICOS_INTEGRATION_PLAN.md` §1); every merge carries its evidence.

## Trunk

| Field | Value |
|---|---|
| INTEGRATION_TRUNK | `integration/icos-central` (worktree `/Users/coco/icos-worktrees/integration-central`) |
| TRUNK_START_HEAD | `d110f96` — committed HEAD of `feat/autonomy-core3-goal-planner-dag` at 11:43 |
| WHY_THIS_TRUNK | `integration/phase8-autonomy` (`8ff5fdd`) is a strict ancestor of CORE3 (61 behind, 0 ahead) and is checked out in another worktree with a dirty file: using it means writing to that worktree. Every lane forks from the CORE3 line, which already contains phase8-autonomy. `main` (`7e2ea80`, July) is not an integration base. A fresh branch at CORE3's committed HEAD is the only start that is (a) clean, (b) a superset of every existing integration branch, (c) nobody's working branch. Fast-forwarding `integration/phase8-autonomy` to this branch later is a one-line owner action. |

## Merge order and numbering (final on this branch)

| Wave | Lane | Source HEAD | Decision | Migration | Status |
|---|---|---|---|---|---|
| I2a | Control foundation | `6794e21` via `integration/core3-control-foundation` `2156ddd` | 0044 → **0055** | `0048_control_plane` → **0049** (idx 46) | MERGED `beb4afa` |
| P0 | CORE3 P0 | `518fa0b` | — | — | see below |
| I1 | Cognitive | `44eaac7` | 0057 → **0056** | `0051` → **0050** (idx 47) | MERGED `44bc234` |
| I2b | Cockpit | `0e53db3` | — | — | MERGED `5c14ef7` |
| I3 | Workforce | `7cd0fc2` | 0056 → **0057** | `0050` → **0051** (idx 48) | MERGED `0291206` |
| I4 | Tool gateway | `bc95ed7` | 0055 → **0058**, 0056 → **0059** | `0049` → **0052** (idx 49) | MERGED `b43a516` |
| I5 | Proactive supervisor | `f79a7b6` | 0055 → **0060** | `0049` → **0053** (idx 50); ns `core/proactive` | MERGED `0db464d` |
| I6 | Voice | `a7e8ab3` (transport HEAD; `49379e1..2eb6e95` mobile-UI redesign NOT merged — cockpit-lane review) | 0056 → **0061** | — | MERGED `3743a37` |
| follow-ups | Cockpit `e1305a0`, Cognitive `5390a97` | — | — | — | MERGED `f2648d1`, `f9eac18` |

## I2a — control foundation (merged `beb4afa`)

Conflicts and resolutions: see the merge commit message. Proofs:

- `audit_event_type_check` in `0049_control_plane` = exact union of `0047_audit_goal_events` (41) + 4
  `control.command.*` (set comparison, 45 = 41 + 4, nothing dropped). TS `audit.ts` contract (40) ⊂ 45.
- `enforcement.test.ts`: the held-retry invariant re-proven on the canonical pending-intent path
  (`run()` + `reconcilePreparedDispatches`) with a positive control; the `dispatchPrepared` path it
  used no longer exists on the trunk (decision 0051).
- typecheck PASS · unit 1932/1932 · control + api/control PostgreSQL 12/12 · ledger 47 rows OK ·
  `git diff --check` clean · lint 0 errors (4 pre-existing warnings).
- Full `pnpm test:integration` on `icos_integration_test`: see "Certification log".

## Certification log

(appended per checkpoint)

## Directives to lanes (from refreshed reality, 2026-09-30 11:43–12:30)

| Lane | Before its merge |
|---|---|
| CORE3 | nothing pending: P0 committed (`518fa0b`, clean). Keep committing on the feature branch; the trunk merges from it. |
| Cognitive | **commit** the 33-file tree. Do not rename numbers again: the trunk assigns 0056 / `0050_cognitive_runtime` whatever the file is called. Rebase onto `518fa0b` first — both sides added `goalId` to the `start_mission` payload schema in `scheduler-service.ts` (trunk: `max(200)`, lane: `max(5000)`); the trunk's line wins. Keep `CanonicalGoalLauncher` on `scheduler.enqueue({kind:"start_mission"})` — it is the canonical launch (ICOS_SYSTEM_INTEGRATION CCD-4). |
| Cockpit | **commit** the 13-file tree. Drop the local copy of `src/core/control/contracts.ts` in favour of the trunk's (identical apart from "decision 0055"). Ask ICOS already targets the committed cognitive API — re-check against cognitive's *next* commit (turn routes and `contracts.ts` are changing). |
| Workforce | **commit** the 20-file tree (authority, principals, compute port, composition). Numbers become 0057 / `0051` at merge. |
| Tool gateway | **commit** `app.ts`/`composition.ts` and the in-flight fixes. Its edits to `src/core/contracts/audit.ts` and `schema.ts` will be unioned at merge (0052 must re-create `audit_event_type_check` as 0049's 45 values + `tool.*`). |
| Proactive supervisor | nothing pending. Merge at I5 with `scheduled_jobs_kind_check` = trunk kinds + `supervisor_observe`; namespace rename to `proactive` will be done at merge if the lane has not. |
| Voice | commit `scripts/voice-server.ts`. `ConversationCognitiveAdapter` is a **temporary bridge onto the legacy CEO conversation** (its own header says so): I6 integrates voice only over the cognitive runtime's `acceptTurn` + `CognitiveTurnStream` (lane C, in flight). The `ws` + `@types/ws` dependency is an owner acceptance item. |

## P0 — CORE3 canonical entry point (merged `1f6bdf4`)

`POST /api/missions/autonomous` → `container.scheduler.enqueue({kind:"start_mission"})` (idempotent per
caller, 202 with the fixed mission id). `igniteAutonomousMission` is called only by the scheduler's
`start_mission` handler, composed in `production-services.ts` with the governed supervisor. The
Temporal callback route builds no supervisor. `new SupervisorService` in non-test code: exactly one
(`production-services.ts`). AUTONOMOUS_API_P0 = RESOLVED (committed `518fa0b`, merged here).

## I1 — cognitive (merged `44bc234`)

E2E contract on the trunk: conversation → turn accepted durably (`acceptTurn`, idempotent on the client
key) → context snapshot → `MISSION_REQUEST` → proposal (`cognitive_turn_refs`, states PROPOSED →
APPROVAL_REQUIRED → APPROVED → LAUNCHING → LAUNCHED | FAILED / REJECTED) → human decision
(`missions.write`) → `CanonicalGoalLauncher` (goal intake + `scheduler.enqueue start_mission`, launch id
derived from the proposal) → mission id persisted on the turn ref (`mission_id`, unique partial index)
→ `/api/missions/:id` for progress. Recovery finishes an approved-but-unlaunched ref exactly once.
Proven by L1–L4 / V1–V3 / M1 on PostgreSQL (see merge commit). Not yet proven: the same chain through
`startProductionServices` with a real worker (Phase 8).

## HTTPS / phone access (Phase 13) — procedure, NOT executed

Found: Tailscale installed and signed in on the Mac (`macbook-pro-de-renault.tail2ea2a5.ts.net`,
100.79.85.76); MagicDNS domain `tail2ea2a5.ts.net`; no `tailscale serve` config; one peer, the owner's
Android phone (Xiaomi 13T), offline for 40 days; no launchd unit for ICOS; production auth integrity
requires `BETTER_AUTH_URL` to be https in production (`src/server/auth/integrity.ts:153`).

Simplest secure mechanism: **Tailscale Serve** (tailnet-only, HTTPS with a Let's Encrypt cert issued by
Tailscale, no public exposure, secure context for `getUserMedia`). Owner actions, in order:

1. Enable HTTPS certificates for the tailnet once (admin console → DNS → "Enable HTTPS"); the first
   `tailscale serve` prints the link if it is not enabled.
2. On the Mac, with ICOS listening on 127.0.0.1:3000:
   `tailscale serve --bg --https=443 http://127.0.0.1:3000` · check: `tailscale serve status`
3. Run ICOS in production mode with `BETTER_AUTH_URL=https://macbook-pro-de-renault.tail2ea2a5.ts.net`
   (`NODE_ENV=production PERSISTENCE=postgres … pnpm build && pnpm start`), under launchd so it
   outlives the terminal, and keep the Mac awake (`sudo pmset -c disablesleep 1` or a `caffeinate -s`
   wrapper in the same unit).
4. **Verify the origin guard behind the proxy** before trusting it: from the Mac,
   `curl -sS -o /dev/null -w '%{http_code}\n' -X POST -H 'Origin: https://macbook-pro-de-renault.tail2ea2a5.ts.net' -H 'Content-Type: application/json' -d '{}' https://macbook-pro-de-renault.tail2ea2a5.ts.net/api/cognitive/conversations`
   must answer **401** (no session), not **403** with `cross_origin`: `isSameOriginMutation` compares the
   `Origin` header with `request.url`, so Next must reconstruct `https://` from Tailscale's
   `X-Forwarded-Proto`. If it answers 403, the fix is a one-line trust of `x-forwarded-proto`/`host` in
   `src/server/http/origin.ts` (not applied here: unverified).
5. Sign the phone into Tailscale (it has been offline 40 days), open
   `https://macbook-pro-de-renault.tail2ea2a5.ts.net/cockpit`, log in as the owner, install the PWA.

Voice adds a WebSocket endpoint (`scripts/voice-server.ts`, lane `feat/voice-realtime`); Tailscale Serve
proxies WebSockets on the same hostname with a second path mapping once that port is known.

## Certification log (appended)

| Checkpoint | HEAD | typecheck | unit | integration (PostgreSQL, `icos_integration_test`) | build | notes |
|---|---|---|---|---|---|---|
| I2a control | `beb4afa` | PASS | 1932/1932 | 506 passed / 4 skipped / 0 failed (opt-in E2Es skipped) | — | ledger 47 |
| P0 + I1 cognitive | `44bc234` | PASS | 2006/2006 | cognitive suites 34/34 on `icos_i1_test` (L1–L4, V1–V3, M1) | PASS | ledger 48 |
| I2b cockpit | `5c14ef7` | PASS | 2172/2172 | **540 passed / 4 skipped / 0 failed** | PASS | lint 0 errors |
| Phone/text proof | `09be125`+ | — | — | `PHONE_TEXT_PROOF.md` (real server, real worker) | — | mission `d48b3347…` succeeded |

Trunk suites were run one at a time (other lanes were running their own suites concurrently; no
resource-starvation failure occurred, nothing was retried).

## I3–I6 (2026-09-30 afternoon)

| Wave | What was wired | Left NOT_CONNECTED (owner) |
|---|---|---|
| I3 workforce `0291206` | `container.workforce` (memory + postgres) from the lane's composition; cockpit BR-29 read port with the caller's session principal; composition test with the real bootstrap | supervisor → `workforce.compute` and `recordExecution` from dispatch evidence (CORE3 + workforce: behaviour change on the certified dispatch path); authority ports for tool gateway / cognitive |
| I4 tool gateway `b43a516` | composed per container by the lane (`getToolGatewayRuntime`), `/api/tool-gateway/*`; `audit_event_type_check` union proven 45 → 51; all lanes' governance files in `PROTECTED_PATHS` (CCD-16) | worker tool bridge (external CLI workers cannot call the gateway); connectors beyond `local-files`/`http`; no live tool action was executed (no execute route by design) |
| I5 proactive `0db464d` | lane's production composition on the durable scheduler (`supervisor_observe`), policy ceiling PROPOSE, namespace `core/proactive`; `scheduled_jobs_kind_check` union | ToolGatewayActionPort (dead under PROPOSE), attention delivery (no push adapter — cockpit, CCD-17), EpisodeSink → cognitive memory (needs a system `CognitiveScope.userId` — cognitive, CCD-6), digest into context assembly, workforce capability binding |
| I6 voice `3743a37` | canonical `CognitiveRuntimeVoiceAdapter` (acceptance semantics, replay on voice `turnId`, FINAL_RESPONSE from rows, MISSION/APPROVAL events, abort → cancel, ownership refused) wired in `compose.ts`; legacy CEO bridge removed; `ws` dependency added by the lane | real STT/TTS run against OmniRoute not exercised here; the WebSocket host is a separate process (`pnpm voice:serve`) — Tailscale path mapping pending; mobile-UI commits `49379e1..2eb6e95` pending cockpit-lane review |

Certification: I5 trunk (`0db464d`) full unit 2381/2381; full integration — see the log below once complete.
