# 0055: ICOS notices things — and noticing is not authority

## Status

Accepted (foundation). Integration with Tool Gateway, Cognitive Runtime/Memory, Digital
Workforce and cockpit delivery is by port; those lanes are `NOT_CONNECTED` today.

## Context

Every piece of ICOS work so far started with a human sentence or a scheduled job a human
enqueued. Nothing turned "the contact form has been failing for an hour" or "invoice INV-7
is 30 days overdue" into work. The target is:

observation → event → relevance → situation → policy → goal proposal → CORE3 → workforce →
execution → evaluation → memory/audit

and the risk is obvious: a loop that creates work from its own observations can flood,
duplicate, reopen finished work, or quietly grant itself authority.

### Audit (phase 0) — what already existed and was reused

| Need                               | Canonical owner reused                                                                                                   | Not rebuilt                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Recurring / delayed observation    | `scheduled_jobs` + `DurableScheduler` (ADR-0025), grid-aligned self-perpetuating recurrence + idempotent ignition (0037) | no second scheduler, no `setInterval`                            |
| Goal creation                      | CORE3 intake: `GoalNormalizer → GoalPlanner → GoalPreviewStore` (same components as `POST /api/goals`) → a PENDING goal  | the supervisor never converts a goal into a mission              |
| Mission stuck                      | runtime recovery (ADR-0027, 0039)                                                                                        | supervisor records/notifies, rule `owner: runtime-recovery`      |
| Provider rate-limit / worker crash | compute routing (0054) reads `dispatch_attempts.failure_class`                                                           | supervisor observes the same rows, rule `owner: compute-routing` |
| Worker/model choice                | worker eligibility + compute routing                                                                                     | proposals carry CAPABILITIES only                                |
| Tenant                             | `tenant_id NOT NULL` convention + `CURRENT_SINGLE_TENANT_ID` shim                                                        | —                                                                |
| Append-only evidence               | trigger pattern of `audit_entries` (0001)                                                                                | —                                                                |

Absent before this decision: an event model, situations, attention classes, an
initiative policy, any path from an observation to a goal.

## Decision

### 1. One event shape, one ingestion path

`SupervisorEvent` (`src/core/supervisor/contracts.ts`): tenant, source, origin
(`push|poll|internal|scheduled`), UPPER_SNAKE type, subject, occurredAt/observedAt,
payloadRef (a pointer, never the payload), small summary, dedupKey, correlationId,
project/client scope, sensitivity, confidence. **`.strict()`**: an event cannot carry
a level, an approval or an "autonomous" flag, and the policy never reads `summary`.

`ProactiveSupervisor.ingest` is the only path for all four origins. Event TYPES are open
strings; business meaning is in `RelevanceRule` data (`defaults.ts`), never a code path.

### 2. Decision = pure function, bounded by durable rules

`assess()` (`src/core/supervisor/policy.ts`) — relevance → novelty → policy →
actionability → disposition (`IGNORE | RECORD_ONLY | NOTIFY | PROPOSE_ACTION |
CREATE_BOUNDED_GOAL | ESCALATE_HUMAN`):

- no rule ⇒ IGNORE: an event row, nothing else;
- subject terminal (e.g. `mission:<id>` succeeded/failed/cancelled) ⇒ RECORD_ONLY;
- policy `UNKNOWN` ⇒ RECORD_ONLY (**fail closed**: no attention, no proposal);
- a rule owned by another runtime, or confidence < 0.5, is capped at NOTIFY;
- EXECUTE levels are bounded twice: a **risk ceiling** (LOW_RISK ⇒ read-only,
  BOUNDED ⇒ reversible; sensitive ⇒ always ESCALATE_HUMAN) and an **hourly execution
  budget** per (tenant, domain, action). Exceeding either downgrades to PROPOSE_ACTION.

A model may later suggest a classification. It can only feed `confidence`; it cannot
raise what executes.

### 3. Initiative policy: per domain/action/client/project, never a global flag

Levels `OBSERVE < NOTIFY < PROPOSE < EXECUTE_LOW_RISK < EXECUTE_BOUNDED`, plus
`HUMAN_REQUIRED`. Most specific rule wins; a tie goes to the MORE restrictive level.
`humanRequiredDomains` clamps a domain whatever any rule says. The supervisor holds a
deep-frozen private copy of the policy: it has no setter, and mutating the object it was
given changes nothing. Defaults never execute (highest default = PROPOSE; security =
HUMAN_REQUIRED).

### 4. Deduplication and flood control are database invariants

- `UNIQUE (tenant_id, source, dedup_key)` on `supervisor_events`: a replayed
  observation is the same event.
- partial `UNIQUE (tenant_id, fingerprint) WHERE state='open'`: one open situation per
  fingerprint = (client scope, project scope, domain, type, subject | source-namespaced
  correlationId) — 100 identical alerts are one incident with `event_count = 100`. Every
  scope policy resolves on is in the fingerprint, so an event can never aggregate into a
  situation — and inherit a proposal — under another scope's authority.
- `UNIQUE (situation_id)` on proposals: one proposal per situation.
- `UNIQUE (situation_id, attention_class)` on attention, and a new class is raised only
  when it is HIGHER than the situation's `max_attention`.
- cap on new situations per (tenant, DOMAIN) per hour; beyond it events are recorded,
  not acted on. HUMAN_REQUIRED domains and critical severity are exempt, so routine noise
  can never silence a security alert.
- ingestion runs in ONE transaction under a per-tenant advisory lock, so flood caps and
  budgets are exact across processes (proven with two connection pools).

### 5. Situations never reopen

`open → resolved | dismissed`, terminal is final (`closeSituation` only updates
`state='open'`, and cancels the situation's undelivered/awaiting proposal in the same
transaction). An open situation silent for `staleAfterMs` (default 24 h) is closed as
`dismissed` by `supervisor:stale` when the next occurrence arrives, and that occurrence
opens a NEW incident (fresh attention) — nothing aggregates silently forever. A same-fingerprint event within `reopenCooldownMs` after closure is
RECORD_ONLY; after it, a NEW situation is opened and the old one stays closed.

### 6. Goal proposals go through CORE3, side effects through an outbox

`GoalProposal` (`.strict()`): source event, reason, desired outcome, constraints, urgency,
risk, scope, evidence (event ids, policy version, reasons), requested capabilities — no
agent, worker or model field.

- PROPOSE_ACTION / ESCALATE_HUMAN ⇒ state `awaiting_human`. The database CHECK forbids
  such a row from ever being `pending`, so nothing can auto-send it.
- CREATE_BOUNDED_GOAL ⇒ `pending`, drained AFTER commit: route `goal` →
  `CanonicalGoalIntake` (pending CORE3 goal, `humanApprovalPolicy: always` unless
  read-only, metadata carries proposal/situation/source-event ids); route `tool_action`
  → `ToolGatewayActionPort` (`NOT_CONNECTED` until that lane lands).
- Delivery is an outbox: rows are claimed (`FOR UPDATE SKIP LOCKED` + 5-min lease), so
  concurrent drains never deliver one row twice; each row is isolated (a throwing port
  fails THAT row, retried up to 5 times, then `failed`); only bounded goals of OPEN
  situations are claimable. A crash between commit and delivery loses nothing. Submission
  is replay-safe (goal id derived from proposal id; `requestId` is the Tool Gateway
  idempotency key). Policy provenance (level, version) is kept in goal metadata.

### 7. Attention

`INFO` (cockpit only) · `ACTIONABLE` (cockpit + notification) · `URGENT` (same) ·
`CRITICAL` (+ future voice). Pending human decisions are never quieter than ACTIONABLE.
Delivery is a port; rows settle `not_connected` until cockpit/notification integrate.

### 8. Ports to other lanes

- Cognitive Runtime: `digest(tenant, {since, until, clientScope})` answers "what
  happened overnight?" from durable situations/events/proposals only.
- Cognitive Memory: `EpisodeSink` receives `proposal_settled` and `situation_closed`
  episodes only — never raw events.
- Digital Workforce: requested capabilities in the proposal → CORE3 goal
  `allowedCapabilities` → existing worker eligibility. OmniRoute keeps compute.
- Tool Gateway: `ToolGatewayActionPort`. The supervisor module imports no connector
  (architecture test).

### 9. Scheduling

New job kind `supervisor_observe` (migration 0049 widens the allow-list). Occurrences on
the shared grid, keyed by instant; the handler enqueues its successor FIRST, then observes
→ ingests → drains. A failing source fails only its own occurrence; a malformed
observation is rejected alone; a drain failure is reported, never stops observing. Interval floor 60 s. Production ignites
one observation, `compute-health` (failed `dispatch_attempts` with `RATE_LIMITED` /
`WORKER_CRASHED`, every 15 min), which by default only records/notifies.

## Independent review

An independent architecture/safety review (APPROVE_WITH_FIXES) found no path from a
PROPOSE/ESCALATE/HUMAN_REQUIRED/UNKNOWN decision to an automatic effect, and raised four
MAJOR findings, all fixed with regression proofs R1–R8: scope-borrowing through
aggregation/correlationId; tenant-wide flood cap letting noise starve security alerts;
one failing delivery blocking all others and able to kill the observation chain;
situations never closing in production (now stale-closed). Minor fixes: cancel on close,
claimed delivery, DENIED attention recorded as such, low-confidence escalation does not
page, HUMAN_REQUIRED rules clamp their scope, duplicate rules refused, subject status
read outside the tenant lock, clock read after the lock, unambiguous fingerprint encoding.

## Consequences

- Migration `0049_proactive_supervisor` — additive, rollback in the file header.
- `src/core/supervisor/*` (pure), `src/server/proactive/*` (store, service, adapters,
  observations, composition).
- Known limits:
  - per-tenant advisory lock serializes a tenant's ingestion (`ponytail:` note);
  - no webhook HTTP endpoint: push sources need per-source signature verification, which
    belongs to the connector/Tool Gateway lane — `ingest({origin:"push"})` is the entry;
  - no human surface yet to act on `awaiting_human` proposals or close situations
    (cockpit lane); the digest is the read port;
  - `not_connected` proposals are not retried when a lane connects (a late action is
    worse than none — a human re-triggers);
  - policy and rules are reviewed code data, not yet an owner-editable durable record;
  - `dispatch_attempts` has no tenant column: compute-health is stamped with the
    single-tenant shim, and the drain is global — both must be revisited with COMPLIANCE-1;
  - compute-health reads at most 500 failures per 30-min window;
  - deploy order: migration 0049 before code (ignition fails closed otherwise); an old
    replica without the handler that claims a `supervisor_observe` job kills that
    occurrence — the next boot re-ignites;
  - the `awaiting_human`/`open`-only claim filters are defence in depth behind the DB
    CHECK and cancel-on-close; no API path reaches them, so no test can.

## Evidence

Safety proofs P1–P14 and business examples A–E run as ONE contract against the in-memory
store and real PostgreSQL (`proactive-supervisor.contract.ts`), plus PostgreSQL-only
proofs: append-only ledger, DB refusal of an auto-sendable non-bounded proposal,
cross-process dedup/flood/budget exactness, CORE3 pending goal with replay, crash-after-
commit recovery, scheduled observation surviving a restart, compute-health observation
from real `dispatch_attempts`. 23 guard mutations: 21 killed by the suite, 2 survive by
design (the defence-in-depth filters above).
