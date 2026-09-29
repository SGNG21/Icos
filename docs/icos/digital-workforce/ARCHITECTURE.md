# Digital Workforce / Mini-ICOS — architecture (lane D)

Baseline: `e652469` on `feat/digital-workforce`. Decision: [0056](../../decisions/0056-digital-workforce-foundation.md).

## 1. Phase 0 audit — what already exists and is reused

| Concern                                          | Existing abstraction (committed)                                                                     | Workforce use                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent identity + autonomy                        | `core/contracts/agent.ts` `authorizationLevel` 0–3; `core/authorization/decide.ts` `decideExecution` | **Autonomy level IS `AuthorizationLevel`.** No second scale. Action execution stays with `decideExecution` (sensitive ⇒ human approval, always).                                                                                      |
| Capability registry                              | `core/contracts/capability.ts` (C1), key regex `capabilityKeySchema`, lifecycle                      | Skill capabilities are capability keys (same regex). A capability row "confers no execution authorization" — same rule here.                                                                                                          |
| Skill packages                                   | `core/contracts/skill.ts` (C2): trust/activation state, scripts, provenance, scans                   | NOT replaced. A C2 skill is an _executable package_; a workforce skill is a _competence spec_ (capabilities, risk, evidence, gates). `implementedBy` links a spec to C2 skill keys.                                                   |
| Worker registry                                  | `worker-registry.ts` + `WorkerRegistryStore` (0031/0032)                                             | **No new worker registry.** An `EXECUTION_WORKER` agent references a registry entry by `workerId`.                                                                                                                                    |
| Worker eligibility / compute routing (OmniRoute) | `core/workers/worker-eligibility.ts` + `compute-routing.ts` (0031–0054), `CapabilityRouter`          | **Not duplicated.** Workforce emits a `WorkforceComputeRequest` (worker capabilities + complexity + risk, never a model); `toWorkerRequirement` maps it onto the canonical `WorkerRequirement`. Model hints are non-binding metadata. |
| Human permissions                                | `core/identity/permissions.ts` (`agents.manage`, `cockpit.read`)                                     | Every policy/structure write requires a **human** principal holding `agents.manage`. Not modified (protected path).                                                                                                                   |
| Tenant                                           | `core/identity/tenant.ts` `CURRENT_SINGLE_TENANT_ID` shim                                            | `tenantId` mandatory on every record and every store call.                                                                                                                                                                            |
| Tools                                            | `tool-definition.ts`, `tool-gateway.ts` (conceptual)                                                 | `ToolGrant.toolId` names a tool; grants are separate from roles/skills. Tool _invocation_ stays with the gateway (NOT_CONNECTED here).                                                                                                |
| Memory / context                                 | `core/memory/contracts.ts` (`MemoryActor`, visibility), `core/context`                               | `MemoryScope` = namespaces an agent may read/write; enforcement stays with the memory layer (lane C).                                                                                                                                 |
| Audit                                            | `audit_entries` append-only (0001)                                                                   | Workforce keeps its own append-only `workforce_events` journal (same trigger technique) to avoid widening the shared `audit_event_type_check` constraint that other lanes also change.                                                |
| Missions / tasks                                 | `core/mission`, `contracts/task.ts` `riskClass`                                                      | Assignments carry `missionId`/`taskId` lineage; they do not create or dispatch mission tasks (lane A).                                                                                                                                |
| Scheduler / approvals                            | `scheduler.ts`, `approval.ts`                                                                        | Not touched. `REQUIRE_APPROVAL` verdicts are returned for the approval flow to consume.                                                                                                                                               |

## 2. Hierarchy and concepts

```
Human owner ─(agents.manage)─▶ ICOS Central (DURABLE_AGENT, depth 0, root)
  └─ Department (data) ─ supervisor: DURABLE_AGENT (Mini-ICOS)
       └─ EPHEMERAL_SPECIALIST (missionId + expiresAt)
            └─ EXECUTION_WORKER (workerId → worker registry) ─▶ tools / models via OmniRoute
```

| Concept                  | Where                         | Notes                                                                                                                                                               |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SkillDefinition`        | `core/workforce/contracts.ts` | versioned, capabilities, inputs/outputs, required tools, risk, required permissions, approval, evidence, tests, quality gates, compatible agent kinds, compute need |
| `AgentRole`              | idem                          | skills + responsibilities + KPIs + `autonomyCeiling`; **no tool field**                                                                                             |
| `Department`             | idem                          | data-driven tree (`parentDepartmentId`)                                                                                                                             |
| `WorkforceAgent`         | idem                          | kind, role, supervisor, parent (spawn lineage), depth, scope, memory scope, `AgentPolicy`, objectives, KPIs                                                         |
| `AgentPolicy`            | idem                          | autonomy level, tool grants, budget, spawn/concurrency bounds                                                                                                       |
| `ToolGrant`              | idem                          | always carries a **human** `grantedBy`; `delegatedBy` when passed down                                                                                              |
| `ComputeNeed`            | idem                          | reasoning depth + worker capabilities + non-binding model hints                                                                                                     |
| `WorkAssignment`         | idem                          | mission/task/parent lineage, supervisor, assignee, execution (worker, model, provider, REAL/SIMULATED/NOT_CONNECTED), review, evidence                              |
| `PerformanceObservation` | idem                          | append-only facts; summarised transparently                                                                                                                         |

"Active missions" and "historical performance" of a Mini-ICOS are **derived** from assignments and observations, never stored twice.

## 3. Governance invariants (pure, `core/workforce/governance.ts`)

- Only a human principal with `agents.manage` changes structure or policy. An agent never changes its own (or anyone's) autonomy or grants.
- A child is within its supervisor at creation: autonomy ≤, grants ⊆ (unexpired), budget ≤, bounds ≤, client/project scope ⊆, memory namespaces ⊆. The **policy** part (autonomy, grants, budget, bounds) is re-checked at every assignment, so narrowing a parent's policy narrows its subtree; scope and memory narrowing do not yet cascade (known gap).
- Autonomy ≤ role `autonomyCeiling`. Role and skill never imply a grant: assignment is refused `MISSING_TOOL_GRANT` if the skill needs a tool the assignee was not granted.
- Spawning: DURABLE → EPHEMERAL/EXECUTION; EPHEMERAL → EXECUTION; EXECUTION → nothing. An agent can never spawn a DURABLE agent. Bounded by depth, descendants, org max agents; ephemeral needs `missionId` + `expiresAt` not after its parent's.
- Assignment: active assignee under an active supervisor, capability covered, kind compatible, tools granted, scope held, concurrency and compute budget (derived from assignments, never a counter).
- `blocked` agent and `blocked` assignment are terminal (pure transition table **and** a PostgreSQL trigger).

## 4. Flows

- **Dynamic role** (`role-composer.ts`): need → capabilities (decomposer port; LLM side NOT_CONNECTED, caller passes capabilities) → greedy skill cover → reuse existing active role if it covers → draft (no grants) → policy validation → certification by someone other than the creator (human if HIGH/CRITICAL) with every skill test passed → activation by a human.
- **Delegation** (`delegation.ts`): mission capabilities → plan over the supervisor's subtree (deterministic) with explicit gaps → governed assignment → execution record (worker identity mandatory) → independent review (reviewer ≠ assignee, ≠ the agent standing for the worker, holds `independent_review`, covers the work's client scope) → accept / changes requested / BLOCK → supervisor synthesis once every child is terminal.
- **Performance** (`performance.ts`): observation per review; `summarizePerformance` returns counts/rates plus the observation ids used. No opaque score; simulated facts excluded by default.

## 5. Persistence

`drizzle/0050_digital_workforce.sql`, `server/database/workforce-schema.ts` (separate file, like `memory-schema.ts`).
Tenant key `tenant_id` on every table, part of every PK/FK, predicate on every query. **RLS: not enabled** — ICOS has no RLS today and no runtime TenantContext (COMPLIANCE-1); isolation is the application predicate, proven by integration test. Events and observations are append-only (trigger `IC002`). Terminal statuses are enforced by trigger `IC003`.

## 6. Status

REAL: domain, governance, composer, delegation, performance, in-memory + PostgreSQL stores, governed service, bootstrap templates.
NOT_CONNECTED: container/HTTP wiring, OmniRoute dispatch (lane A), memory enforcement (lane C), cockpit views (lane B), LLM capability decomposer, tool gateway invocation.
