# PHASE 2 SECURITY REVIEW — Independent (Shield)

- Reviewer: independent security reviewer (Shield), adversarial mandate
- Date: 2026-08-16
- Repo: `/Users/coco/icos/icos-cockpit-real`
- Range reviewed: `feat/cockpit-real-wiring-1..fix/integration-candidate-hardening` (6 commits, 66 files, +2120/−1105)
- Governance records reviewed (main repo, uncommitted, PROPOSED): `/Users/coco/icos/.icos/decisions/DEC-0011.yaml`, `/Users/coco/icos/.icos/decisions/DEC-0012.yaml`

## 1. Scope and methodology

- Full diff read for all functional changes; every new security module read line-by-line
  (`external-effect-approval.ts`, `workspace-boundary.ts`, `global-gates.ts`,
  `reviewer-worker.ts`, `worker-manager.ts`, `scripts/first-auto-mission.ts`).
- Style commit `f2f6e53` verified **mechanically**: for each of the 55 changed files, the
  post-commit content was compared byte-for-byte against `prettier(pre-commit content)`
  (`npx prettier --stdin-filepath`). All 55 files (code and markdown) are pure prettier
  output. No semantic change hides in the style commit.
- Functional scope verified: `git diff feat/cockpit-real-wiring-1..f2f6e53~1 --stat` shows
  the 5 functional commits touch **exactly 11 files** (6 source + 5 test), all mapped to
  F2–F6. No scope creep. All other file changes come exclusively from the verified prettier
  commit — in particular `policy.test.ts` and `security-gates.test.ts` were NOT functionally
  altered (no test weakening outside the reviewed files).
- Active bypass hunting: forged/relocated approval artifacts, env-var overrides, dotenv
  loading, branch-pattern abuse, clock trust, policy-outcome fallthrough, path
  traversal/symlink/TOCTOU, subprocess env and filesystem reach, rubber-stamp review paths,
  alternative push/PR call sites, empty review specs (empirically demonstrated), secret scan
  of the whole diff.
- Evidence re-run: `pnpm vitest run` on the 6 security-relevant suites → **94/94 pass**
  (external-effect-approval, workspace-boundary, global-gates, worker-manager,
  reviewer-worker, correction-loop). Parent-collected evidence (lint 0 / typecheck 0 /
  1706/1706 tests / build 0 / secret scan clean) accepted and spot-consistent.

## 2. Per-fix verdicts

### F1 — prettier-only commit: ADEQUATE (mechanically proven)

All 55 files in `f2f6e53` are byte-identical to prettier's output on their pre-commit
content. Nothing further.

### F2 — external-effect approval gate: WEAK
(fail-closed logic is correct; the artifact itself is forgeable within the branch's own stated threat model — see NF-1)

Correct:

- `src/server/security/external-effect-approval.ts:89-137` — pure evaluation is genuinely
  fail-closed: null/undefined → `missing`; strict zod parse → `malformed` (incl.
  `approved: "true"` string); `approved !== true` → `denied`; scope inequality →
  `scope_mismatch`; branch mismatch → `branch_mismatch`; exclusive expiry boundary
  (`expiresAtMs <= now.getTime()`, `:128-134`) → `stale`. No default-grant path.
- `loadExternalEffectApproval` (`:144-171`): ENOENT → `missing`, other read errors →
  `unavailable`, invalid JSON → `malformed`. Fail-closed on I/O.
- `branchMatches` (`:74-83`): exact match or explicit `prefix/*` only; bare `*`, `/*`,
  empty-segment (`integration/`) and prefix-collision (`integration-evil/x`) all rejected —
  each covered by a test (`external-effect-approval.test.ts:149-173`).
- Single call site: the ONLY push/PR code in the repo is `scripts/first-auto-mission.ts`
  Phase 9 (`:1027-1109`); `git push` and `gh pr create` execute only inside
  `approvalDecision.granted && hasGhAuth`. The gated branch string
  (`integration/${dag.id}`, `:1032`) is the identical string pushed (`:1052`) and passed as
  `--head` (`:1066`) — no check/use divergence.
- Env-var question (directed): `ICOS_EXTERNAL_EFFECT_APPROVAL_FILE`
  (`scripts/first-auto-mission.ts:1028`) is read from the real process environment only.
  **No dotenv/loadEnvConfig exists anywhere in `src/` or `scripts/`** (verified by grep), so
  neither repo files nor gate subprocesses can inject it into the running script. Only the
  launching operator controls it — and that party already holds the gh credentials. Not a
  practical bypass today, but unnecessary attack surface (NF-4).
- Branch pattern permissiveness: `prefix/*` matches arbitrarily deep suffixes
  (`integration/a/b`), and an `integration/*` approval is a standing grant for ANY
  integration branch until expiry. Combined with the absence of a maximum validity window
  (NF-6) this allows overly broad standing approvals. The current script requests an exact
  branch, so this is a policy-hygiene concern, not a live bypass.
- Expiry clock: local `new Date()` — no attacker-controllable input; acceptable for a
  human-launched script (residual: host clock trust; `approvedAt` is never validated, a
  future-dated `approvedAt` or a 100-year `expiresAt` is accepted).

Why WEAK overall: the artifact is an unauthenticated, unsigned JSON file at
`repoRoot/.icos/approvals/first-auto-external-effect.json`, i.e. inside a directory
writable by every subprocess the pipeline itself spawns. See NF-1 for the concrete forgery
chain. Fail-closed against absence — not against forgery.

### F3 — non-allow policy outcomes block: ADEQUATE

- `src/server/worker/worker-manager.ts:134-147` and the script's `FirstAutoWorker`
  (`scripts/first-auto-mission.ts:135-145`): `if (policyDecision.outcome !== "allow")`
  throws for `require_approval`, `deny`, and any unknown outcome. Positive-allow gating —
  no fallthrough branch exists in either copy.
- Engine unavailability: a throwing policy port propagates out of `spawn` (no catch), and
  `D1PolicyEngine.decide` itself converts internal errors to DENY
  (`src/core/policy/engine.ts:75-82`).
- Tests genuinely cover the negatives with runtime-execution spies asserting the worker
  never runs: allow / require_approval / deny / policy-port-throw / unknown-outcome
  (`src/server/worker/worker-manager.test.ts:147-252`, "REGRESSION F3" block,
  `expect(executed).not.toHaveBeenCalled()` on every blocking case).
- Pre-existing observation (NOT introduced by Phase 2, unchanged by it):
  `WorkerManager.mapStatus` maps runtime outcome `NEEDS_REVIEW` → `SUCCEEDED`
  (`worker-manager.ts:371-386`). Out of Phase 2 scope but should be revisited: a
  needs-review execution outcome becomes a SUCCEEDED worker status.

### F4 — repo-root fallback removed / workspace boundary: ADEQUATE (with explicit residuals)

- The repo-root fallback is genuinely gone: `FirstAutoWorker.executeTask` resolves
  `worker.worktreePath` through `resolveAuthorizedWorkspace(worker.worktreePath,
  [await this.getRepoRoot()])` (`scripts/first-auto-mission.ts:197-199`); empty, relative,
  nonexistent, non-directory and forbidden-root paths all throw
  (`src/server/security/workspace-boundary.ts:41-95`). The file write goes through
  `resolveInsideWorkspace` (`scripts/first-auto-mission.ts:239`), which rejects `..`
  traversal, absolute paths and the workspace root itself (lexically sound:
  `path.resolve` + `path.relative` check, `workspace-boundary.ts:102-114`), including the
  sibling-prefix trick (`/tmp/icos-ws` vs `/tmp/icos-ws-evil`, covered at
  `workspace-boundary.test.ts:130-134`).
- Residual 1 (accepted, by design): the forbidden-root check is EQUALITY-only
  (`workspace-boundary.ts:86`). A path that is a strict subdirectory of the repo root
  (e.g. `repoRoot/src`) passes. This cannot be an ancestry check because legitimate
  worktrees live at `repoRoot/.claude/worktrees/<task>`
  (`src/server/worktree/worktree-manager.ts:29,62,74`). Safety therefore depends on the
  supervisor assigning genuine worktree paths; the module does not verify the path is a
  registered `git worktree`.
- Residual 2: an unresolvable forbidden root is skipped (`workspace-boundary.ts:81-84`) —
  fail-open for that single entry; tests (`workspace-boundary.test.ts:93-103`) assert that
  this does not weaken a separately resolvable forbidden root. A caller supplying only a
  missing forbidden-root list can therefore authorize the main repo path; the current
  caller supplies the real repo root, so this is a caller-contract residual.
- Symlink/TOCTOU: `realpath` canonicalizes the workspace and `resolveInsideWorkspace`
  rejects lexical escapes, but the validation and later file write are separate operations
  (`workspace-boundary.ts:61-94`, then `first-auto-mission.ts:239-241`). A concurrent actor
  able to rename a validated directory or replace a path component with a symlink can race
  the write. This is a local filesystem threat not tested here and is not solved by the
  current path-only API (NF-3).

### F5 — GlobalGates subprocess environment allowlist: ADEQUATE (for inherited secrets)

- `src/server/integration/global-gates.ts:45-61` uses a positive allowlist; `run` passes
  `env: this.buildGateEnv()` (`:140-154`) rather than inheriting `process.env`.
  Sensitive variables (`OMNIROUTE_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `DATABASE_URL`, AWS,
  GitHub and npm tokens), `NODE_ENV`, and `PERSISTENCE` are excluded by construction.
- The allowlist contains ordinary process/runtime values only: PATH, home/user/shell,
  temp, locale and XDG/PNPM/Corepack cache/config/data locations. No credential-bearing
  variable is present. It does include attacker-influenced path/config/cache locations
  (`PATH`, `PNPM_HOME`, `COREPACK_HOME`, `XDG_*`), but these are needed to locate pnpm and
  are not secrets; they are a supply-chain/trust residual. A hostile PATH or package/cache
  location could run a trojan executable or influence tooling (NF-5). This is not a secret
  propagation bypass.
- Tests include direct allowlist assertions and a real child-process test
  (`global-gates.test.ts:263-361`); all pass. Note test setup cannot enumerate every
  possible future secret name, but positive allowlisting protects by construction.

### F6 — reviewer/correction fail-closed stubs: WEAK (one generic contract bypass)

Correct:

- `ReviewerWorker.evaluateCategory` (`src/server/review/reviewer-worker.ts:92-137`)
  fails all unimplemented categories, unknown categories and only passes
  `acceptance_criteria` when at least one AC exists. `CorrectionWorker.executeCorrection`
  (`:151-168`) always returns `ESCALATED`; it never returns `CORRECTED`.
- `FakeCorrector` in `scripts/first-auto-mission.ts:665-683` also always escalates.
- The Supervisor constructs the required review set with `tests`, `scope`,
  `security_boundaries` and `architecture_boundaries` (`src/server/supervisor/supervisor-service.ts:379-387`),
  so the production mission path cannot pass the `ReviewerWorker` stub. The script's
  `FakeReviewer` is clearly labelled stub at `:618-663`; this label is not a security
  control, but the script's required checks still cause its AC-only fake to return
  `PASS` if it is used. External effects have an independent F2 gate.

Weakness: `ReviewSpec.requiredChecks` is `.default([...])` but not `.min(1)`
(`src/core/review/contract.ts:59-68`). A caller can supply `requiredChecks: []`; the
reviewer loops zero times, sets `allPassed = true`, and returns PASS. I reproduced this
against the reviewed branch:

```text
EMPTY requiredChecks verdict: PASS checks: 0 confidence: 4
```

The same empty-list bypass exists for `FakeReviewer` (`first-auto-mission.ts:632-643`):
`[].every(...)` is true. A malicious or buggy caller that can construct a ReviewSpec (or
an integration path that drops required checks) can obtain a false reviewed-success state.
This is a real correctness/security boundary because `CorrectionLoop.execute` accepts
initial PASS as final PASS (`src/server/review/correction-loop.ts:77-89`). See NF-2.

### F7 — governance and contradiction handling: ADEQUATE (records remain PROPOSED)

- `/Users/coco/icos/.icos/decisions/DEC-0011.yaml` accurately records the architecture,
  explicitly says it does not approve external effects or production deployment, and
  accurately describes F3/F4/F5/F6. It is `status: PROPOSED`, requires owner acceptance,
  and does not self-accept.
- `/Users/coco/icos/.icos/decisions/DEC-0012.yaml` accurately identifies the absent RLS in
  `drizzle/0009_mission_context.sql` (and no `ROW LEVEL` match in migrations), names the
  cross-tenant risk and compensating controls, and requires an additive RLS migration with
  rollback/data-safety analysis. It explicitly states that it does **not** supersede or
  weaken accepted `DEC-0003`. This is the required non-silent treatment of the
  contradiction. Both are uncommitted in the main repo, as required by their PROPOSED
  status.
- Important residual governance blocker: because DEC-0012 is only PROPOSED and DEC-0003
  remains ACCEPTED, the RLS contradiction remains unresolved. The record does not make
  production use permissible; its text correctly says follow-up is required before
  production use.

## 3. New findings

### NF-1 — BLOCKER: unsigned, attacker-writable approval artifact allows forged push/PR authorization

**Evidence:**

- `scripts/first-auto-mission.ts:1027-1033` accepts an arbitrary path from
  `ICOS_EXTERNAL_EFFECT_APPROVAL_FILE`, otherwise reads a predictable JSON file under
  `repoRoot/.icos/approvals/`.
- `src/server/security/external-effect-approval.ts:144-170` authenticates neither the
  artifact's author nor its integrity; it only parses fields and checks expiry/scope/branch.
- The approval file is created/read as ordinary filesystem content; no owner/mode check,
  signature, immutable storage or human-attestation binding exists.

**Concrete reproduction:**

1. Obtain write access to the checkout (or any process that can write the approval path);
   write the following before Phase 9:

```json
{"approved":true,"scope":"git-push+pr-create","branch":"integration/*","approvedBy":"attacker","approvedAt":"2026-08-15T10:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z"}
```

2. Ensure the script's `gh auth status` sees the operator's existing authentication.
3. The decision is granted at `external-effect-approval.ts:108-136`; the script executes
   `git push` and `gh pr create` at `first-auto-mission.ts:1051-1095`.

This defeats the stated invariant “artefact créé par un humain” because the verifier has no
way to distinguish a human artifact from a forged file. An approval artifact must be
cryptographically authenticated, or be generated through a protected owner-only channel,
and should be bound to a short validity window and exact effect/commit identity.

### NF-2 — MAJOR: empty required-check list is a vacuous PASS

**Evidence and reproduction:** `ReviewSpec.requiredChecks` has a default but no minimum
(`src/core/review/contract.ts:59-68`); `ReviewerWorker.conductReview` initializes
`allPassed = true`, loops zero times and returns PASS (`reviewer-worker.ts:52-82`).
The direct reproduction above produced `PASS checks: 0 confidence: 4`. `FakeReviewer` has the
same `every([])` behavior (`first-auto-mission.ts:632-643`), and `CorrectionLoop` treats PASS
as terminal (`correction-loop.ts:77-89`).

**Required fix:** enforce `requiredChecks.length >= 1` (and preferably require a canonical,
non-empty minimum set for autonomous integration) at the schema and/or review boundary;
add regression tests for empty and omitted/invalid categories. Do not rely on comments or
call-site conventions.

### NF-3 — MAJOR: workspace validation is vulnerable to local filesystem TOCTOU/symlink races

**Evidence:** `resolveAuthorizedWorkspace` calls `realpath`/`stat` and returns a string
(`workspace-boundary.ts:59-94`); later `writeFile` follows the path independently
(`first-auto-mission.ts:237-241`). There is no open-directory-handle or no-follow write,
no revalidation immediately before the write, and no verification that the directory is a
registered worktree.

**Concrete reproduction (threat model):** a local process with write permission to the
parent of the assigned worktree waits until `realpath` succeeds, renames the directory and
replaces the validated path with a symlink to another directory; the subsequent
`writeFile(testFilePath, ...)` follows the replacement. The worker writes outside its
validated canonical workspace. This requires same-host filesystem write capability and is
not demonstrated by the current tests; severity is MAJOR for a hostile co-tenant/local
process, lower if the runtime host is single-operator trusted.

**Required fix:** keep/use an open directory descriptor with no-follow semantics for writes,
or revalidate canonical parent components immediately before each effect and verify the
assigned path against `git worktree list`; document the trusted-host assumption if this
threat is explicitly out of scope.

### NF-4 — MINOR: arbitrary approval-file env override is not constrained

**Evidence:** `first-auto-mission.ts:1027-1029` accepts any absolute/relative path without
workspace-boundary, owner, mode or symlink checks. The current script does not load dotenv,
so this is operator-controlled rather than repository-controlled, but a wrapper, CI config,
parent process or future dotenv addition can redirect the approval lookup to an attacker-
controlled file. The variable also permits a stale approval outside the repository with no
provenance.

**Required fix:** remove the override for the autonomous path or constrain it to an
owner-controlled, canonical approvals directory and enforce file ownership/mode plus a
cryptographic signature/commit binding.

### NF-5 — MINOR: GlobalGates allowlist permits executable/configuration poisoning

**Evidence:** `global-gates.ts:45-61` forwards `PATH`, `PNPM_HOME`, `COREPACK_HOME`, and
`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME`. Gates invoke `pnpm` (`:83`) and git.
A hostile inherited PATH or package-manager/config/cache directory can alter which tool or
package metadata is executed. Positive allowlisting prevents secret propagation but does
not establish trusted tool provenance.

**Required fix:** resolve tools from trusted absolute paths or sanitize PATH to a fixed
system path; use isolated, trusted package-manager/cache directories and pinned lockfile
verification.

### NF-6 — MINOR: approval freshness and scope are under-constrained

**Evidence:** `external-effect-approval.ts:31-47` requires parseable `approvedAt` and
`expiresAt` but never checks `approvedAt <= now`, never bounds maximum lifetime, and permits
`prefix/*` approvals with arbitrary suffix depth (`:74-81`). A future-dated approval or
multi-year standing wildcard is accepted. The script does request an exact branch, but the
public evaluator permits broad reusable approvals.

**Required fix:** reject future `approvedAt`, require `approvedAt <= now < expiresAt`, enforce
an operator-defined maximum TTL, and bind approval to exact branch plus commit/ref and
specific effect parameters.

## 4. Residual risks explicitly accepted (not blockers from this phase)

- Host clock is trusted for expiry (`new Date()`); no trusted remote time source exists in
  this local script.
- `resolveAuthorizedWorkspace` excludes only forbidden-root equality, not all descendants,
  because legitimate worktrees are nested under the repository. The caller must supply a
  genuine WorktreeManager-assigned path.
- The current `worktreePath` security boundary is path-based and has a local TOCTOU race;
  this review reports it as NF-3 rather than silently accepting it.
- GlobalGates needs ordinary runtime lookup/config variables, so PATH and package-manager/XDG
  locations remain in its allowlist; tool provenance is a separate hardening task.
- No production deployment is authorized. DEC-0003's RLS requirement remains binding;
  DEC-0012 correctly records, but does not resolve, the contradiction.
- F2's host-local wall clock and operator-controlled approval-file selection are acceptable
  only for a trusted local/dev operator after NF-1 is fixed; they are not suitable as a
  production-grade human-attestation mechanism.

## 5. Existing tests/security posture

- New negative-case tests are substantive, not only snapshots: policy tests spy on runtime
  execution; approval tests cover malformed/denied/stale/scope/branch/I/O cases; boundary
  tests cover empty/relative/nonexistent/file/forbidden-root/traversal/absolute/sibling
  paths; GlobalGates includes a real child process; reviewer tests cover every stubbed
  category and correction escalation.
- The test suite does **not** cover the empty `requiredChecks` bypass, approval forgery,
  approval `approvedAt`/TTL, symlink replacement race, registered-worktree validation or
  tool poisoning. Those omissions are material to the findings above.
- No new secret was identified in the reviewed diff. Secret-like strings are test fixtures,
  redaction tests or documentation examples; no live credential/private-key pattern was
  found. The branch does not weaken existing security tests in the functional commits.

## 6. Independent verdict

**SECURITY_REJECTED** — blockers: **NF-1 (BLOCKER)** and **NF-2 (MAJOR)**. NF-3 (MAJOR)
requires an explicit trusted-host decision or a race-safe write implementation before any
hostile-local-process deployment. F2/F6 are not adequate as claimed for autonomous success
until approval authenticity and non-empty review requirements are enforced.

The Phase 2 branch is materially safer and its F3/F4/F5 controls are directionally sound,
but the stated “human approval artifact” and “no autonomous mission can claim reviewed /
corrected success” invariants are not fully achieved.