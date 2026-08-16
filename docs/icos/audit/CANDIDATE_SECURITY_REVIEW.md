# Candidate Security Review — `feat/cockpit-real-wiring-1`

- Reviewer: Shield (independent Security Reviewer), RECONCILIATION PHASE 1
- Date: 2026-08-15
- Candidate: `feat/cockpit-real-wiring-1` @ `ba610ca` (49 ahead of `main` @ `7e2ea80`, 0 behind)
- Scope: diff `main..feat/cockpit-real-wiring-1`; read-only checkout at `/Users/coco/icos/icos-cockpit-real`
- Governance authority: `CLAUDE.md`, `.claude/rules/security.md`, `.claude/rules/database.md`, `.claude/rules/quality.md`

All paths below are relative to the candidate checkout `/Users/coco/icos/icos-cockpit-real/` unless prefixed otherwise. Line numbers refer to the candidate at `ba610ca`.

---

## Severity summary

| Severity | Count |
|---|---|
| BLOCKER | 0 |
| HIGH | 2 |
| MEDIUM | 5 |
| LOW | 5 |
| INFO | 5 |

Verdict (also at end of report): **SECURITY_OK_WITH_FIXES**

---

## Dimension 1 — Authorization

### Findings

**F1.1 — INFO — GET job detail is viewer-readable while POST requires operator.**
`src/app/api/cockpit/jobs/route.ts` (POST: `protectRoute(... role: "operator", sameOrigin: true)`) vs `src/app/api/cockpit/jobs/[id]/route.ts:24-29` (GET: `permission: "cockpit.read"`, held by the viewer role per `src/core/identity/permissions.ts`). Job projections are sanitized/bounded, so exposure is informational only.
Remediation: confirm intentionally, or align read permission with the operator role.

**F1.2 — INFO — SystemAgent executor identity is composition-owned and cannot be influenced by request input.**
`src/server/cockpit/runtime.ts:414-420` (frozen `executorIdentity`, `authorizationLevel: 2`), `:134` (submission rejected unless `tenantId === executorIdentity.tenantId`), `:175` (`structuredClone` per execution). No privilege-escalation path from request data to identity was found.
Remediation: none (positive control, recorded as evidence).

### Positive controls verified
- Both new routes are guarded: `protectRoute` with role/permission + CSRF `sameOrigin` on the mutating route (`src/app/api/cockpit/jobs/route.ts`; `src/server/http/protect-route.ts` pre-exists on main, unchanged).
- Strict zod input validation, UUID idempotency key, strict job-id regex (`src/app/api/cockpit/jobs/[id]/route.ts:12-16`).
- D1 policy engine default-deny preserved: `src/core/policy/engine.ts:75-82` catches internal errors and returns `deny`; PermissionGate denies on missing identity/permission.
- Capability preflight blocks `DENIED` → `BLOCKED_BY_POLICY` and `APPROVAL_REQUIRED` → `WAITING_FOR_APPROVAL` before any execution (`src/server/usecases/plan-and-execute-mission.ts:183-203, 457-489`).

---

## Dimension 2 — Tenant isolation

### Findings

**F2.1 — MEDIUM — No RLS on `mission_contexts` (or anywhere in the repo); tenant isolation is application-layer only.**
`drizzle/0009_mission_context.sql` creates `mission_contexts` with composite PK `(tenant_id, mission_id, version)` but no `ROW LEVEL SECURITY`. Every repository query does filter `tenant_id AND mission_id` (`src/server/context/postgres/mission-context-repository.ts`), so there is no observed leak path, but a single missed `WHERE` anywhere becomes a cross-tenant read. `.claude/rules/database.md` requires an identified RLS strategy for tenant data.
Remediation: add an ADR documenting the RLS strategy (or enable RLS with a `tenant_id` policy) before this table carries multi-tenant production data.

**F2.2 — LOW — Cockpit runtime hard-pins tenant `"default"`.**
`src/server/cockpit/runtime.ts:64` (`LOCAL_TENANT_ID = "default"`) and `:134` mean any resolver-produced tenant other than `"default"` is rejected (fail-closed 500, not a leak). Single-tenant by construction.
Remediation: document the single-tenant limitation; derive executor tenant from configuration when multi-tenant is introduced.

### Positive controls verified
- Job registry is tenant-scoped on every read/transition: `src/server/cockpit/job-registry.ts:203-207, 242-244`; idempotency keys are tenant-prefixed with length disambiguation (`:328-330`).
- Route handlers resolve tenant via `container.tenantResolver` before touching the runtime (`src/app/api/cockpit/jobs/[id]/route.ts:40-47`).
- Mission/supervisor use cases re-verify tenant match defensively (`src/server/usecases/plan-and-execute-mission.ts:301, 369-375`; `src/server/supervisor/supervisor-service.ts:178-191`).
- Postgres mission-context repository: append-only versioned writes, `23505` → `version_conflict` (optimistic lock).

---

## Dimension 3 — Tool execution

### Findings

**F3.1 — HIGH — WorkerManager treats `require_approval` as executable at spawn.**
`src/server/worker/worker-manager.ts:138` throws only on `policyDecision.outcome === "deny"`; a `require_approval` outcome falls through and the worker proceeds. Risk is hardcoded `"reversible"` at `:135`, so `require_approval` is unlikely to be produced today, and the downstream `ExecutionOrchestrator` re-check fails closed on `require_approval` (`src/server/runtime/execution-orchestrator.ts:118-126`) — so this is currently a latent, defense-in-depth gap rather than a live bypass. It becomes a live approval bypass for any future worker path that does not route through the orchestrator.
Remediation: change the check to `if (policyDecision.outcome !== "allow") throw`, mirroring `deterministic-patch-worker.ts:174-180`.

**F3.2 — MEDIUM — `scripts/first-auto-mission.ts` repeats the `require_approval` fall-through with no downstream re-check.**
`scripts/first-auto-mission.ts:123` throws only on `"deny"`; unlike WorkerManager, this script's worker executes directly, so `require_approval` would proceed unmediated.
Remediation: require `outcome === "allow"` in the script as well.

**F3.3 — LOW — `baseSha` is passed unvalidated as a git argument.**
`src/server/worktree/worktree-manager.ts:106` runs `git worktree add -B <branch> <path> <effectiveBaseSha>`; branch name is validated via `check-ref-format` (`:134-137`) but `baseSha` is not format-checked. `execFile` prevents shell injection and git rejects option-looking refs poorly at worst, but a `-`-prefixed value could be interpreted as a flag.
Remediation: validate `baseSha` against `/^[0-9a-f]{7,40}$/i` (or use `--` separation) before passing it to git.

### Positive controls verified
- `DeterministicPatchWorker` is the tightest surface in the candidate: strict process allowlist for exact git/pnpm argument shapes (`src/server/worker/deterministic-patch-worker.ts:688-716`), policy `outcome !== "allow"` → throw (`:174-180`), catalog-only patches, path validation rejecting absolute paths, `..`, and symlinks with worktree containment (`:517-609`), post-run `assertOnlyDeclaredChanges`, and hardcoded `mergePerformed: false, productionPerformed: false`.
- `execFile` (not `exec` with shell) used throughout `worktree-manager.ts`.
- `LocalRuntimeAdapter`: `simulateSuccess` removed; missing command fails closed (`INTERNAL_ERROR`); env allowlist defaults to `["PATH","HOME","TMPDIR","NODE_NO_WARNINGS"]`.
- Cockpit composition wires an empty patch catalog (`src/server/cockpit/runtime.ts:355-357`) and a default-deny network policy (`:397-404`) — no executable tool surface is actually reachable from the cockpit UI (see F8.2).

---

## Dimension 4 — Runtime isolation

### Findings

**F4.1 — MEDIUM — FirstAutoWorker can fall back to operating on the main checkout.**
`scripts/first-auto-mission.ts:176` defaults `worktreePath ?? ""` and `:207` falls back to `repoRoot = worktreePath ? worktreePath : await this.getRepoRoot()` — with an empty worktree path, file writes and commits target the primary repository checkout, escaping worktree isolation entirely.
Remediation: throw when `worktreePath` is absent instead of falling back to the repo root.

**F4.2 — LOW — Worktree registration check uses substring matching.**
`src/server/worktree/worktree-manager.ts:97` uses `existing.includes(worktreePath)` over `git worktree list --porcelain` output (prefix-collision-prone), whereas `:141` correctly requires the exact `worktree ${path}` line. Impact is limited to a duplicate-registration miss inside manager-owned paths.
Remediation: use the exact `worktree ${path}` line match in both places.

### Positive controls verified
- `assignToTask` enforces canonical (realpath) worktree path, registered-worktree membership, and canonical branch name before use.
- `cleanupWorktree` refuses to delete the repo root, refuses unmanaged entries, and applies `branch -D` only to manager-owned `worktree-*` / `integration/*` branches, never `feat/*` (`src/server/worktree/worktree-manager.ts:283-307`).
- `IntegrationOrchestrator` cherry-picks into `integration/*` worktrees only, verifies merge-base ancestry (`src/server/integration/integration-orchestrator.ts:46-51`), and never pushes or touches `main`.
- Supervisor requires a common base SHA across tasks (`supervisor-service.ts:490-499`) and a clean worktree after review (`:425-429`); worktrees are cleaned up before `COMPLETED` (`:531-553`).
- Cockpit's `taskWorktreeRoot: process.cwd()` (`runtime.ts:362`) mismatches WorktreeManager's `.claude/worktrees` layout, so `validateTaskWorktree` (`deterministic-patch-worker.ts:532-544`) fails closed — no cockpit-triggered write can land anywhere.

---

## Dimension 5 — Approval gates

### Findings

**F5.1 — HIGH — V1 ReviewerWorker is a rubber stamp; the "independent review" gate does not review.**
`src/server/review/reviewer-worker.ts:92-133`: the `tests`, `scope`, `security_boundaries`, `architecture_boundaries`, `regressions`, and `code_quality` checks all return `passed: true` unconditionally; the verdict is PASS iff `acceptanceCriteria.length >= 1`. `ensureIndependentReview` (`:25-30`) only asserts `reviewerWorkerId !== taskId`, which is trivially true across ID namespaces. `CorrectionWorker.executeCorrection` (`:165-175`) reports `"CORRECTED"` without performing any correction. The supervisor treats review PASS as the mandatory gate before `SUCCEEDED` (`supervisor-service.ts:371-415`), so the gate exists structurally but is vacuous in substance. This directly conflicts with `.claude/rules/quality.md` ("Do not claim completion from compilation alone... produce evidence") and CLAUDE.md ("completion requires evidence").
Remediation: before any non-inert composition ships, replace the stub with checks that consult real evidence (gate results, diff scope, declared files) or mark review verdicts as `UNVERIFIED` so downstream gates fail closed.

**F5.2 — HIGH — `first-auto-mission.ts` performs autonomous external effects (push + PR) with no human approval and no D1 ExternalEffectGate.**
`scripts/first-auto-mission.ts:984-1037`: `git push origin integration/<dagId>` followed by `gh pr create`, gated only on `gh auth status` output containing "Logged in" — an ambient-credential check, not an approval. Phase 10 then prints self-attested governance "PASS" lines. This violates the repo rule that external/irreversible effects require approval, and bypasses the policy layer (`ExternalEffectGate` produces `require_approval` precisely for this class of action).
Remediation: route the push/PR step through a D1 decision with `hasExternalEffect: true` and block on anything other than an explicit human approval artifact; remove self-attested PASS output.

### Positive controls verified
- `ExecutionOrchestrator` Phase-1 re-check fails closed on both `deny` (→ `POLICY_DENIED`) and `require_approval` (→ `REQUIRES_APPROVAL`) (`execution-orchestrator.ts:95-194`).
- Capability preflight converts `APPROVAL_REQUIRED` into `WAITING_FOR_APPROVAL` before execution (`plan-and-execute-mission.ts:183-203`).
- `PreviewDelivery` with `allowExternalPreview: false` yields `LOCAL_RESULT_READY`; external delivery requires `WAITING_FOR_HUMAN` (`src/server/preview/preview-delivery.ts`).
- Self-state gate blocks execution unless the repo-versioned snapshot asserts `LOCAL_DEV_ONLY=true`, no production access, credentials forbidden, external irreversible actions forbidden (`plan-and-execute-mission.ts:141-150`; `src/server/self-state/load-self-state-snapshot.ts` fails closed on load/validation error).
- The correction loop is bounded and escalates (never self-approves) after `maxAttempts` (`src/server/review/correction-loop.ts`); supervisor maps non-PASS to node FAILED.

---

## Dimension 6 — Secret handling

### Findings

**F6.1 — MEDIUM — GlobalGates executes integrated (worker-produced) code with the full inherited process environment.**
`src/server/integration/global-gates.ts:112-123`: `run()` spawns `pnpm lint/typecheck/test/build` with no env scrubbing. `pnpm test`/`pnpm build` execute code that workers just modified, inside a process that inherits secrets such as `OMNIROUTE_API_KEY` — an exfiltration channel from integrated code to secrets. Contrast the deterministic worker's scrubbed child env (`deterministic-patch-worker.ts:96-113`: PATH/TMPDIR/NODE_ENV only, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`).
Remediation: pass an allowlisted env (PATH/HOME/TMPDIR/NODE_ENV + explicitly required vars) to GlobalGates child processes.

**F6.2 — INFO — `first-auto-mission.ts` similarly runs gates/push with inherited env plus ambient `gh` credentials.**
Same class as F6.1/F5.2; the ambient `gh` token is what makes the autonomous PR possible.
Remediation: covered by F5.2 + F6.1 remediations.

### Positive controls verified
- OmniRoute API key flows only from `env.OMNIROUTE_API_KEY` (`src/server/ai/omniroute-config.ts`) into the `Authorization: Bearer` header (`src/server/ai/omniroute-adapter.ts:305-306`); never logged; upstream error messages are replaced with generic text (no echo of provider payloads).
- Cockpit conversation output filter rejects internal-config disclosure patterns (`request-router.ts:29-30, 126-135`).
- Runtime credential broker returns empty references/environment in the cockpit composition (`runtime.ts:392-396`); no secret reaches worker env.
- Sanitized job errors are bounded and generic (`job-registry.ts:217-230`); no exception text from providers reaches clients.

---

## Dimension 7 — Destructive operations

### Findings

**F7.1 — LOW — `git worktree remove --force` and `rm -rf` are used, but only behind ownership guards.**
`worktree-manager.ts:283-307`: cleanup refuses the repo root and unmanaged entries; forced removal and `branch -D` apply only to manager-owned `worktree-*`/`integration/*` artifacts. Residual risk is a bug in path canonicalization, mitigated by realpath checks.
Remediation: keep; add a unit test asserting refusal for `feat/*` branches and out-of-root paths (tests exist for the happy path).

**F7.2 — LOW — Integration commits run with git hooks disabled.**
`integration-orchestrator.ts` commits with hooks disabled in the integration worktree. This avoids running untrusted hooks (good) but also skips any protective hooks. Verdicts rely on GlobalGates instead (exit-code authoritative), which is acceptable.
Remediation: none required; document the rationale.

### Positive controls verified
- No force-push anywhere in the candidate; no push at all outside `scripts/first-auto-mission.ts` (covered by F5.2).
- `main` is never checked out, committed to, or reset by supervisor/integration code paths.
- Job registry purges are bounded to terminal, TTL-expired records (`job-registry.ts:291-320`).

---

## Dimension 8 — Fail-closed behavior

### Findings

**F8.1 — MEDIUM — D4 network-policy denial is observed but not enforced.**
`src/server/runtime/execution-orchestrator.ts:166-170`: the network decision `"deny"` is recorded with a comment ("continue but note the decision") rather than aborting execution. In the cockpit composition the network policy is always `deny` (`runtime.ts:397-404`), so every execution proceeds despite a deny verdict — the control is currently decorative. Actual egress is limited by the runtime adapter env/command allowlists, so this is not a live bypass today.
Remediation: enforce `outcome === "deny"` → fail the execution (or explicitly rename the port to advisory until enforced).

**F8.2 — INFO — Cockpit "real wiring" mission path is inert-by-composition and fails closed at every step.**
Empty patch catalog (`runtime.ts:355-357` → `PATCH_NOT_CATALOGUED`) plus `taskWorktreeRoot` mismatch (`runtime.ts:362` vs WorktreeManager `.claude/worktrees` → `INVALID_WORKTREE`) mean every cockpit-submitted MISSION task fails safely. This is a fail-closed posture, but it also means the "real" execution path has not been exercised end-to-end; several findings above (F3.1, F5.1) become live the moment a non-empty catalog is wired.
Remediation: when the catalog is populated, re-run this review's Dimension 3/5 checks first.

**F8.3 — INFO — Conversation router regex classifier is heuristic and steerable, but downstream is bounded.**
`request-router.ts:49-55`: crafted phrasing can steer classification to MISSION, but the mission path is fully policy-gated and inert (F8.2); AUTHORITY_INJECTION patterns force CONVERSATION; conversation output is filtered for action claims/ability claims/config disclosure (`:124-135`). Regex classifiers must not be relied on as a security boundary.
Remediation: treat classification as UX routing only (it already is); keep policy gates authoritative.

**F8.4 — LOW — `executorIdentity.tenantId === "default"` coupling.**
If `tenantResolver` yields any other tenant, all submissions fail with a 500 (`runtime.ts:134`) — fail-closed, but a poor failure mode.
Remediation: return a structured 403/409 rather than a thrown generic error.

### Positive controls verified
- Policy engine: internal error → `deny` (`src/core/policy/engine.ts:75-82`).
- Missing OmniRoute config → `failClosedGateway` returning `PROVIDER_UNAVAILABLE` (`runtime.ts:365-390`).
- Gateway responses schema-validated; invalid/empty/unsafe → sanitized failure (`request-router.ts:115-135`).
- Job execution rejection path marks FAILED with a generic sanitized error (`runtime.ts:143-155`).
- Job state machine forbids resurrecting terminal jobs and invalid transitions (`job-registry.ts:246-256`).
- Self-state snapshot load error → throw (execution blocked), never a permissive default.

---

## Explicit uncertainty

- I did not execute the candidate's test suite; findings are from source review of the diff and full checkout only (consistent with the read-only mandate).
- `protectRoute`, container/tenant-resolver internals pre-exist on `main` and were verified unchanged, not re-audited in depth.
- `scripts/first-auto-mission.ts` may be intended as a demo script outside the production composition; F5.2/F4.1/F3.2 severities assume it is runnable in a developer environment with ambient `gh`/git credentials, which it is.
- RLS absence (F2.1) is a repo-wide pre-existing pattern; the candidate adds a new tenant-keyed table into that pattern rather than creating the pattern.

---

## Verdict

**SECURITY_OK_WITH_FIXES**

Must-fix before integration (or before the inert composition is made live):
1. F5.2 — remove/gate the autonomous `git push` + `gh pr create` in `scripts/first-auto-mission.ts` behind explicit human approval and the D1 ExternalEffectGate.
2. F5.1 — replace or explicitly quarantine the rubber-stamp `ReviewerWorker`/`CorrectionWorker` so the mandatory review gate carries real evidence.
3. F3.1 / F3.2 — change WorkerManager and the first-auto script to require `outcome === "allow"` (treat `require_approval` as blocking).
4. F4.1 — remove the repo-root fallback in `scripts/first-auto-mission.ts`; absent worktree path must throw.
5. F6.1 — scrub/allowlist the environment passed to GlobalGates child processes.
