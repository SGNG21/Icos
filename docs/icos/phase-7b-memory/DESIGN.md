# Phase 7B — Operational Memory (design)

Status: implemented on `feat/phase-7b-memory` (worktree `phase-7b-memory`). Decision record: this document
is the ADR-in-waiting; promote to `docs/decisions/00NN-*.md` at integration once 7A's ADR number is known.

## 0. Scope

In: three separated memories (mission / procedural / user-business), a traceable retrieval layer, PostgreSQL
persistence, provenance + freshness + confidence + visibility on every entry.
Out: 7C, 7D, Guardian, multi-worker, embeddings/pgvector (see §6), any wiring into the Scheduler.

## 1. Invariants

| #   | Invariant                                                                                    | Enforced by                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | PostgreSQL is the only source of truth; no in-RAM-only critical memory                       | no in-memory backend; ports implemented on PG only                                                                                                                                                         |
| I2  | No tenant context, no operation                                                              | `tenantId` mandatory on every port method; `tenant_id NOT NULL` on every table; every query filtered on it                                                                                                 |
| I3  | Every entry carries scope, provenance, timestamps, freshness, confidence, source, visibility | Zod envelope + `NOT NULL`/`CHECK` in SQL                                                                                                                                                                   |
| I4  | Mission memory is append-only evidence                                                       | trigger `icos_forbid_memory_mutation` (`IC002`); corrections = new row with `supersedes_id`                                                                                                                |
| I5  | Procedural memory evidence is append-only and idempotent                                     | `procedural_memory_evidence` unique `(entry_id, source_type, source_id)`; counters derive from it                                                                                                          |
| I6  | Workers cannot write user/business memory                                                    | store API: only `HumanActor` can `record/approve/reject/retract`; agents may only `propose` (status `proposed`, never retrievable); SQL `CHECK` forbids `active/superseded/retracted` without `decided_by` |
| I7  | Business memory values are immutable once written                                            | trigger `icos_business_memory_guard` (`IC003`): only status/version/decision/verification columns may change                                                                                               |
| I8  | User/business memory is separate from runtime logs                                           | own table + own retrieval method; results never merged into one ranking                                                                                                                                    |
| I9  | Retrieval is traceable                                                                       | every retrieval appends a `memory_retrieval_log` row (requester, query, returned ids, exclusion counts); the `retrievalId` is returned                                                                     |
| I10 | No secrets in memory                                                                         | `containsSecret` rejects payload/summary/value before any write (`MemorySecretRejectedError`)                                                                                                              |
| I11 | Visibility enforced in SQL, not after `LIMIT`                                                | `visibility` predicate built from the reader; denied rows only counted, never returned                                                                                                                     |
| I12 | Expired entries are never returned; stale entries are returned tagged `stale`                | freshness predicate in SQL + pure `freshnessOf`                                                                                                                                                            |
| I13 | No hard dependency on the Scheduler                                                          | zero imports from 7A files; recorders are pure mappers over existing contracts                                                                                                                             |
| I14 | Migrations are additive; existing migrations untouched                                       | new migration only                                                                                                                                                                                         |

## 2. Existing concepts reused / left alone

`decisions` (review decisions), `task_execution_results`, `audit_entries`, `checkpoints`, `learned_patterns`,
`context_items`, `handoff_packages` and `DurableMemory` (Phase 5) are **not modified**. They stay the
runtime record. 7B entries _reference_ them via `source_type` + `source_id` (provenance) and never copy secrets
or full worker output: only a bounded summary + structured payload.
`learned_patterns` (untyped confidence, no provenance, no tenant) is superseded conceptually by
`procedural_memory_entries`; migration of its rows is out of scope (documented, not done).

## 3. Schema (migration `0031_operational_memory`)

Shared envelope on all three entry tables:
`tenant_id, source_type, source_id, recorded_by_type, recorded_by, occurred_at, recorded_at (server clock),
last_verified_at, stale_after, expires_at, confidence (0..1), confidence_basis, visibility, owner_subject,
required_permission`.
`CHECK`: `private` ⇒ `owner_subject`; `restricted` ⇒ `required_permission`; text lengths bounded; `payload`
octet length ≤ 64 KiB.

- `mission_memory_entries` — `mission_id` FK→missions (RESTRICT), `mission_task_id` (soft ref: replans may
  delete task rows), `kind` ∈ objective|plan|decision|result|error|retry|review|artifact|terminal_state,
  `scope` ∈ mission|task, `supersedes_id`. Unique `(tenant, kind, source_type, source_id)` (replay-safe);
  partial unique `(tenant, mission_id) WHERE kind='terminal_state' AND supersedes_id IS NULL`.
- `procedural_memory_entries` — `kind` ∈ successful_plan|strategy|skill_usage|recovery_pattern|recurring_error|validated_remediation,
  `scope` ∈ tenant|capability|worker_kind + `scope_key` (`'*'` for tenant), `signature`, `status` ∈
  candidate|validated|deprecated, counters `occurrence/success/failure` (CHECK sum), `validated_by/at`.
  Unique `(tenant, kind, scope, scope_key, signature)`. `validated_remediation` ⇒ status validated|deprecated.
- `procedural_memory_evidence` — one row per observation (append-only).
- `business_memory_entries` — `kind` ∈ preference|business_fact|constraint|guideline, `scope` ∈ user|tenant,
  `subject_key`, nullable `version` (assigned on activation), `status` ∈ proposed|active|superseded|retracted|rejected,
  `decided_by/at`, `supersedes_id`. Unique partial `(tenant, scope, scope_key, subject_key) WHERE status='active'`.
- `memory_retrieval_log` — append-only trace.

All FKs `ON DELETE RESTRICT`. Booleans/enums via `CHECK`. `timestamptz` everywhere.
RLS: not enabled — the repo has no RLS anywhere yet (tenant isolation is application-level + `tenant_id`
predicate, same as `skills`). Tracked as risk R4; `tenant_id` is the ready-made RLS key.

## 4. Repository interfaces (`src/server/memory/ports.ts`)

```
MissionMemoryStore    append(actor, input) → {entry, created} · find(reader, q) → {entries, stats} · getById
ProceduralMemoryStore observe(actor, input) → entry · validate(human, id, evidence) · deprecate(actor, id) · find
BusinessMemoryStore   record(human, input) · propose(actor, input) · approve|reject|retract(human, id) · find
RetrievalLogStore     append(row) · listByRequester(tenant, requesterId)
MemoryService         facade: retrieveMission | retrieveProcedural | retrieveBusiness → { retrievalId, entries, stats }
```

`MemoryActor = { tenantId, kind: human|agent|system, id, permissions[], onBehalfOfUserId? }`; readers are actors.

## 5. Provenance / freshness / confidence

- **Provenance**: `source_type` ∈ execution_result|review_decision|audit_entry|mission|mission_plan|checkpoint|
  human_input|agent_report|system; `source_id` mandatory; `recorded_by_*` = who wrote; `recorded_at` = server clock
  (caller cannot set it); `occurred_at` = when the event happened.
- **Freshness** (pure `freshnessOf(entry, now)` + SQL predicate): `expires_at <= now` → `expired` (never returned);
  `stale_after <= now` → `stale` (returned, tagged, ranked after fresh); else `fresh`. Defaults from `defaultFreshness`:
  mission memory never stale/expires (historical evidence); procedural stale 30 d / expires 180 d after
  `last_verified_at` (bumped by every new observation); business stale 180 d, no expiry.
- **Confidence**: value ∈ [0,1] + basis ∈ observed|derived|declared|validated. Policy (`assertConfidencePolicy`):
  `agent_report` can only be `declared`, max 0.7; `validated` requires a human/review source; system observations of
  `execution_result|review_decision|audit_entry` may be `observed`. Procedural confidence = smoothed
  `(success+1)/(total+2)` (`proceduralConfidence`), recomputed on every observation.

## 6. Retrieval strategy

Structured, scope-first, deterministic; **no embeddings in 7B** (pgvector + provider is a separate decision per
`icos-rag-memory`; the log/provenance shape is already vector-ready). Steps: tenant → scope filters → visibility →
freshness → status → order → `LIMIT` (default 10, max 50) → log. Orders:
mission = `occurred_at ASC, id ASC` (timeline); procedural = fresh before stale, `validated` before `candidate`,
`confidence DESC, last_observed_at DESC, id ASC`; business = `scope_key, subject_key`.
`stats` = `{eligible, returned, denied, expired, inactive}`.

## 7. File boundaries (vs 7A)

New only: `src/core/memory/**`, `src/server/memory/**`, `src/server/database/memory-schema.ts`,
`drizzle/0031_operational_memory.sql`, `docs/icos/phase-7b-memory/**`, `docs/icos/handoffs/PHASE-7B-MEMORY-INTEGRATION.md`.
Edited shared: `drizzle/meta/_journal.json` (append one entry — unavoidable, trivially mergeable).
NOT edited (patches documented in the handoff): `schema.ts`, `drizzle.config.ts`, `container.ts`,
`production-services.ts`, `mission/ports.ts`, `permissions.ts`.

## 8. Conflict risks with 7A

R1 migration number (7A's working tree already holds `0030_scheduled_jobs`, `when=1789700000000`) — mine is `0031`,
`when=1789800000000` (must stay > 7A's or Drizzle skips it). R2 `_journal.json` append conflict. R3 shared `icos_test`
DB: Drizzle applies by `when`; whoever migrates second on a shared DB can be silently skipped — 7B tests use a
dedicated DB (`ICOS_TEST_DATABASE_URL`). R4 no RLS. R5 `drizzle-kit generate` is unusable repo-wide
(snapshots stop at 0009), so the SQL is hand-written and verified by a schema-parity integration test.

## 9. As built — deviations from §1–§8

- Procedural memory is **derived by the system only** (`observe` rejects `agent`/`human` actors and non-objective
  sources). Free-form learnings from agents go to mission memory as `agent_report` (declared, confidence ≤ 0.7).
- Extra rule `assertSourceAllowed`: agents may cite only `agent_report`; system never `human_input`/`agent_report`;
  humans anything but `agent_report` — a writer cannot forge the provenance of another kind of writer.
- `validated_remediation` is created by `recordValidatedRemediation` (human + evidence), not by promoting a candidate;
  `validate()` promotes a candidate (any kind) and records `validated_source_type/id`.
- `RetrievalStats` = `{ matched, returned, denied, expired, inactive }`; the log row also stores, per returned entry,
  `entryId, rank, freshness, confidence, sourceType, sourceId`. Denied entries' content/ids are never logged.
- Retrieval fails closed: if the trace row cannot be written, the call throws and returns nothing.
- Known limitation: `business_memory_entries.decided_by/at` holds the **last** human decision (approve, then possibly
  retract/reject); earlier decisions are recoverable from the version chain and the retrieval log, not stored separately.
- No RLS (see R4) and no embeddings: retrieval is structured SQL. `learned_patterns` rows are not migrated.
