# DECISION REVIEW — DEC-0011 & DEC-0012 (owner acceptance requested)

- **Date**: 2026-08-16 (Phase 2B)
- **Status of both records**: `PROPOSED` — written by the agent, **not** accepted. Per governance, the proposing agent cannot self-accept; only the human owner may set `status: ACCEPTED` or `REJECTED` in `.icos/decisions/DEC-0011.yaml` / `DEC-0012.yaml`.
- **Why you are being asked**: repository rule "architecture changes require ADR/Decision" (DEC-0011 regularizes a violation of it) and DEC-0003 conformity (DEC-0012 records a standing contradiction). Neither record has any effect until you decide.

---

## DEC-0011 — Adopt the supervisor/worker autonomous mission architecture

### Owner-oriented summary

**The decision being asked of you.** Approve, retroactively, the architecture that the integration candidate `feat/cockpit-real-wiring-1` already implements: SupervisorService (mission DAG planning), WorkerManager (worker spawn gated by the D1 policy engine), git-worktree-isolated workers, an independent review + correction loop, GlobalGates quality gates, and an IntegrationOrchestrator. It was built without a prior ADR — this record repairs the governance gap by describing what was built and submitting it for your explicit approval. Accepting it does **not** approve autonomous external effects (push/PR — separately gated by the signed approval authority, NF-1) and does **not** approve production deployment.

**Alternatives you could choose instead.**
1. **Accept (regularize)** — the architecture becomes governed; all its fail-closed constraints (listed in the record) become binding.
2. **Reject** — the candidate branch cannot proceed to integration; the architecture would need to be re-proposed properly (ADR first) or abandoned. Code remains preserved on its branch either way.
3. **Accept with modifications** — edit the record's constraints before accepting (e.g. add stricter conditions on the V2 review gate).

**Consequences of accepting.** The supervisor/worker runtime becomes the sanctioned ICOS execution architecture for autonomous missions, under these standing constraints: any D1 outcome other than explicit `allow` blocks execution; workers only operate inside their assigned worktree; the review gate is an explicit fail-closed stub until a real V2 reviewer exists (autonomous mission paths stay inert — review-requiring flows escalate to a human); external effects require a signed, non-forgeable, single-use human approval (Phase 2B NF-1); no production deployment is implied.

**Reversibility.** Marked `reversible: true` and genuinely so: no production state, no data migration, no external dependency is created by acceptance. Reversal = setting the record to REJECTED/SUPERSEDED and not integrating (or reverting) the branch.

### Complete record content (`.icos/decisions/DEC-0011.yaml`)

```yaml
decision_id: DEC-0011
status: PROPOSED
topic: "Adopt the supervisor/worker autonomous mission architecture (icos-cockpit-real) as the ICOS execution runtime"
authority: APPROVAL
owner: human-owner
rationale: >-
  The integration candidate feat/cockpit-real-wiring-1 introduces a
  supervisor architecture (SupervisorService orchestration, WorkerManager
  gated by the D1 policy engine, worktree-isolated workers, independent
  review + correction loop, GlobalGates quality gates, IntegrationOrchestrator)
  that was implemented without a prior ADR/Decision, in violation of the
  repository rule "architecture changes require ADR/Decision". This record
  regularizes governance retroactively: it describes the architecture as
  built and submits it for explicit owner approval. It does NOT approve
  autonomous external effects (git push / PR creation), which remain gated
  by a human approval artifact (Phase 2 fix F2), nor production deployment.
reversible: true
evidence:
  - "docs/icos/audit/INTEGRATION_CANDIDATE_REVIEW.md"
  - "docs/icos/audit/CANDIDATE_SECURITY_REVIEW.md"
  - "docs/icos/audit/COMMIT_MAP_49.md"
supersedes: null
# ── Extended context (Phase 2 hardening, F7) ─────────────────────────
proposed_by: "claude-code (RECONCILIATION PHASE 2)"
proposed_at: "2026-08-15"
architecture_summary:
  - "SupervisorService: mission DAG planning and task orchestration"
  - "WorkerManager: worker spawn strictly gated by D1 PolicyDecision — any outcome other than allow (deny, require_approval, unknown, engine unavailable) blocks execution fail-closed (Phase 2 fix F3)"
  - "Worktree isolation: workers operate only inside their assigned worktree; repo-root fallback removed, path boundaries enforced (Phase 2 fix F4)"
  - "Review/correction loop: ReviewerWorker + CorrectionWorker are explicit fail-closed V1 stubs — unverified review categories fail, corrections escalate to a human, no rubber-stamp PASS (Phase 2 fix F6)"
  - "GlobalGates: sequential deterministic quality gates with explicit subprocess env allowlist — parent secrets never propagate (Phase 2 fix F5)"
  - "External effects (git push, PR creation): fail-closed human approval artifact required (Phase 2 fix F2)"
constraints:
  - "No tenant context -> no tenant operation (unchanged)"
  - "Agents never bypass service/policy layers to production data (DEC-0004, unchanged)"
  - "Autonomous mission paths remain inert/fail-closed until a real review gate (V2) exists"
acceptance_required_from_owner: >-
  This decision is PROPOSED and has no effect until the human owner sets
  status to ACCEPTED. The proposing agent cannot self-accept.
```

> Phase 2B note: the "human approval artifact (Phase 2 fix F2)" referenced above has since been hardened into the **signed, non-forgeable approval authority** (NF-1, Ed25519, out-of-workspace private key, exact bindings, single-use nonce). Accepting DEC-0011 endorses the hardened form, not the original unsigned artifact.

---

## DEC-0012 — mission_contexts no-RLS contradiction with DEC-0003

### Owner-oriented summary

**The exact contradiction.** DEC-0003 (ACCEPTED) mandates tenant isolation as **defense-in-depth: application-layer authorization AND PostgreSQL Row-Level Security**. The candidate's migration `drizzle/0009_mission_context.sql` creates the tenant-keyed table `mission_contexts` (PK `tenant_id, mission_id, version`) **without** `ENABLE ROW LEVEL SECURITY`, and no migration in the candidate enables RLS on any table (`grep 'ROW LEVEL' drizzle/*.sql` → no matches). One of the two mandated layers is missing.

**Why mission_contexts lacks RLS.** The candidate was developed against a local/dev, single-tenant runtime (`icos-single-tenant`); the author implemented tenant scoping only at the repository layer (composite PK forces `tenant_id` into every query path) and never added the RLS layer required by DEC-0003. There is no design rationale on record for omitting it — it is an implementation gap, not a decided trade-off. This record refuses to normalize it silently.

**Current compensating controls.**
- All `mission_contexts` access goes through the repository layer; every query requires `tenant_id` (composite PK starts with it).
- DEC-0004: agents have no direct unrestricted database access — service/policy layers only.
- Runtime is local/dev only; no production deployment exists; production changes require the release policy.
- Rows are append-only immutable snapshots — no UPDATE path.

**Residual risk while the exception stands.** A single application-layer bug (missing `tenant_id` filter, mapper error, future repository bypass) or any direct DB access exposes cross-tenant mission-context payloads (jsonb snapshots of mission state). One layer of defense instead of the mandated two.

**Remediation / exit condition (binding if you accept).** An **additive** migration enabling RLS with tenant-scoped policies on `mission_contexts` (and other tenant-keyed tables), including rollback/data-safety analysis per the database rule, **before any production use**; then re-verify DEC-0003 conformity and update this record.

**Temporary exception or intended architecture?** **Temporary exception, explicitly.** Accepting DEC-0012 does not supersede or weaken DEC-0003 — it is a time-bounded interim risk acceptance with a binding follow-up. If you consider app-layer-only isolation acceptable as the *permanent* architecture, that would instead require superseding DEC-0003 itself — which this record deliberately does not propose.

**Your options.**
1. **Accept** — explicit interim risk acceptance under the compensating controls, with the RLS follow-up binding before production.
2. **Reject** — blocks the candidate until the RLS migration lands.

### Complete record content (`.icos/decisions/DEC-0012.yaml`)

```yaml
decision_id: DEC-0012
status: PROPOSED
topic: "Record and remediate the mission_contexts no-RLS contradiction with DEC-0003 (tenant isolation defense-in-depth)"
authority: APPROVAL
owner: human-owner
rationale: >-
  DEC-0003 (ACCEPTED) mandates tenant isolation as defense-in-depth:
  application-layer authorization AND PostgreSQL Row-Level Security.
  The integration candidate's migration drizzle/0009_mission_context.sql
  creates the tenant-keyed table mission_contexts (primary key
  tenant_id, mission_id, version) WITHOUT enabling RLS — and no migration
  in the candidate enables RLS on any table. This is a standing
  contradiction with DEC-0003. Per Phase 2 directive F7, this record does
  NOT silently resolve the contradiction: it documents it, states the
  current risk and compensating controls, and requires a follow-up RLS
  migration before any production use. Accepting this decision means the
  owner explicitly accepts the interim risk under the compensating
  controls below — it does not supersede or weaken DEC-0003.
reversible: true
evidence:
  - "drizzle/0009_mission_context.sql (icos-cockpit-real) — CREATE TABLE mission_contexts, no ENABLE ROW LEVEL SECURITY"
  - "grep 'ROW LEVEL' drizzle/*.sql -> no matches (no migration enables RLS)"
  - "docs/icos/audit/CANDIDATE_SECURITY_REVIEW.md"
supersedes: null
# ── Extended context (Phase 2 hardening, F7) ─────────────────────────
proposed_by: "claude-code (RECONCILIATION PHASE 2)"
proposed_at: "2026-08-15"
contradiction:
  accepted_decision: "DEC-0003 — tenant isolation = application authorization + PostgreSQL RLS (defense-in-depth)"
  observed_state: "mission_contexts (and the candidate schema generally) relies on application-layer tenant scoping only; RLS is not enabled"
current_risk: >-
  A bug in the application layer (missing tenant_id filter, mapper error,
  future repository bypass) or any direct database access would expose
  cross-tenant mission context payloads (jsonb snapshots of mission state).
  Single layer of defense instead of the mandated two.
compensating_controls:
  - "All mission_contexts access goes through the repository layer, which requires tenant_id in every query (composite primary key starts with tenant_id)"
  - "DEC-0004: no direct unrestricted agent database access — agents pass through service/policy layers"
  - "Runtime is local/dev only; no production deployment exists, and production changes require release policy"
  - "Append-only immutable snapshots: no UPDATE path to corrupt cross-tenant"
follow_up_required:
  - "Add an additive migration enabling RLS on mission_contexts (and other tenant-keyed tables) with tenant-scoped policies, before any production use"
  - "Migration must include rollback/data-safety analysis per the database rule"
  - "Re-verify DEC-0003 conformity after the migration and update this record's status"
acceptance_required_from_owner: >-
  PROPOSED only. The owner must either ACCEPT (explicit interim risk
  acceptance with the follow-up requirement binding) or REJECT (blocking
  the candidate until RLS is added). The proposing agent cannot
  self-accept and has not modified DEC-0003.
```

---

## How to act

Edit the `status:` field of each YAML in `.icos/decisions/` to `ACCEPTED` or `REJECTED` (optionally adding `accepted_at`/`accepted_by`). Nothing else in either record needs to change. The agent will not modify these records further.
