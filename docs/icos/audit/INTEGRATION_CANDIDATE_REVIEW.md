# INTEGRATION_CANDIDATE_REVIEW — feat/cockpit-real-wiring-1 → main

Date: 2026-08-15. Phase 1 REVIEW ONLY (no merge performed). Reviewer: principal-architect session under RECON-001 governance. Companion documents: `COMMIT_MAP_49.md`, `CANDIDATE_SECURITY_REVIEW.md`, `WIP_ADJUDICATION.md`.

## 1. Ancestry (verified)
- merge-base `7e2ea80125139c0546be7184b9f2b0484165da7c` = `main` exactly.
- candidate `feat/cockpit-real-wiring-1` = `ba610ca3d9d725b774c57c0ebba604a10e280847`.
- `git merge-base --is-ancestor main candidate` → true; `git rev-list --left-right --count main...candidate` → **0 behind / 49 ahead**.
- **Pure fast-forward candidate.** Exactly one merge commit in range (`9211851`, second parent = main itself) — topologically clean.

## 2. Commit map (see COMMIT_MAP_49.md)
Nine coherent groups: SUP-0..7 foundation → G1 reconciliation → ctx↔sup bridge → integration admin → D1 identity + hardening → capabilities/self-state/mission → cockpit V1 → mission bridge + runtime hardening → real wiring + OmniRoute. All 5 suspected rebase-twin pairs verified IDENTICAL patch-id (standalone branches redundant). The same-subject pair `9211851`/`bc164f3` is NOT a duplicate (disjoint files). Cockpit date inversion = rebase replay, benign.

## 3. File-level architecture diff
- **159 files: 140 added, 19 modified, 0 deleted** — near-purely additive.
- Distribution: `src/server` 65, `src/core` 39, `src/features` 18, `src/components` 18, `src/app` 4, docs 7, scripts 3, config 3, drizzle 2.
- **Migration**: one, additive-only (`drizzle/0009_mission_context.sql` — `mission_contexts`, tenant-keyed composite PK `(tenant_id, mission_id, version)` acting as fail-closed optimistic lock, append-only). Rollback = `DROP TABLE` (no data loss risk on rollback of a new table). **No RLS declared** — see §4.
- Sensitive modifications reviewed line-by-line:
  - `src/core/policy/contract.ts`: `PolicyActor.kind` gains `"system"` (D1 SystemAgent) — cross-checked in security review (§6).
  - `src/core/runtime/contract.ts`: **hardening** — removes "success without spawn" compat; absent command now fails closed with `INTERNAL_ERROR`.
  - `eslint.config.mjs`: adds ignore for `.claude/worktrees/**` (worker worktrees) — benign.
  - `vitest.config.ts`: adds `.test.tsx` include — benign.
- **Test-weakening check**: `*.test.ts` delta = **+14,166 / −58**; all 58 deletions sit inside four files with large rewrites adapting to the fail-closed hardening (the deleted assertions tested the removed fake-success behavior). **No weakening pattern found.** `11a84e4` strengthens default-deny (missing authorizationLevel → deny).

## 4. Governance validation (.icos/policies, .icos/decisions, CLAUDE.md)
Aligned:
- SEC-BASE-001 explicit-permission default-deny: reinforced by `11a84e4` and D1 identity propagation.
- AI-DATA-001 / DEC-0009 (local compute preferred): OmniRoute local gateway wiring is consistent.
- DEC-0004 (no direct unrestricted agent DB access): workers reach data via service layer; no direct-DB path added (security review §Dimension 2 concurs).
- BOOT-001 / GOV-AUTH-001: no permanent elevation added; but see approval-gate findings in §6.

**Contradictions (preserved, not resolved — per directive):**
1. **DEC-0003 vs repo reality**: DEC-0003 mandates defense-in-depth with PostgreSQL RLS. **No migration in the entire repo declares RLS** (grep across all `drizzle/*.sql` empty), including pre-existing tables. The candidate's `mission_contexts` follows the established app-layer-authz pattern — a pre-existing repo-wide gap the candidate neither fixes nor worsens. Security review independently flags the same (needs ADR or RLS policy before multi-tenant production data).
2. **CLAUDE.md "architecture changes require ADR/Decision" vs candidate**: the candidate ships a major architecture (supervisor/worker) with 3 design specs + 1 plan under `docs/superpowers/`, but `.icos/decisions/` is untouched — no formal DEC records the supervisor architecture. Specs exist; formal decision record does not.

## 5. Evidence gates (run in candidate worktree `icos-cockpit-real` @ ba610ca, `env -u NODE_ENV -u PERSISTENCE`)
| Gate | Result |
|---|---|
| `pnpm lint` | PASS (0 errors, 146 warnings) |
| `pnpm typecheck` | PASS |
| `pnpm format:check` | **FAIL — 143 files.** Attribution: **84 files untouched by the candidate** (the merge-base itself fails Prettier — pre-existing debt), **59 files are candidate-authored** (real candidate defect; mechanical fix) |
| `pnpm test` (vitest) | **PASS — 106 files, 1656/1656 tests** (run directly; the `&&` chain in `pnpm check` stops at format:check) |
| `pnpm compliance:check` | PASS (classification markers conform) |
| `pnpm compliance:scan-secrets` | PASS (no secret patterns) |
| `pnpm build` (next build) | PASS (compiled successfully) |

No test, config, or application code was altered to obtain these results.

## 6. Security review (independent security-reviewer agent — see CANDIDATE_SECURITY_REVIEW.md)
Verdict: **SECURITY_OK_WITH_FIXES** — BLOCKER 0 | HIGH 2 | MEDIUM 5 | LOW 5 | INFO 5. Must-fix pre-merge:
- **F5.2 (HIGH)** `scripts/first-auto-mission.ts:984-1037` — autonomous `git push` + `gh pr create` gated only on ambient `gh auth status`; external effect without human approval or D1 ExternalEffectGate; prints self-attested "PASS".
- **F5.1 (HIGH)** `src/server/review/reviewer-worker.ts:92-133` — V1 review gate is a rubber stamp (unconditional passes; `ensureIndependentReview` vacuous; `CorrectionWorker` claims CORRECTED without acting).
- **F3.1/F3.2 (HIGH-latent)** `src/server/worker/worker-manager.ts:138` — throws only on `deny`; `require_approval` falls through (currently backstopped by ExecutionOrchestrator re-check; unbackstopped in `first-auto-mission.ts:123`).
- **F4.1 (MEDIUM)** `scripts/first-auto-mission.ts:176,207` — falls back to main repo root when `worktreePath` empty → escapes worktree isolation.
- **F6.1 (MEDIUM)** `src/server/integration/global-gates.ts:112-123` — runs `pnpm test/build` on freshly integrated worker code with full inherited env (secret exposure).

Mitigating context: the cockpit mission path is currently inert-by-composition (empty patch catalog + `taskWorktreeRoot` mismatch) — every cockpit mission fails closed today; F5.1/F3.1 become live when a real catalog is wired. Positive checks: HTTP boundary, tenant scoping, D1 fail-closed, OmniRoute secret handling, destructive-op guards.

## 7. WIP adjudication (see WIP_ADJUDICATION.md)
All 9 dirty-worktree snapshots examined. **None contains fixes the candidate needs.** Notably, `wip/runtime-safety-dirty` is a *weaker precursor* of the candidate's `33c67d3` hardening (adopting it would remove security validations); both G1-flavored WIPs use abandoned layouts superseded by main's approved `src/server/g1/`. No WIP content was mixed into the candidate.

## 8. RECOMMENDATION (exactly one)

### **B. READY_AFTER_FIXES**

The candidate is a valid single integration base: ancestry is a clean fast-forward (0 behind/49 ahead), the change is near-purely additive (0 deletions, 1 additive migration), all functional gates pass (typecheck, 1656/1656 tests, build, compliance, secret scan), no test weakening, the commit narrative is coherent, and no WIP content is missing from it. It is NOT ready as-is, and splitting would create artificial intermediate states with no independent review value (rejected: A, C, D).

**Required fixes before PR/merge (all mechanical or localized; none architectural):**
1. **Format**: `prettier --write` limited to the 59 candidate-authored files failing `format:check` (do NOT reformat the 84 pre-existing-debt files in the same commit — keep attribution clean; schedule the repo-wide format as separate debt work).
2. **F5.2**: remove or approval-gate the autonomous `git push`/`gh pr create` in `scripts/first-auto-mission.ts`.
3. **F3.1/F3.2**: make `worker-manager.ts` treat `require_approval` as non-executable (throw/park), not fall-through.
4. **F4.1**: remove the repo-root fallback when `worktreePath` is empty; fail closed.
5. **F6.1**: scrub env for GlobalGates `pnpm test/build` subprocesses (mirror the deterministic worker's scrubbed env).
6. **F5.1**: either implement a minimal non-vacuous review gate or explicitly mark the V1 reviewer as a stub AND keep the mission path inert until it is real (document in code + coordination doc).
7. **Governance completeness** (may land with the PR or immediately after): record a DEC/ADR for the supervisor/worker architecture; record an ADR for the `mission_contexts` no-RLS status referencing DEC-0003 (or add the RLS policy).

**Merge mechanics recommendation** (for the future phase, not executed now): merge commit (not fast-forward) to preserve the review record, exactly as the reconciliation plan suggests.

## 9. Evidence trail
- Ancestry: `git merge-base`, `git merge-base --is-ancestor`, `git rev-list --left-right --count` (§1).
- Twins: `git patch-id --stable` per pair (COMMIT_MAP_49.md).
- Diff: `git diff --name-status main..candidate` (159 lines), per-file diffs of all 19 modifications.
- Gates: `/tmp/p1-evidence-gates.log`, `/tmp/p1-tests.log`, `/tmp/p1-compliance.log` (session host); results transcribed in §5.
- Security: independent agent report `CANDIDATE_SECURITY_REVIEW.md` with file:line evidence.
- WIP: corrected pathspec-split diffs per snapshot (WIP_ADJUDICATION.md, incl. method-error disclosure).
