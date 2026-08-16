# PHASE 2B — SECURITY HARDENING REPORT

- **Date**: 2026-08-16
- **Repository**: `icos-cockpit-real` (nested clone, origin github.com/SGNG21/Icos)
- **Branch**: `fix/integration-candidate-hardening` — pushed to origin @ `47a71b6` (preservation authorized)
- **Input**: Phase 2 independent security review `PHASE2_SECURITY_REVIEW.md` → `SECURITY_REJECTED`, findings NF-1..NF-6
- **Candidate branch**: `feat/cockpit-real-wiring-1` @ `ba610ca` — untouched, preserved

## Commits (in order, on top of Phase 2 head `f2f6e53`)

| Commit | Finding | Content |
|---|---|---|
| `a3836e3` | NF-2 (MAJOR) | Empty required-check list can never PASS — INVALID_CONFIGURATION fail-closed |
| `f99329d` | NF-3 (MAJOR) | Race-safe workspace writes (symlink/TOCTOU) |
| `b7a3f5b` | NF-1 (BLOCKER) + NF-4 + NF-6 | Non-forgeable signed approval authority (Ed25519) |
| `47a71b6` | NF-5 (MINOR) | Documented residual — gate toolchain provenance |

Files changed: `scripts/approve-external-effect.ts` (new), `scripts/first-auto-mission.ts`, `src/core/review/contract.ts`, `src/server/integration/global-gates.ts`, `src/server/review/reviewer-worker{,.test}.ts`, `src/server/security/approval-authority{,.test}.ts` (new), `src/server/security/safe-workspace-writer{,.test}.ts` (new), `src/server/security/workspace-boundary.ts`.

---

## NF-1 [BLOCKER] — Non-forgeable approval authority → FIXED (`b7a3f5b`)

**Phase 2 defect**: the external-effect approval was an unsigned JSON artifact in the workspace — any worker/mission subprocess/repository code could write a conforming artifact and self-authorize push/PR.

**Trust boundary (smallest correct)**: an Ed25519 keypair in `~/.icos/approval-authority/` — **outside every workspace/worktree**. The private key is created with `flag: "wx"` (never overwritten), mode `0600`, directory `0700`. Workers and repository subprocesses can read the *public* key only; the approval artifact itself may live in the workspace because its integrity comes from the signature, not its location.

**Mechanism** (`src/server/security/approval-authority.ts`):
- Signature over a **canonical JSON form** (recursively sorted keys, `undefined` filtered) — verification is independent of key order and immune to re-serialization ambiguity.
- Any public key embedded in the artifact is **ignored** — the only trust anchor is `~/.icos/approval-authority/authority-public.pem`.
- **Exact bindings**, all mismatches → DENY: `scope`, `missionId`, optional `taskId`, canonical `repository` path, **exact** `branch` (wildcards rejected at schema level — NF-6).
- **Freshness** (NF-6): `approvedAt` ≤ now + 120 s skew (`future_dated`), `expiresAt` > now (`expired`), `expiresAt` > `approvedAt` (`invalid_window`), window ≤ 24 h (`ttl_exceeded`).
- **Anti-replay**: nonce (hex ≥ 32 chars) consumed atomically via `writeFile(..., {flag:"wx"})` on `consumed-nonces/<sha256(nonce)>.json` — the nonce is hashed before use as a filename because it is untrusted input; `EEXIST` → `replayed_nonce`.
- **Fail-closed everywhere**: missing / unavailable / malformed / missing_authority_key / bad_signature / any mismatch / any freshness failure / replayed_nonce → `granted: false`. There is no partial-grant path.

**Owner side**: `scripts/approve-external-effect.ts` — run BY THE OWNER only; ensures the keypair, signs a payload bound to mission + exact branch + TTL (default 60 min, max 24 h) + single-use nonce.

**Wiring**: `scripts/first-auto-mission.ts` phase 9 now calls `ApprovalAuthority.loadVerifyAndConsume` with the exact expected bindings (`scope: git-push+pr-create`, the live `mission.id`, `realpath(repoRoot)`, `integration/<dagId>`). Any denial prints `PR_CREATION_BLOCKED_BY_MISSING_APPROVAL(<code>)` and stops. The Phase 2 unsigned evaluator (`external-effect-approval.ts`) is no longer on the live granting path.

**Forgery proof (required by the directive)**: `approval-authority.test.ts` includes a **subprocess proof** — a real `node -e` child process, given only what a worker sees (payload JSON + workspace out path), generates its own Ed25519 keypair, replicates the exact canonical stringify, self-signs, and writes the artifact; `loadVerifyAndConsume` denies it with `bad_signature`. Additional forgery tests: attacker-keypair signature, post-signature payload tampering, embedded-public-key smuggling — all denied. 22/22 tests pass.

## NF-2 [MAJOR] — Empty review-check bypass → FIXED (`a3836e3`)

`requiredChecks` schema now `.min(1)`; `conductReview` with an empty effective check list returns `FAILED` / `INVALID_CONFIGURATION` — a review can never PASS vacuously. Stub categories remain fail-closed (unverified → fail). Regression tests added (`reviewer-worker.test.ts`).

## NF-3 [MAJOR] — Workspace symlink/TOCTOU → FIXED (`f99329d`)

**No trusted-host assumption.** `src/server/security/safe-workspace-writer.ts` makes validation and write inseparable by writing **through a verified FileHandle**:

1. Platform without `O_NOFOLLOW` → refuse (`unsupported_platform`).
2. Workspace root must be its own `realpath` (`non_canonical_workspace_root`); target must pass lexical containment.
3. Component-wise `lstat` walk root→parent: any symlink component → refuse; missing dirs created non-recursively and re-verified.
4. `open(target, O_WRONLY|O_CREAT|O_NOFOLLOW)` — **no O_TRUNC**: nothing is destroyed before verification. Symlink at final component → `ELOOP`/`EMLINK` → refuse.
5. Post-open verification on the handle: regular file; `nlink === 0` → `race_detected` (unlinked during the window); `nlink > 1` → hardlink alias refused; `lstat(path)` must match the handle's `dev+ino` (path-identity); parent `realpath` re-canonicalization must still equal the walked parent.
6. Only then: `truncate(0)` + write on the handle.

**Adversarial tests** (15/15): pre-positioned symlinks (final + intermediate), hardlink alias, directory target, and four deterministic TOCTOU courses injected via test-only seams (parent swapped to symlink before open; target replaced after open; decoy renamed over target; parent renamed away). In every course: refusal, victim file intact, and the sentinel secret content never lands outside the workspace.

**Documented limit** (benign): with `O_CREAT`, a raced attack can leave an **empty** file outside the workspace before refusal — zero content bytes are ever written through an unverified handle; deleting the empty file would itself be a race and is not attempted.

## NF-4 [MINOR] — Approval-path env override → FIXED (folded into `b7a3f5b`)

`ICOS_EXTERNAL_EFFECT_APPROVAL_FILE` removed; the artifact path is fixed to `<repo>/.icos/approvals/first-auto-external-effect.signed.json`. Verified by grep: the identifier survives only in an explanatory comment. (Defense-in-depth — even a redirected path could not produce a valid signature under NF-1.)

## NF-5 [MINOR] — Gate toolchain provenance → DOCUMENTED RESIDUAL (`47a71b6`)

- **Residual risk**: `GlobalGates.ENV_ALLOWLIST` still forwards `PATH`, `PNPM_HOME`, `COREPACK_HOME`, `XDG_*` — a compromised **operator** environment could point gates at poisoned tooling/caches (tool provenance unverified).
- **Compensating control**: exploiting it requires prior compromise of the operator's own environment — workers cannot set the gates' parent env; all secrets/API keys remain excluded by the allowlist.
- **Why no minimal fix**: pinning `PATH` is host-specific and breaks the gates; verifying tool provenance (hermetic toolchain) is an architecture expansion, explicitly out of Phase 2B scope.
- **Owner**: operator environment hygiene (human owner).
- **Follow-up milestone**: hermetic/pinned toolchain for gate subprocesses — to be scheduled before any production deployment.
- **Why it does not block integration**: attack precondition (operator env compromise) is outside the candidate's threat model (worker/mission-subprocess forgery), and no secret exposure is involved.

## NF-6 [MINOR] — Approval expiry/nonce/wildcards → FIXED (folded into `b7a3f5b`)

Expiry + max TTL 24 h + clock-skew bound + `invalid_window` + single-use nonce all enforced (see NF-1); branch wildcards impossible: the payload schema refuses `*` in `branch`, so a wildcard approval cannot even be signed — and a hand-built artifact bypassing the signer is `malformed`/`bad_signature`.

---

## Evidence gates (all under `env -u NODE_ENV -u PERSISTENCE`, 2026-08-16)

| Gate | Result |
|---|---|
| `pnpm lint` | PASS — 0 errors (142 pre-existing warnings, untouched: no unrelated refactoring) |
| `pnpm typecheck` | PASS — clean |
| `pnpm test` | PASS — **110 files, 1747/1747 tests** |
| `pnpm build` | PASS — production build completes |
| `prettier --check` (11 changed files) | PASS |
| Secret scan on `f2f6e53..HEAD` diff | CLEAN — 4 pattern hits are `task-001` fixtures matching `sk-`, no secrets |
| Compliance scan | CLEAN — no `process.env` secret access in changed files; NF-4 override absent from code |

Security-focused suites: `approval-authority.test.ts` 22/22, `safe-workspace-writer.test.ts` 15/15, workspace-boundary + external-effect suites green, `global-gates.test.ts` 20/20, `reviewer-worker.test.ts` green (all included in the 1747).

## Governance

- `DECISION_REVIEW_0011_0012.md` produced — complete record contents + owner-oriented summaries for DEC-0011/DEC-0012. Both remain `PROPOSED`; **the agent has not accepted either** (and cannot).
- Independent Phase 2B security review: see `PHASE2B_SECURITY_REVIEW.md`.

## Outstanding owner actions

1. Accept/reject **DEC-0011** and **DEC-0012** (`docs/icos/audit/DECISION_REVIEW_0011_0012.md`).
2. **OmniRoute API key rotation** + attestation (carried from RECONNAISSANCE-001 — still open).
3. NF-5 follow-up milestone (hermetic gate toolchain) before any production use.
