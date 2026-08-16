# RECONCILIATION PHASE 2 — FIX REPORT

- **Date**: 2026-08-15/16
- **Branch**: `fix/integration-candidate-hardening` (base: `feat/cockpit-real-wiring-1` @ ba610ca — preserved, untouched)
- **Repo**: `icos-cockpit-real` (nested repo)
- **Scope**: STRICTLY the 7 required fixes from Phase 1 (`INTEGRATION_CANDIDATE_REVIEW.md`, recommendation B. READY_AFTER_FIXES). No merge, no rebase, no squash, no force push, no unrelated refactoring, no feature expansion, no WIP adoption, no production changes.

## Commits (6, on top of the candidate)

| Commit | Fix | Content |
|---|---|---|
| e1775e9 | F3 | `require_approval` blocking in WorkerManager — fail-closed on any non-allow outcome |
| 172fa5f | F5 | GlobalGates subprocess env allowlist — no parent secret propagation |
| 983bc68 | F2, F4 | `src/server/security/` modules: external-effect approval artifact + workspace boundary |
| 43aee96 | F6 | ReviewerWorker/CorrectionWorker explicit fail-closed V1 stubs — no rubber stamp |
| 2adaad9 | F2/F3/F4/F6 | Fail-closed gate wiring in `scripts/first-auto-mission.ts` |
| f2f6e53 | F1 | Prettier on candidate-authored files only (55 formatting-only files) |

## Fix-by-fix

### F1 — Formatting (candidate-authored files only) ✅
- Target set = intersection of the Phase 1 prettier-dirty list and the merge-base diff list (**59 files**) + files touched by Phase 2 fixes (66 total).
- `prettier --write` applied to exactly those files; scoped `prettier --check` passes.
- The **84 pre-existing merge-base debt files are deliberately NOT reformatted** (out of scope per directive). Repo-wide `format:check` therefore still fails on those 84 files only — verified **zero overlap** with the target set.

### F2 — Autonomous git push / PR creation gated by human approval ✅
- New module `src/server/security/external-effect-approval.ts`:
  - zod-validated artifact `{approved, scope, branch, approvedBy, approvedAt, expiresAt}`.
  - Pure evaluation `evaluateExternalEffectApproval`: **missing / malformed / denied (approved !== true) / scope_mismatch / branch_mismatch / stale (expired or invalid expiry) → blocked**; only a fully valid artifact grants.
  - Loader `loadExternalEffectApproval`: ENOENT → missing, read error → **unavailable (blocked)**, bad JSON → malformed.
  - Branch matching: exact, or explicit `prefix/*` (non-empty namespace and segment; bare `*` rejected).
- `scripts/first-auto-mission.ts` Phase 9: `git push` / `gh pr create` execute **only** if the artifact grants scope `git-push+pr-create` for `integration/<dag-id>`; otherwise logs `PR_CREATION_BLOCKED_BY_MISSING_APPROVAL (<code>)` and the governance summary records `External effect human-approved: NO — external effects blocked fail-closed`.
- Negative tests: full matrix in `src/server/security/external-effect-approval.test.ts` (placed under `src/` so the vitest gate actually runs them — `scripts/` is excluded from the test glob).

### F3 — `require_approval` is a blocking state ✅
- `src/server/worker/worker-manager.ts` (and `FirstAutoWorker` in the script): only an explicit `allow` proceeds. `require_approval` throws (human approval not obtained), `deny` throws, **unknown outcome throws (fail-closed)**, policy engine failure rejects the spawn.
- Regression tests: ALLOW executes / REQUIRE_APPROVAL, DENY, unknown outcome block with `runtime.execute` never called / UNAVAILABLE (throwing policy port) rejects. 22/22 pass.

### F4 — Worktree isolation, repo-root fallback removed ✅
- New module `src/server/security/workspace-boundary.ts`:
  - `resolveAuthorizedWorkspace(worktreePath, forbiddenRoots)`: empty/whitespace, relative, unresolvable (realpath), non-directory, or canonical-equals-forbidden-root → `WorkspaceBoundaryError` (typed codes). Returns the canonical path.
  - `resolveInsideWorkspace(root, rel)`: rejects `""`, absolute paths, and any traversal escaping the root.
- `scripts/first-auto-mission.ts`: the repo-root fallback is **removed**; the worker resolves its workspace with the repo root as a forbidden root, and all file writes go through `resolveInsideWorkspace`.
- Path-boundary tests: 38/38 in `src/server/security/` (traversal, absolute, symlink indirection, forbidden root, nonexistent, file-not-dir…).

### F5 — GlobalGates subprocess env allowlist ✅
- `src/server/integration/global-gates.ts`: explicit `ENV_ALLOWLIST` (PATH, HOME, USER, SHELL, TMPDIR/TEMP/TMP, LANG/LC_*, PNPM_HOME, COREPACK_HOME, XDG_*). Secrets absent **by construction**; `NODE_ENV`/`PERSISTENCE` deliberately excluded (demonstrated gate env poisoning).
- Tests include a **real subprocess proof**: a stubbed sensitive variable in the parent never appears in the child's `process.env` keys. 27/27 pass.

### F6 — Review gate V1: explicit fail-closed stub (Option B) ✅
- Decision: ReviewSpec carries no evidence inputs, so a minimal "real" gate would require contract changes (= forbidden feature expansion). Option B chosen: **explicit stub, autonomous paths inert/fail-closed**.
- `ReviewerWorker`: categories without real verification (`tests`, `scope`, `security_boundaries`, `architecture_boundaries`, `regressions`, `code_quality`) **fail explicitly as STUB**; unknown categories fail closed; only `acceptance_criteria`/`documentation` (AC-presence) can pass. A review requiring stubbed categories can never return PASS.
- `CorrectionWorker`: returns **ESCALATED**, never a false CORRECTED → correction loop routes to human escalation (`correction-loop.ts` treats non-CORRECTED as the escalation path).
- `ensureIndependentReview`: non-empty, distinct implementer/reviewer identities required.
- Script fakes (`FakeReviewer`/`FakeCorrector`) marked as explicit stubs; `FakeCorrector` escalates; PASS is documented as not-evidence; external effects remain gated by F2 regardless of review verdict.
- Tests adapted: no rubber-stamp PASS; every stubbed category fails individually; correction escalates. 14/14 pass.

### F7 — Governance records ✅ (PROPOSED — owner acceptance required)
Written to the main repo `.icos/decisions/` (uncommitted working-tree files for owner review; schema-valid):
- **DEC-0011 (PROPOSED)** — supervisor/worker autonomous mission architecture: retroactive regularization of the missing ADR; describes the architecture and its fail-closed constraints; explicitly does **not** approve autonomous external effects or production deployment. The proposing agent cannot self-accept.
- **DEC-0012 (PROPOSED)** — `mission_contexts` no-RLS vs DEC-0003: the contradiction is **recorded, not silently resolved** — observed state (`drizzle/0009_mission_context.sql`, no `ENABLE ROW LEVEL SECURITY` anywhere in migrations), current risk (single defense layer; app-layer bug would expose cross-tenant payloads), compensating controls (tenant-keyed repository access, DEC-0004 no direct agent DB access, local/dev-only, append-only), and a **binding follow-up**: RLS migration with rollback/data-safety analysis before any production use. DEC-0003 unchanged.

## Evidence gates (all `env -u NODE_ENV -u PERSISTENCE`)

| Gate | Result | Log |
|---|---|---|
| `pnpm lint` | exit 0 (0 errors, 143 pre-existing warnings) | /tmp/p2-lint.log |
| `pnpm typecheck` | exit 0 | /tmp/p2-typecheck.log |
| `pnpm test` | **1706/1706 pass** (108 files) | /tmp/p2-test.log |
| `pnpm build` | exit 0 | /tmp/p2-build.log |
| `prettier --check` (F1 scope, 66 files) | pass | /tmp/p2-format-scoped.log |
| `pnpm format:check` (repo-wide) | fails on exactly the 84 pre-existing debt files, 0 in scope | /tmp/p2-format.log |
| `pnpm compliance:scan-secrets` | clean | /tmp/p2-secrets.log |
| `pnpm compliance:check` | clean | /tmp/p2-compliance.log |

## Independent security review
See `docs/icos/audit/PHASE2_SECURITY_REVIEW.md` (security-reviewer agent, final diff `feat/cockpit-real-wiring-1..fix/integration-candidate-hardening`).

**Verdict: SECURITY_REJECTED.** The reviewer confirms F1 mechanically (prettier-only, byte-verified), and F3/F4/F5/F7 as ADEQUATE with documented residuals, but rejects the branch on new findings discovered by adversarial review:

- **NF-1 (BLOCKER)** — the F2 approval artifact is an unsigned JSON at an attacker-writable path; a forged file grants push/PR. Fail-closed against *absence*, not against *forgery*. Requires signature/owner-only channel + tight TTL + effect/commit binding.
- **NF-2 (MAJOR)** — `requiredChecks: []` yields a vacuous review PASS (reproduced: `PASS checks: 0`); `ReviewSpec.requiredChecks` lacks `.min(1)` and `conductReview` has no empty-list guard. Violates the F6 "no fake-success gate" invariant at the contract boundary.
- **NF-3 (MAJOR)** — workspace validation has a local symlink/TOCTOU race between `realpath` validation and the later write; requires a race-safe write or an explicit, recorded trusted-host assumption.
- NF-4/NF-5/NF-6 (MINOR) — approval-file env override unconstrained; GlobalGates PATH/cache poisoning residual; approval freshness/TTL/wildcard under-constrained.

These are NEW findings beyond the Phase 1 scope this phase was limited to; per directive they are not silently patched in this round — they require an authorized follow-up round and a re-review.

## Recommendation

**B. MORE_FIXES_REQUIRED**

The seven Phase 1 required fixes are implemented with green evidence gates, but the independent security review's verdict is SECURITY_REJECTED: the "human approval artifact" (F2) and "no autonomous reviewed/corrected success" (F6) invariants are not fully achieved (NF-1, NF-2), and NF-3 needs either remediation or an explicit owner-accepted trusted-host decision. The branch must NOT proceed to PR until a follow-up fix round addresses NF-1 and NF-2 (and disposes of NF-3), followed by re-review.

## Outstanding items (owner)
- Accept/reject DEC-0011 and DEC-0012 (PROPOSED; agent cannot self-accept).
- OmniRoute API key rotation + attestation (Phase 1 finding — unchanged, still owner-side).
- Review the uncommitted Phase 1 & 2 audit documents in the main repo working tree.
- Any push / PR creation of `fix/integration-candidate-hardening` requires explicit owner authorization (standing constraint).

## Recommendation
See end of `PHASE2_SECURITY_REVIEW.md` reconciliation — final single recommendation issued in the session summary after the independent security verdict.
