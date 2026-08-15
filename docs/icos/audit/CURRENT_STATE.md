# ICOS Current State — RECONNAISSANCE-001

Date: 2026-08-15. Read-only audit. All statements below carry evidence (commit hash, file path, or observed command output). Uncertainties are marked **[UNCERTAIN]**; contradictions are preserved, not resolved.

## 1. Repository identity

- Path: `/Users/coco/icos`, Next.js 16 / React 19 / TypeScript strict / Tailwind 4 / Vitest / Drizzle+postgres.js / Better Auth, pnpm (see `/Users/coco/icos/README.md`).
- Remote: `origin` (GitHub). Default branch `main`.
- **Checked-out branch of the primary working tree: `feat/skill-registry-trust-lifecycle` at `0352fab` — 3 ahead / 19 BEHIND `main` (`7e2ea80`).** Merge-base: `0a91604`.

## 2. What `main` (7e2ea80) contains

`git log 0a91604..main` (19 commits) shows main already includes, beyond the auth/administration/persistence baseline:

| Lot | Commits | Content |
|---|---|---|
| Skill Registry & Trust Lifecycle (C2) | `77b6430`, `4388fa7`, `700290a` (PR #13) | `src/core/skills/`, `src/server/services/skill-service.ts`, postgres/in-memory skill repositories, skill UoW |
| COMPLIANCE-1 | `f52c787`, `e101014` | data classification, tenant foundation |
| D1 Policy/Authorization Engine | `9704118`, `c8cebbe` | `src/server/policy/` (`d1-policy-service.ts`, `ports.ts`) |
| D2 Durable Orchestration (Mission Engine) | `80e80d5`, `8cd58c7` | `src/server/mission/ports.ts` + mission engine |
| D3 AI Gateway / OmniRoute | `83cbfcc`, `8ac39cb` | `AiGatewayPort` + `OmniRouteAdapter` |
| D4 / D4.1 Runtime Execution Engine | `52e9c0a`, `531a8b8`, `c79f357`, `618ff19` | `src/server/runtime/` (execution-orchestrator, local-runtime-adapter with process isolation, workspace-manager, security-gates, artifact-collector) |
| G1.0 Tool Gateway foundation | `02d8fee` (design), `06335d6`, `e7f94f8`, `7e2ea80` | tool gateway foundation, idempotency/sensitivity/atomicity corrections; spec `docs/superpowers/specs/2026-07-26-g1-tool-gateway-design.md` |

Total delta merge-base→main: 118 files, ~20,349 insertions. Main also has `docs/ICOS_MASTER_PLAN.md` and `docs/coordination/` (absent from the current checkout).

## 3. What the current branch adds over merge-base (3 commits)

- `9efaf1a` — docs: CT-DOC-07–10 compliance tests (9 lines in `docs/compliance/ICOS_COMPLIANCE_TESTS.md`). **Not in main.**
- `17b3196` — feat(skills): registry trust lifecycle. **Byte-identical to what main merged as `700290a` (PR #13)** — verified: `git diff 17b3196 700290a -- src/core/skills src/server/services/skill-service.ts` is empty; total diff between the two trees is only the CT-DOC lines and one whitespace fix.
- `0352fab` (2026-08-15) — chore(icos): bootstrap governed Claude Code runtime: `CLAUDE.md`, `.claude/agents/` (11 executive agents), `.claude/rules/` (quality, security, database), `.claude/skills/` (task-contract, build-vs-reuse, safe-release, etc.), `.icos/policies/` (5), `.icos/decisions/` (DEC-0001..0010), `.icos/schemas/` (3). **Not in main.**

So the only unique value on the current branch = governance bootstrap + 9 doc lines. Everything else is duplicate of, or behind, main.

## 4. Governance layer

- Policies (`/Users/coco/icos/.icos/policies/`): BOOT-001 (default profile AUDIT, write:false), GOV-AUTH-001 (AUTO/REPORT/APPROVAL/VETO levels), AI-DATA-001 (PROVISIONAL), REL-001 (release gates), SEC-BASE-001 (deny rules: tenant-required, explicit-permission, no direct prod DB for agents, no secrets in repo).
- Decisions: DEC-0001..DEC-0010 all ACCEPTED, all citing "ICOS master blueprint v2.0", all with `evidence: []`.
- Schemas: `agent`, `decision`, `task-contract` JSON Schemas in `.icos/schemas/`.
- **CONTRADICTION C1**: `CLAUDE.md` step 2 mandates reading `docs/icos/constitution/ICOS_CONSTITUTION.md`, but that file exists in **no working tree, no worktree, and no branch** (verified by `find` across all `icos-*` dirs and `git grep` across all branch heads — the only hit is CLAUDE.md itself referencing it, in `0352fab`).
- **CONTRADICTION C2**: `CLAUDE.md` says "use a Task Contract", and `.icos/schemas/task-contract.schema.json` exists, but no `.icos/tasks/` directory existed anywhere before this audit created it.
- ADR numbering gap: `docs/decisions/` has 0001–0007 then jumps to `0023-compliance-foundation.md`. D1–D4/G1 have design specs under `docs/superpowers/specs/` but no ADR files in `docs/decisions/`, while CLAUDE.md states "architecture changes require ADR/Decision". **[Both sides preserved: specs exist and were treated as design authority; the ADR series does not record them.]**

## 5. Worktree topology anomaly (critical)

`git worktree list` registers 28 linked worktrees at **sibling** paths (`/Users/coco/icos-supervisor`, …) and marks all of them **prunable**, yet the directories physically exist **inside the repo root** (`/Users/coco/icos/icos-supervisor`, …) with `.git` files still pointing at `/Users/coco/icos/.git/worktrees/<name>`. The directories were physically moved after registration.

Consequences:
- `git status` in the main tree shows 25 `icos-*/` untracked directories (they are relocated worktrees, NOT junk).
- **Any `git worktree prune` (or GC that triggers it) would delete the administrative data for all of them while ~24k+ lines of unmerged work sit on their branches.** Do not prune. Repair registration instead (owner action; see WORKTREE_RECONCILIATION_PLAN.md).
- Five additional managed worktrees live under `/Users/coco/icos/.claude/worktrees/` (d1/d2/d3, g1-0-foundation, g1-0-foundation-v2) — these are correctly registered (not prunable).

## 6. Remote/backup state (critical)

Branches on `origin`: `main`, `feat/d1-policy`, `feat/d2-orchestration`, `feat/d3-omniroute`, `feat/d4-runtime`, `feat/d4-1-real-local-runtime`, `feat/compliance-1-classification`, `feat/auth-application`, `feat/skill-registry-trust-lifecycle`, `feat/skill-registry-trust-lifecycle-clean`.

**NOT pushed anywhere** (local-only): the entire post-G1 execution chain — `feat/supervisor-worker`, `feat/ctx-sup-1`, `feat/ctx-sup-e2e`, all `integration/dag-*`, `feat/global-gates-1`, `integration/self-improve-foundation-1`, `feat/self-state-1`, `feat/capability-introspection-1`, `feat/user-mission-entry-1`, `feat/mission-supervisor-bridge-1`, `feat/runtime-safety-foundation-1`, `review/runtime-safety-foundation-1`, `feat/cockpit-v1`, `feat/cockpit-real-wiring-1`, `review/cockpit-real-wiring-1`, `feat/voice-v0`, `feat/governance-reconciliation`, `feat/g1-tool-gateway-design`. Single-machine loss risk for ~49 commits / ~28k insertions of work.

## 7. Test evidence (observed, non-mutating)

- `pnpm test` on the current checkout: **2 failed / 558 passed (45 files, 560 tests)** — both failures in `src/server/container.async.test.ts` (`PersistenceConfigError: PERSISTENCE doit être défini explicitement en production`).
- Re-run of the failing file with `env -u NODE_ENV -u PERSISTENCE pnpm vitest run src/server/container.async.test.ts`: **2 passed / 2**.
- Conclusion: failures are caused by `NODE_ENV`/`PERSISTENCE` leaking from the ambient shell environment, not by broken code. `.claude/settings.local.json` history shows the team already runs tests as `env -u NODE_ENV -u PERSISTENCE pnpm test`. Gap: vitest config does not neutralize ambient env itself.
- Worktree test suites were NOT run (would require installs / long runs across 25 trees). **[UNCERTAIN: green status of each worktree branch is claimed by their commit messages ("close reconciliation lint gate", "record self-improve foundation verification") but not re-verified in this audit.]**
- No CI exists (`.github/` absent).

## 8. Security/hygiene observations

- `.claude/settings.local.json` is untracked and never committed (verified `git log --all -- .claude/settings.local.json` empty) but contains one permission entry embedding what appears to be a live gateway auth token (an `ANTHROPIC_AUTH_TOKEN` value for a localhost OmniRoute proxy). Not reproduced here per security rule. Recommend rotation and removal from the allowlist entry (owner action).
- `next-env.d.ts` is modified in the working tree (generated-file drift: `./.next/types/routes.d.ts` → `./.next/dev/types/routes.d.ts`). Same drift appears in `icos-cockpit-real`. Harmless, tool-generated.
- No secrets found in tracked files during this audit (not an exhaustive secret scan).

## 9. Dirty worktrees (uncommitted work at risk)

| Worktree | Entries | Content | Risk |
|---|---|---|---|
| `icos-runtime-safety` | 18 | Runtime-safety hardening (supervisor-service, worktree-manager, deterministic-patch-worker + tests) | LOW-MEDIUM: content is ~identical to committed `a827c74`/`33c67d3` except ~50-line deltas in `worktree-manager.{ts,test.ts}` (verified `git diff a827c74 --stat`: 15 insertions net of untracked) |
| `icos-governance` | 10 | Early G1/tool contracts (`src/core/contracts/tool.ts`, tool repositories, `g1-0-foundation.test.ts`) + **`docs/superpowers/specs/2026-07-26-governance-reconciliation-design.md` which exists nowhere else** | MEDIUM: mostly superseded by main's G1.0, but the reconciliation design doc is unique and uncommitted |
| `icos-cockpit` | 1 | untracked implementation plan doc | LOW |
| `icos-g1-design` | 1 | untracked copy of G1 spec (identical to main's) | NONE |
| `icos-lead` | 1 | untracked D4 design spec `2026-07-25-d4-runtime-execution-design.md` — **[UNCERTAIN whether identical to a committed version]** | LOW-MEDIUM |
| `icos-cockpit-real` | 1 | `next-env.d.ts` drift | NONE |

## 10. Architecture of the current checkout (src/)

`src/app` (routes incl. `admin`, `login`, `api/*`), `src/components` (administration, auth, features, layout), `src/core` (contracts, authorization, identity, skills, tasks, capabilities), `src/features` (demo data, actions/agents/tasks), `src/config` (env via Zod), `src/server` (administration, audit, auth, database, http, repositories, services, uow, usecases). Main adds on top: `policy/`, `mission/`, `ai/` (via D3), `runtime/`, `tenant/`, tool gateway modules. Docs: ADRs 0001–0007+0023, `docs/architecture/overview.md` + `docs/architecture/future/` (12-file future architecture: lot catalogue, dependency graph, critical path, risk register, parallelization), `docs/compliance/` (9 files), `docs/superpowers/specs+plans`.
