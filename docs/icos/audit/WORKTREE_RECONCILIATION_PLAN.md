# Worktree Reconciliation Plan — RECONNAISSANCE-001

Date: 2026-08-15. This is a PLAN, not an execution record. Every step is reversible or explicitly flagged. Nothing here was executed during reconnaissance. Owner approval is required before any step that touches git state (BOOT-001 default profile is AUDIT/write:false; GOV-AUTH-001 puts irreversible actions at APPROVAL level).

## Guiding facts (verified)

1. The integration spine is **linear**: `main (7e2ea80)` → `5676986` supervisor → `6bad007` ctx-sup-e2e → `0467985` auto-1 → `c5167d4` global-gates → `62ec0ed` self-improve → `94cf920` mission-supervisor-bridge → `33c67d3` runtime-safety hardening → `ba610ca` cockpit-real-wiring. Tip `ba610ca` is 49 ahead / 0 behind main — **a fast-forward candidate** (after review).
2. All worktrees are mis-registered (moved into repo root; `prunable`). **Never run `git worktree prune` until repaired.**
3. Unique uncommitted artifacts exist in `icos-governance`, `icos-lead`, `icos-runtime-safety`, `icos-cockpit`.

## Phase 0 — Preservation (P0, fully reversible, do first)

- 0.1 Push every local branch to origin as backup (`git push origin <branch>` for the 19 unpushed branches). Additive, reversible (remote branch delete). Requires owner approval for push per AGENTS.md ("never push without explicit authorization").
- 0.2 Snapshot dirty worktrees without touching history: from each dirty worktree create a stash-with-untracked or a `wip/`-prefixed commit on a new branch (e.g. `wip/runtime-safety-dirty-2026-08-15`). Reversible.
- 0.3 Rescue unique docs regardless: `2026-07-26-governance-reconciliation-design.md` (icos-governance), `2026-07-25-d4-runtime-execution-design.md` (icos-lead), `2026-07-26-icos-cockpit-v1-implementation-plan.md` (icos-cockpit) — commit them on a `docs/rescued-specs` branch.
- 0.4 Repair worktree registration. Options: (a) move directories back to their registered sibling paths (`/Users/coco/icos-*`); (b) `git worktree repair <path>` from each current location; (c) `git worktree move`. Option (b) executed per-worktree is least disruptive. Reversible (repair again). Decide first whether worktrees should live inside the repo root at all — if yes, add `icos-*/` to `.gitignore` to clean `git status`; if no, restore sibling layout.

## Phase 1 — Integrate the spine (P1)

- 1.1 Review `main..ba610ca` (49 commits) as ONE reviewed PR (or 3 stacked PRs: supervisor+ctx+auto+gates / self-improve+bridge / runtime-safety+cockpit-real). Evidence gates before merge: `env -u NODE_ENV -u PERSISTENCE pnpm check` on `ba610ca`, plus integration tests where Docker available.
- 1.2 Merge to main (fast-forward or merge commit — merge commit recommended to preserve a review record). Reversible via revert.
- 1.3 Immediately re-verify: `feat/mission-supervisor-bridge-1`, `feat/runtime-safety-foundation-1`, `review/runtime-safety-foundation-1`, `review/cockpit-real-wiring-1`, `feat/global-gates-1`, `integration/*` all become ancestors of main → mark MERGED.

## Phase 2 — Rebase the stragglers (P1/P2)

- 2.1 Current branch `feat/skill-registry-trust-lifecycle`: cherry-pick `0352fab` (governance bootstrap) + `9efaf1a` (CT-DOC-07–10) onto post-spine main as a new branch (e.g. `feat/governed-runtime-bootstrap`); open PR. The `17b3196` skill commit is dropped (already in main as `700290a`). Reversible.
- 2.2 `feat/voice-v0` (`5f82d17`): rebase single commit onto new main; resolve OmniRoute adapter conflicts (it touches `src/server/ai/omniroute-adapter.ts`, also modified by `ba610ca`). Reversible (original ref kept).
- 2.3 `icos-runtime-safety` dirty delta: diff the wip snapshot (0.2) against merged main; if the ~50-line worktree-manager delta adds value, submit as a small PR; else discard (owner sign-off, since discard is irreversible).
- 2.4 `icos-governance` dirty code files: expected superseded by main G1.0 — verify by diff against main; keep only the rescued spec (0.3).

## Phase 3 — Duplicate adjudication (P2)

For each duplicate pair, produce a file-level diff before declaring the original redundant:

| Pair | Expected outcome |
|---|---|
| `ded591f` vs `05776f3` (self-state) | original redundant |
| `4272392` vs `b27e1f7` (capabilities) | original redundant |
| `f074426` vs `327939b` (user-mission) | original redundant |
| `feat/cockpit-v1` chain vs `dc22ab7` chain | original redundant (but rescue its plan doc, 0.3) |
| `feat/ctx-sup-1` vs in-chain ctx commits (note: `6f99109` has `bd97dae` "persist versioned mission context" vs `2fc6fbd` twin) | verify then redundant |
| `432cbaa` vs `90bff5b` (cockpit real wiring) | verify then redundant |
| `a827c74` vs `33c67d3` | already verified byte-identical |

## Phase 4 — Archive & cleanup (P3, owner approval per item; irreversible steps flagged)

- 4.1 Tag every redundant branch head (`archive/<branch>-<date>`) before deletion — makes branch deletion reversible via tag.
- 4.2 Remove redundant worktrees with `git worktree remove` (NOT prune) after 4.1: `icos-compliance1`, `icos-c2-clean`, `icos-review`, `icos-d4`, `icos-d4-1`, `icos-g1-design`, `icos-lead`, review worktrees, and originals adjudicated in Phase 3. Directory deletion is irreversible → APPROVAL level.
- 4.3 Only after all of the above: `git worktree prune` becomes safe for genuinely stale admin entries (`add-mission-lifecycle-tests`, `realwt-test`, `test-worker-node` under `icos-auto-1/.claude/worktrees` — verify their branches `ee42613`, `63bab46`, `c8aa5ca` are ancestors of `0467985` first; `ceae0d7`/`c8aa5ca`/`63bab46` merges in auto-1 log suggest yes, **[UNCERTAIN — verify]**).

## Explicit non-actions during reconnaissance

No worktree touched, no branch created/deleted/pushed, no file modified outside `docs/icos/audit/` and `.icos/tasks/`. The `prunable` state was left as-is.
