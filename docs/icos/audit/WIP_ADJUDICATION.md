# WIP_ADJUDICATION — dirty-worktree snapshots vs integration candidate

Date: 2026-08-15. Question under review (Phase 1, item 7): **does any WIP snapshot contain fixes the candidate (`feat/cockpit-real-wiring-1` @ `ba610ca`) actually needs?**
Method: for each `wip/*-dirty-2026-08-15` snapshot (created during RECON-001 preservation, each = one commit on top of its worktree's HEAD capturing tracked+untracked dirt), compare the snapshot's dirty files against the candidate tip. No WIP content was mixed into the candidate; all comparisons read-only.

## Verdict summary: **NO WIP contains fixes the candidate needs.** Zero adoption recommended.

| Snapshot | Base (ancestry vs candidate) | Dirty files | Adjudication |
|---|---|---|---|
| `wip/runtime-safety-dirty-2026-08-15` | `94cf920` (in-spine) | 18 (src + tests) | **Superseded weaker precursor.** The candidate's `33c67d3` hardening ADDED `validateTaskWorktree`, `assertOnlyDeclaredChanges`, canonical-path/branch validation in `assignToTask`, guarded `deleteBranchIfPresent`, exact-line worktree matching. The WIP lacks all of these (substring `.includes` checks, unguarded `branch -D`, `baseSha: ""`). Adopting it would be a **security downgrade**. The residual +56 lines it holds vs candidate are test-fixture variance only. Resolves reconciliation-plan item 2.3: the "~50-line worktree-manager delta" does NOT add value — discard candidate-side; snapshot retained for archaeology |
| `wip/governance-dirty-2026-08-15` | `531a8b8` (pre-main) | 10 (G1 tool-gateway code + 2 specs) | **Superseded by main's G1.0.** WIP layout (`src/server/repositories/postgres/tool-repository.ts`, `src/core/contracts/tool.ts`, `src/g1-0-foundation.test.ts`) exists in neither main nor candidate; canonical implementation lives at `src/server/g1/` (approved). Confirms reconciliation-plan item 2.4. The two specs were already rescued on the docs branch |
| `wip/g1-0-foundation-v2-dirty-2026-08-15` | `7fc1910` (off-spine) | 14 (UoW code) | **Superseded by main's G1.0.** WIP's `src/server/uow/{g1-uow-ports,in-memory-g1-uow,postgres-g1-uow}.ts` and `g1-schema.ts` exist in neither main nor candidate; canonical UoW is `src/server/g1/in-memory/g1-unit-of-work.ts`. Abandoned earlier layout |
| `wip/add-mission-lifecycle-tests-dirty-2026-08-15` | `ee42613` (off-spine, merged into spine at `0467985` per RECON) | 136 | **Stale divergence.** Bidirectional churn vs candidate (+3289/−3793 on its own files); mixture of skills/docs/architecture drafts and worker/worktree src state predating the spine's later evolution. No focused fix identifiable; too divergent for adoption. Snapshot preserved; deep re-review only on owner request |
| `wip/d2-orchestration-dirty-2026-08-15` | `80e80d5` (pre-main) | 2 | Docs-only (`docs/coordination/*`). No code. Not needed |
| `wip/cockpit-dirty-2026-08-15` | `e4f6431` (off-spine) | 1 | Docs-only: the 974-line cockpit V1 implementation plan — already rescued on the docs branch during preservation. Not needed by candidate |
| `wip/g1-design-dirty-2026-08-15` | `531a8b8` (pre-main) | 1 | Docs-only: G1 tool-gateway design spec evolution (+891/−339 vs candidate's committed copy). Potentially valuable as documentation — route to a docs branch decision, NOT into the candidate |
| `wip/lead-dirty-2026-08-15` | `8ac39cb` (pre-main) | 1 | Docs-only: D4 runtime-execution spec evolution (+1103/−403). Same routing as above |
| `wip/cockpit-real-dirty-2026-08-15` | `ba610ca` (= candidate tip) | 1 | `next-env.d.ts` 1-line generated-file drift. Cosmetic; ignore |

## Method notes / corrections
- An initial pass using an unquoted shell variable as multi-file pathspec produced false "identical" results (zsh does not word-split variables; the pathspec matched nothing). All multi-file comparisons were re-run with correct splitting; the table above reflects the corrected runs.
- Diff direction convention: `git diff candidate..wip` — insertions = content only the WIP has; deletions = content only the candidate has.

## Consequences for later phases
- Reconciliation-plan 2.3 (runtime-safety delta): resolved — no PR needed; owner sign-off requested to mark the WIP branch archival-only.
- Reconciliation-plan 2.4 (governance dirty code): resolved — superseded confirmed by layout comparison.
- Doc-evolution snapshots (`g1-design`, `lead`, `cockpit`) hold documentation value only; candidate integration is independent of them.
