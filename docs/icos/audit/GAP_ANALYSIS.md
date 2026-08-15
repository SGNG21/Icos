# ICOS Gap Analysis — RECONNAISSANCE-001

Date: 2026-08-15. Gaps are ordered by severity. Each cites evidence. Contradictions preserved per audit mandate.

## G1 — Unmerged, unpushed execution chain (severity: critical, loss-risk)

~49 commits / ~28k insertions (supervisor/worker, task DAG, mission context bridge, autonomous workflow, global gates, self-state, capability introspection, user mission entry, cockpit V1 + real wiring, runtime safety hardening) exist only on local branches on one machine. Tip: `feat/cockpit-real-wiring-1` (`ba610ca`), 49 ahead / 0 behind main. Evidence: `git branch -r` shows none of these on origin.

Gap: no backup, no PRs, no review record on the remote for the most valuable capability layer of the project.

## G2 — Worktree registration broken (severity: critical, operational)

All 28 sibling-registered worktrees are marked `prunable` because the directories were moved inside the repo root. One `git worktree prune` destroys their admin metadata. Evidence: `git worktree list` output vs `ls /Users/coco/icos`. Gap: registration must be repaired (owner-approved operation), and repo-root pollution (25 untracked `icos-*/` dirs shadowing `git status`) must be resolved by relocation-with-repair, not deletion.

## G3 — Governance references missing artifacts (severity: high, contradiction)

- **C1**: `CLAUDE.md` mandates `docs/icos/constitution/ICOS_CONSTITUTION.md`; the file exists on no branch, no worktree. Either the constitution was never written, or it lives outside this repository. **[UNCERTAIN which; both possibilities preserved.]** Decisions DEC-0001..0010 all cite an "ICOS master blueprint v2.0" that is also not in this repo (`docs/ICOS_MASTER_PLAN.md` exists on main — **[UNCERTAIN whether it is the referenced blueprint]**).
- **C2**: Task Contract workflow mandated; `.icos/tasks/` did not exist until this audit created it.
- All 10 accepted decisions have `evidence: []` despite CLAUDE.md's "completion requires evidence".

## G4 — Current checkout is on a stale, partially-duplicate branch (severity: high)

The primary working tree (where the governance bootstrap `0352fab` was committed) is 19 behind main and re-implements (identically) the already-merged skill registry. Unique content (governance bootstrap + CT-DOC-07–10) is stranded on a stale base. Evidence: `git rev-list --left-right --count main...HEAD` → `19 3`; empty diff `17b3196` vs `700290a` on src.

## G5 — ADR/decision record does not cover the merged architecture lots (severity: medium, contradiction)

CLAUDE.md: "architecture changes require ADR/Decision". D1–D4, G1.0, C2, tenant foundation were merged with design specs in `docs/superpowers/specs/` but no ADRs in `docs/decisions/` (series jumps 0007 → 0023). Both practices coexist in the repo; neither has been declared canonical. Preserved as a contradiction, not resolved here.

## G6 — Duplicated/diverged history requiring reconciliation (severity: medium)

Four original feature branches (`feat/self-state-1`, `feat/capability-introspection-1`, `feat/user-mission-entry-1`, `feat/cockpit-v1`) plus `feat/ctx-sup-1` and two `review/*` branches have re-applied twins inside the integrated chain. Merging the chain makes originals redundant, but content equality is only verified for runtime-safety (`a827c74` ≡ `33c67d3`) and skills. File-level diffs of the other pairs are pending (see reconciliation plan).

## G7 — Uncommitted unique artifacts (severity: medium)

- `icos-governance`: `docs/superpowers/specs/2026-07-26-governance-reconciliation-design.md` exists nowhere else, uncommitted.
- `icos-lead`: `docs/superpowers/specs/2026-07-25-d4-runtime-execution-design.md` untracked; committed twin unverified.
- `icos-runtime-safety`: ~50-line worktree-manager delta vs `a827c74` uncommitted.

## G8 — No CI / no automated gates (severity: medium)

`.github/` absent. Release policy REL-001 requires tests_pass + security_gate_pass + evidence_bundle, but nothing enforces it mechanically. Global-gates capability exists in the unmerged chain (`c5167d4`) — the enforcement machinery is itself stuck in G1's unmerged chain.

## G9 — Test-environment fragility (severity: low-medium)

`pnpm test` fails (2/560) when ambient `NODE_ENV`/`PERSISTENCE` leak in; passes with `env -u NODE_ENV -u PERSISTENCE`. The team works around it manually (visible throughout `.claude/settings.local.json` allowlist history). Gap: vitest config should pin the env.

## G10 — Secret hygiene (severity: low-medium, contained)

A gateway auth token is embedded in a permission string in untracked `.claude/settings.local.json` (never committed — verified). Rotation + removal recommended. Local-only exposure.

## G11 — Voice V0 stranded (severity: low)

`feat/voice-v0` based on pre-G1 main (4 behind), untouched since 2026-07-26. Needs rebase onto the reconciled main to stay usable.

## What is NOT a gap (explicitly, to prevent rebuilding)

Mission engine, policy engine, AI gateway, runtime execution, tool gateway, skill registry, tenant foundation, auth/administration: **already on main**. Supervisor/worker, task DAG, context bridge, global gates, self-state, capability introspection, user mission entry, cockpit V1/real, runtime-safety hardening: **already committed on `ba610ca` lineage**. Voice V0: committed on `5f82d17`. Any new work on these topics must start from the existing commits.
