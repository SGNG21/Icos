# ICOS Capability Map — RECONNAISSANCE-001

Date: 2026-08-15. Legend — **MERGED**: on `main` (7e2ea80). **UNMERGED**: committed on a local branch only. **UNCOMMITTED**: working-tree only. **DUPLICATE**: same content exists as two+ divergent commits/branches. **DO NOT REBUILD** applies to every row.

## A. Merged on main

| Capability | Key paths | Evidence |
|---|---|---|
| Cockpit domain baseline (agents/tasks/actions/audit contracts, in-memory + Postgres persistence, UoW, internal API) | `src/core/contracts/`, `src/server/repositories/`, `src/server/uow/`, `src/app/api/` | ADR-0002..0006 |
| Human auth + roles + administration (Better Auth, `user_roles`, Lot 2B) | `src/server/auth/`, `src/server/administration/`, `src/app/admin` | ADR-0007, `dd20cf5` (origin/feat/auth-application merged lineage) |
| Compliance foundation + COMPLIANCE-1 classification/tenant | `docs/compliance/`, `src/server/tenant/` | `f52c787`/`e101014`, ADR-0023 |
| Skill Registry & Trust Lifecycle (C2) | `src/core/skills/`, `src/server/services/skill-service.ts`, skill repos + UoW | `700290a` (PR #13); spec `docs/superpowers/specs/2026-07-25-skill-registry-trust-lifecycle-design.md` |
| D1 Policy / Authorization Engine | `src/server/policy/` | `9704118`/`c8cebbe` |
| D2 Mission Engine (durable orchestration) | `src/server/mission/` | `80e80d5`/`8cd58c7` |
| D3 AI Gateway (OmniRoute) | `src/server/ai/` (`AiGatewayPort`, `OmniRouteAdapter`) | `83cbfcc`/`8ac39cb` |
| D4/D4.1 Runtime Execution (process-isolated local adapter, workspace manager, security gates, artifacts) | `src/server/runtime/` | `52e9c0a`..`618ff19` |
| G1.0 Tool Gateway foundation (grants, inspectors, idempotency, sensitivity, atomicity) | tool gateway modules + `docs/superpowers/specs/2026-07-26-g1-tool-gateway-design.md` | `02d8fee`, `06335d6`, `e7f94f8`, `7e2ea80` |

## B. Unmerged — the linear execution chain (all contained in tip `ba610ca`)

Ancestry verified via `merge-base --is-ancestor`: `main` → `5676986` → `6bad007` → `0467985` → `c5167d4` → `62ec0ed` → `94cf920` → `33c67d3` → `ba610ca`. **The single branch `feat/cockpit-real-wiring-1` (`ba610ca`, 49 ahead / 0 behind main) contains ALL of the following:**

| Capability | Commits | Key paths | Worktree |
|---|---|---|---|
| Supervisor/Worker architecture (SUP-0..7): Task DAG + scheduler, local worker manager, worktree/git manager, review/correction loop, integration + global gates, preview delivery, G1-baseline reconciliation | `392e7c5`..`5676986` | `src/server/supervisor/`, `src/server/worker/worker-manager.ts`, `src/server/worktree/worktree-manager.ts`, `src/server/integration/` | `icos-supervisor` |
| Versioned mission context + Context↔Supervisor bridge (precedence rules, E2E) | `2a880d7`, `2fc6fbd`, `9c89c5a`, `bb87af7`, `6bad007` | `src/server/context/` | `icos-ctx-sup-e2e` |
| First autonomous workflow hardening: SystemAgent identity for D1, scoped agent identity propagation Supervisor→Worker→D1, stale-worktree collision handling, worker result hardening | `232fc67`..`0467985` | policy + worker + worktree modules | `icos-auto-1` |
| Global gates (deterministic, DAG-final task-node finalization) | `260af18`, `c5167d4` | supervisor gates | `icos-global-gates` |
| Self-state snapshot (canonical `self-state.v1.json`, contract + loader) | `05776f3` (re-application of `ded591f`) | `src/core/self-state/`, `src/server/self-state/`, `docs/coordination/self-state.v1.json` | `icos-self-state` (original) |
| Runtime capability introspection (`get-capability-snapshot`) | `b27e1f7` (re-application of `4272392`) | `src/server/usecases/get-capability-snapshot.ts` | `icos-capabilities` (original) |
| Governed user mission entry (`create-mission-from-user-request`) | `327939b` (re-application of `f074426`) | `src/server/usecases/create-mission-from-user-request.ts` | `icos-user-mission` (original) |
| Cockpit V1 UI (mission supervision flow, CPT-1 conversation core, view models, mappers, mock store) | `1556cc3`..`dc22ab7` (re-application of `feat/cockpit-v1` chain) | `src/components/`, `src/styles/globals.css` | `icos-cockpit` (original) |
| Self-improve foundation verification record | `62ec0ed` | `docs/coordination/` | `icos-self-improve-foundation` |
| Mission→Supervisor bridge (`plan-and-execute-mission`, bounded mission plan, task-DAG-from-plan) | `94cf920` | `src/core/planning/`, `src/core/supervisor/`, `src/server/usecases/plan-and-execute-mission.ts` | `icos-mission-supervisor-bridge`, `icos-runtime-safety` |
| Runtime safety hardening (local execution + worktree isolation) | `33c67d3` (= `a827c74`, byte-identical, verified empty diff) | runtime adapters, worktree-manager, supervisor-service | `icos-runtime-safety-review` |
| Cockpit real wiring (real mission execution, job polling, OmniRoute health/evidence, conversational streaming) | `90bff5b`..`ba610ca` | cockpit + `src/server/ai/` | `icos-cockpit-real` |

## C. Unmerged — outside the chain

| Capability | Branch/commit | Status | Notes |
|---|---|---|---|
| Voice V0 conversation flow (speech synthesis, voice session hook, OmniRoute streaming tweaks) | `feat/voice-v0` `5f82d17` | UNMERGED, 1 ahead / 4 behind (based on `618ff19`, pre-G1) | `src/features/voice/`; needs rebase onto integrated main |
| Governed Claude Code runtime bootstrap (CLAUDE.md, agents, rules, skills, .icos governance) | current branch `0352fab` | UNMERGED, sits on stale base | Unique with `9efaf1a` (CT-DOC-07–10) |
| Governance reconciliation design + early tool contracts | `icos-governance` UNCOMMITTED (10 entries on stale base `531a8b8`) | Mostly superseded by main G1.0; **spec `2026-07-26-governance-reconciliation-design.md` unique** | Preserve doc before any cleanup |
| Deterministic patch worker | `icos-runtime-safety` untracked `src/server/worker/deterministic-patch-worker.{ts,test.ts}` (also committed inside `33c67d3`/`a827c74`) | Duplicated | Verify equality before discarding dirty copy |

## D. Duplicates requiring reconciliation (do not implement any of these again)

| Content | Copy 1 | Copy 2 | Verified relationship |
|---|---|---|---|
| Skill registry trust lifecycle | main `700290a` | current branch `17b3196`; also `icos-c2-clean` (`4388fa7`, fully merged into main) | byte-identical src |
| Self-state / capabilities / user-mission / cockpit-v1 | original branches `ded591f`, `4272392`, `f074426`, `e4f6431` | re-applied as `05776f3`, `b27e1f7`, `327939b`, `dc22ab7`-chain inside `62ec0ed` lineage | same subjects, different hashes (rebase); **[UNCERTAIN: content equality not diffed file-by-file]** |
| Ctx-sup work | `feat/ctx-sup-1` (`6f99109`, NOT ancestor of chain) | re-applied `9c89c5a`/`2fc6fbd`/`2a880d7` in chain | same subjects, different hashes |
| Runtime-safety hardening | `a827c74` (review branch) | `33c67d3` (in-chain) + dirty tree in `icos-runtime-safety` | `a827c74` ≡ `33c67d3` byte-identical; dirty tree ≈ same ± ~50 lines in worktree-manager |
| Cockpit real wiring | `432cbaa` (review branch) | `90bff5b` (in-chain) | same subject; **[UNCERTAIN: not diffed]** |
| D-lot pairs (`9704118`/`c8cebbe`, `80e80d5`/`8cd58c7`, `83cbfcc`/`8ac39cb`, `52e9c0a`/`531a8b8`) | — | — | duplicate-subject pairs already inside main history (historical rebases; no action) |

## E. Obsolete / archivable candidates (owner decision required; do NOT delete during recon)

- `icos-compliance1` (checkout of `main`, clean, duplicate working copy)
- `icos-c2-clean` (fully merged into main)
- `icos-review` (`review/integration-readiness`, 37 behind, historical review snapshot)
- `icos-d4`, `icos-d4-1`, `icos-g1-design`, `icos-lead` (behind main; superseded by merged D4/G1 — after rescuing the untracked specs in `icos-lead` and confirming `icos-g1-design` copy is identical, which it is)
- `.claude/worktrees/feat+d1-policy`, `feat+d2-orchestration`, `feat+d3-omniroute`, `feat+g1-0-foundation` (merged lots); `feat+g1-0-foundation-v2` (`7fc1910` docs commit — **[UNCERTAIN: whether its canonical-design doc differs from main's `02d8fee`]**)
