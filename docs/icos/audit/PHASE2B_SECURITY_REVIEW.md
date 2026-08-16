# PHASE 2B — INDEPENDENT SECURITY REVIEW

- **Date**: 2026-08-16
- **Reviewer**: fresh independent security-reviewer agent (no shared state with the implementing session; verdict formed from code, tests re-run independently)
- **Scope**: `icos-cockpit-real` branch `fix/integration-candidate-hardening`, range `f2f6e53..47a71b6` (commits `a3836e3` NF-2, `f99329d` NF-3, `b7a3f5b` NF-1/NF-4/NF-6, `47a71b6` NF-5 doc)
- **Input findings under review**: NF-1..NF-6 from `PHASE2_SECURITY_REVIEW.md` (Phase 2 verdict: SECURITY_REJECTED)

## VERDICT: **SECURITY_APPROVED**

## Per-finding assessment

### NF-1 [BLOCKER] — RESOLVED
Ed25519 signature over canonical JSON with the trust anchor outside the workspace, verified from code. `approval-authority.ts` reads only the authority public key from `~/.icos/approval-authority/`; keys embedded in the artifact are stripped by the zod schema (unknown fields dropped) and never trusted — confirmed by the smuggling test. Canonicalization sorts keys recursively and operates on the parsed payload, collapsing duplicate-key/ordering/extra-field ambiguities before verification. Nonce consumption is atomic (`writeFile` `wx` on a sha256-digest filename — the raw nonce is never a path component); two concurrent `verifyAndConsume` calls cannot both succeed; the nonce registry lives under the authority dir, unreachable for deletion by workspace-only processes. Verification order signature → exact bindings → freshness, all fail-closed, no default-allow path. `first-auto-mission.ts` phase 9 genuinely uses `loadVerifyAndConsume` with exact bindings (`realpath(repoRoot)`, exact `integration/<dagId>` branch); push/PR is inside the `granted` branch only. The legacy unsigned module has no production caller (only the scope constant is imported). The **subprocess forge-proof** test exists and passes: a real `node -e` child with only workspace-visible material self-signs a perfectly conformant payload → `bad_signature`.

*Reviewer-documented boundary*: the scheme's strength equals the sandbox keeping workers out of `~/.icos` — a same-OS-user process not confined to workspace paths could read the 0600 private key. Inherent to any local-key design; matches the stated trust boundary.

### NF-2 [MAJOR] — RESOLVED
Three layers: schema `.min(1)` (empty → reject; omitted → non-empty default); runtime guard returns `FAILED`/`INVALID_CONFIGURATION` at length 0 even if the schema is bypassed; missing-result detection fails the review when produced checks ≠ required checks. Same guard replicated in the mission script's FakeReviewer. Unknown categories rejected by enum; duplicates each produce a real check. No vacuous-truth path remains. Regression tests cover all cases.

### NF-3 [MAJOR] — RESOLVED
Canonical-root requirement, lexical containment, per-component lstat non-symlink walk (non-recursive mkdir re-verified), final `open` with `O_NOFOLLOW` and **no** `O_TRUNC`, post-open fd-identity checks (regular file; `nlink===0` unlink race; `nlink!==1` hardlink alias; `lstat` dev+ino must match the handle — defeats swap-then-swap-back; parent must re-canonicalize to itself — defeats intermediate symlink swap). Truncate+write happen only through the verified descriptor, so post-check renames cannot redirect the destination. No-`O_NOFOLLOW` platforms → hard refusal. The documented limitation (possible **empty** file outside workspace on pre-open parent swap) is truly content-free — asserted by test. Race seams inject at the two real TOCTOU windows; production callers pass no seams. 15 adversarial tests pass.

### NF-4 [MINOR] — RESOLVED
`ICOS_EXTERNAL_EFFECT_APPROVAL_FILE` fully removed (grep: survives only in an explanatory comment); artifact path fixed. No other `process.env` read selects an approval path. See new finding N-1 for a residual of the same class via `HOME`.

### NF-5 [MINOR] — RESIDUAL_DOCUMENTED
The in-code residual documentation is honest: PATH/PNPM_HOME/COREPACK_HOME/XDG_* still forwarded; exploitation requires a compromised **operator** parent environment (workers do not set the gates' parent env); real fix (hermetic toolchain) correctly named as an architecture evolution with follow-up. Allowlist otherwise strips credentials and NODE_ENV. Acceptable as documented residual.

### NF-6 [MINOR] — RESOLVED (folded into NF-1)
Datetime schema + ≥16-byte lowercase-hex nonce (lowercase-only regex prevents case-aliasing; registry keys on the exact string). Wildcards rejected at schema (any `*`), matching is strict equality, the owner CLI cannot even sign a wildcard. Freshness: 120 s skew bound, `invalid_window`, 24 h TTL cap, strict expiry (artifact expiring exactly now is denied — no off-by-one). Skew abuse bounded: max usable life is 24 h regardless of claimed timestamps.

## New findings (none blocking)

| # | Severity | Finding | Disposition |
|---|---|---|---|
| N-1 | MINOR | Trust-anchor location derives from `os.homedir()` → honors `$HOME`. A process able to set the **top-level mission runner's** environment (`HOME=/attacker pnpm tsx scripts/first-auto-mission.ts`) redirects verification to an attacker keypair, restoring forgeability. Not reachable by workspace subprocesses of a running mission (same actor class as NF-4, but replaces the anchor rather than the artifact). | **Follow-up required** before autonomous production use: resolve the authority dir from `os.userInfo().homedir` (passwd database) or a fixed absolute path, or pin the authority public-key fingerprint in repo governance. Owner: next hardening iteration. |
| N-2 | MINOR | `safe-workspace-writer` `open()` on a pre-positioned FIFO at the target path blocks until a reader appears (the `isFile()` refusal runs only after `open` returns). Workspace-local DoS/hang only; no boundary escape. | Follow-up: add `O_NONBLOCK` to the open flags or a pre-open `lstat` FIFO refusal. Non-blocking for integration (availability, not integrity/confidentiality). |
| N-3 | note | `ensureAuthorityKeypair` does not tighten perms of a pre-existing authority dir and writes the public key without `wx`. Owner-CLI context only; never on the verification path; private key protected by `wx`+0600. | Hardening note only. |
| N-4 | note | Pre-existing (not introduced in this range): phase 9 push/PR is conditioned on the signed human approval but not on `workflowPassed`/`allGatesPassed`. | Noted for completeness; behavior unchanged by 2B. Recommend the owner require green gates before ever signing an approval. |

`scripts/approve-external-effect.ts` introduces no vulnerability (TTL validated against the max, repository canonicalized, no secret material in the artifact, arg parsing is owner-CLI-only surface).

## Independent test run

`env -u NODE_ENV -u PERSISTENCE pnpm exec vitest run src/server/security/ src/server/review/` → **6 files, 93/93 passed** (approval-authority 22, external-effect-approval 23, safe-workspace-writer 15, workspace-boundary 15, reviewer-worker 14, correction-loop 4). Reviewer modified nothing, committed nothing, pushed nothing.

Full-suite evidence (implementing session, same day): 110 files, 1747/1747 tests; lint 0 errors; typecheck clean; build passes — see `PHASE2B_HARDENING_REPORT.md`.
