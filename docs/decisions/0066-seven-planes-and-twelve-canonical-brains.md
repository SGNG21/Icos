# 0066 — Seven planes, and twelve canonical brains that are rows, not processes

- Status: accepted
- Date: 2026-10-02
- Lane: `feat/big-autonomy-ui-self-improve`
- Supersedes: nothing. Extends 0057 (digital workforce), 0064 (compute fleet), 0065 (admission-time policy).

## Numbering hazard (read before integrating)

Central owned `..0064` when this lane was cut. The chief-supervisor lane claims `0065`. This
document claims `0066`. Parallel lanes in this repository have silently collided on decision
numbers before: differing filenames mean git merges both copies with no conflict and no
warning. The central integration owner MUST re-check this number at integration time and
renumber this file if `0066` was taken meanwhile. Nothing in the code references the number.

## Context

The owner's target is one sentence: he types work into the ICOS interface, ICOS executes it,
and he receives the result in the interface. The headline case is `"Améliore ICOS."` — a
bounded self-improvement objective. The risk in building toward that is not difficulty, it is
duplication: every plane of this architecture already has an owner, and a second owner for any
of them would be worse than the missing feature.

## Decision 1 — the architecture normalizes to seven planes, each with exactly one authority

| Plane | Authority | Owns |
|---|---|---|
| 1 Experience | Cockpit / UI | supervision, intake, result presentation |
| 2 Cognitive | Cognitive Runtime | conversation, intent, context, memory, goal intake |
| 3 Governance | Chief Supervisor + Policy | objective-level admission, priority, portfolio, permission, approval |
| 4 CORE3 Execution | CORE3 | mission/task execution, leases, retries, durable execution |
| 5 Digital Workforce | Workforce | brains, roles, capabilities, delegation |
| 6 OmniRoute Compute | OmniRoute | model/provider routing, and the spend meter on its seam |
| 7 Governed Action | Tool Gateway | governed external actions |

Postgres is durable truth under all seven. No plane may be given a second implementation of
another plane's authority. In particular: no new scheduler while the existing scheduler can be
extended, no parallel mission authority, no duplicated review or recovery authority, and no
persisted objective lifecycle where it can be derived deterministically (0065).

## Decision 2 — BRAIN != WORKER != MODEL != PROVIDER

These four are never collapsed:

- **Brain** — a persistent cognitive *role*. A durable logical identity. A row.
- **Worker** — a temporary *execution instance*, created per mission and discarded.
- **Model** — an inference engine.
- **Provider** — a compute endpoint serving models.

Consequence, and the point of this decision: the twelve brains **must not** be twelve
permanently-running expensive model processes. Execution instances are ephemeral and elastic.
Twelve durable brains fan out to N missions, N tasks, N ephemeral workers and, through
OmniRoute, potentially dozens of parallel model paths. A "pool of N Nemotron lines" is
**compute capacity**, never N cognitive authorities.

## Decision 3 — the twelve brains are seeded onto the existing workforce schema. No new schema.

The twelve canonical brains are Chief, Planner, Architect, Builder, Reviewer, Recovery,
Research, Business, Delivery, Growth, Memory, Evolution.

Every field the brains must expose already has a home in `src/core/workforce/contracts.ts`.
This was verified field by field against the existing schema before any code was written:

| Required brain field | Existing home |
|---|---|
| `brainId` | `workforceAgentSchema.agentId`, with `kind: "DURABLE_AGENT"` |
| `role` | `roleId` + `roleVersion` |
| `capabilities` | the role's `skills` -> each skill's `capabilities` (never restated on the agent) |
| `authority` | `policy.autonomyLevel`, ceilinged by the role's `autonomyCeiling` |
| `allowedTools` | `policy.toolGrants` (the skill's `requiredTools` is a NEED, not a grant) |
| `memoryScope` | `memoryScope` |
| `budgetPolicy` | `policy.budget { computeUnits, financialCents }` |
| `concurrencyPolicy` | `policy.bounds { maxDepth, maxDescendants, maxConcurrentAssignments }` |
| `status` | `status` |
| `preferredModels` / `fallbackModels` | `compute.modelHints`, ORDERED, preferred first |
| `reviewPolicy` | the existing `never \| if_risky \| always` vocabulary |

Therefore `workforce_agents = 0` in the live database is **not a defect**. It is
"registry not seeded", and seeded-ness was deliberate: `bootstrap.ts` states in its own header
that templates "seed a registry; nothing here creates an agent or grants a tool". Roles ship
as `draft` and are certified and human-activated. The brains were simply never created.

### The 0057 reconciliation

Decision 0057 states organisational identity is **never** bound to a model. The new target asks
each brain to expose `preferredModels` and `fallbackModels`. These are reconciled, not traded
off: model preference is recorded **only** as the existing non-binding `compute.modelHints`,
ordered by preference. It is a routing *hint* consumed by OmniRoute. It is never identity and
never a gate. OmniRoute keeps sole authority over which model actually runs.

## Decision 4 — budget is enforced at one seam: the OmniRoute fetch boundary

A live preflight confirmed the defect: `goals.budget` is persisted
(`schema.ts`, `goals.budget`, doublePrecision) and never enforced. There is no price source, no
usage accumulator and no enforcement point. Separately, OmniRoute already returns token usage on
every completion and ICOS discards it — `grep -rn 'prompt_tokens' src` matches exactly one
unrelated file.

There are five OmniRoute completion call sites (`cognition.ts`, the autonomous mission planner,
the reviewer, `compute-fleet.ts`, the CEO client). Every one of them takes an injectable
`fetchImpl: typeof fetch` defaulting to global fetch.

Decision: enforcement is **one decorator of shape `typeof fetch`**, installed where those
adapters are constructed. Not five meters, and not a sixth OmniRoute client. The same seam
carries the per-mission model allowlist, so one mechanism serves two policies.

Enforcement is fail-closed, and the following are invariants, not preferences:

- a model absent from the price table is `UNPRICED` — never priced at zero, never defaulted;
- an `UNPRICED` call is not free: it still consumes the token budget and is reported;
- a money cap with any `UNPRICED` usage in its window **denies**, because an unpriced total
  cannot be proven to sit under a money cap;
- a token cap is always enforceable and must work with no price table at all;
- a response with no parseable usage (streaming) records `UNMETERED` truthfully, never `0`;
- metering reads usage from `response.clone()` and never consumes the caller's body.

**If a hard monetary cap is not demonstrably enforceable, ICOS does not claim it is.** A
token cap plus a bounded model allowlist is the honest fallback, and is what gates the first
autonomous mission.

## Decision 5 — bounds may only ever narrow

`autonomous_mission_runtime` already stores `max_cycles`, `max_replans`, `max_runtime_ms` and
`max_stagnation_cycles` per mission with CHECK constraints, and `startAutonomousMission` already
accepts injectable options. The gap was never storage: nothing carried a caller's requested
bounds into those options, and nothing clamped them.

A request may only narrow. A request to widen past the policy ceiling is clamped **and the
clamp is reported** — never silently granted. A resume may not widen a persisted bound. This is
the same invariant as "ICOS may never grant itself new permissions", applied to budgets.

## Decision 6 — what ICOS may never do autonomously

ICOS may improve code, tests, architecture, prompts, routing, observability, performance,
memory/retrieval and workflows. ICOS may **not** autonomously grant itself new permissions,
disable Policy, bypass approvals, modify credentials, weaken auth or security, deploy
irreversible changes, spend beyond policy, declare its own review independent, or merge changes
that fail gates. The Evolution brain therefore holds no deployment, credential or
permission-changing tool grant, and no autonomy level above Builder.

## Consequences

- The twelve-brain registry costs no migration and no new table. It is data plus validation.
- Budget and model restriction share a single enforcement point, so there is one place to audit.
- `workforce_agents = 0` is reclassified from "defect" to "not seeded", which changes the fix
  from integration work to seed data.
- An unpriced model can block a money-capped mission. That is intended: it is the only honest
  behaviour, and the owner was explicit that a cap must not be claimed unless it is real.
