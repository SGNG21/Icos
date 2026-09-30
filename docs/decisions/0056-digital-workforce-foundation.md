# 0056: Digital workforce foundation — Mini-ICOS, roles, skills and governed delegation

## Status

Accepted (lane D, `feat/digital-workforce`, baseline `e652469`). Number chosen to avoid 0055
(already used by the tool-gateway and voice lanes); renumber at integration if needed.

## Context

ICOS Central must build, organise and supervise a digital workforce — durable specialised
Mini-ICOS agents, ephemeral specialists and execution workers — without a fixed list of bots,
without binding organisational identity to a model, and without a second worker registry or
router. The audit (`docs/icos/digital-workforce/ARCHITECTURE.md` §1) found reusable
authorities: `AuthorizationLevel` + `decideExecution`, capability keys (C1), executable skill
packages (C2), the worker registry and the canonical CapabilityRouter / compute routing
(0031–0054), human permissions (`agents.manage`, `approvals.decide`, `cockpit.read`) and the
append-only journal technique.

## Decision

1. **Three agent kinds**: `DURABLE_AGENT` (Mini-ICOS: identity, context, history),
   `EPHEMERAL_SPECIALIST` (bound to a mission and an expiry), `EXECUTION_WORKER` (stands for a
   worker-registry entry by `workerId`; no second registry).
2. **Skills are competence specs, roles compose skills, neither grants anything.** A
   `SkillDefinition` declares capabilities, I/O, required tools, risk, permission needs,
   approval classes, evidence, tests, quality gates, compatible kinds and a compute need. A
   role has no tool field. Tools come only from `ToolGrant`s, each carrying a human
   `grantedBy`; a pass-down records `delegatedBy` and must match a live grant the parent holds.
   Assignment is refused `MISSING_TOOL_GRANT` when the skill needs an ungranted tool.
3. **One autonomy scale.** Autonomy is the existing `AuthorizationLevel`; a role's
   `autonomyCeiling` is bounded by its riskiest skill (LOW 3, MEDIUM/HIGH 2, CRITICAL 1).
   Only a human with `agents.manage` changes policy; no agent changes its own or anyone's.
4. **Containment**: a child's policy, client/project scope and memory namespaces are within
   its supervisor's at creation; the policy part is re-checked at every assignment, so narrowing a
   parent's policy narrows its subtree (scope/memory narrowing cascades through the tool-grant and memory ports, see addendum). Spawning is DURABLE → EPHEMERAL/EXECUTION, EPHEMERAL → EXECUTION, EXECUTION → none;
   agents never create durable agents. Bounded by absolute depth, active descendants,
   organisation max agents, concurrent assignments and compute budget — the last two derived
   from assignments, never counters.
5. **Dynamic roles**: need → capabilities (model-side `CapabilityDecomposer` port,
   NOT_CONNECTED) → deterministic skill cover → reuse an existing role or draft one → policy
   validation → certification by someone other than the creator (a human for HIGH/CRITICAL),
   every skill test passed → activation by a human. Uncovered capabilities are reported, never
   invented. Bootstrap templates (25 skills, 24 roles, 10 departments) are JSON data that ship
   as drafts and go through the same path.
6. **Governed delegation**: supervisor → plan over direct reports (deterministic: open load,
   then id; every rejection with its violations) → assignment with mission/task/parent
   lineage and a permissions snapshot → human approval where the skill gates the action class
   → execution record naming the worker (mandatory) and model/provider with a REAL /
   SIMULATED / NOT_CONNECTED source → independent review (not the assignee, not the agent
   standing for the worker, holding `independent_review`, covering the work's scope) →
   supervisor synthesis once every child is accepted or blocked.
7. **Compute**: the workforce requests `workerCapabilities` + `complexity` (+ task risk) and
   maps them onto the canonical `WorkerRequirement`; model names exist only as non-binding
   hints. OmniRoute / the CapabilityRouter chooses the worker and model.
8. **Performance**: one observation per review (agent, role, skill, task type, success,
   review outcome, corrections, latency, cost, failure class, model key, source).
   `summarizePerformance` returns plain aggregates plus the observation ids used; unknown stays
   null; non-REAL facts are excluded by default. No opaque ranking.
9. **Durability**: migration `0050_digital_workforce` — seven tenant-keyed tables (tenant in
   every PK/FK), append-only events and observations (IC002), terminal `blocked`/`retired`
   agents and `blocked`/`synthesized` assignments (IC003), CAS on versions, and a per-tenant
   advisory lock on every workforce transaction. One governed `WorkforceService`; a refusal
   writes only a `governance.denied` event.
10. **BLOCK is terminal** in the pure transition tables, in the service and in the database.

## Consequences

- Not wired into `container.ts`, HTTP routes or the cockpit (conflict avoidance with lanes A/B):
  NOT_CONNECTED. Composing `WorkforceService` in the container, principal construction from the session,
  and `system` principal issuance for the execution fabric are integration work.
- The Tool Gateway lane should consult live `ToolGrant`s before invoking a tool for an agent;
  the Memory lane should enforce `MemoryScope`; CORE3 dispatch should consume
  `computeRequestFor` and report execution facts through `recordExecution`.
- No RLS (none in ICOS yet); isolation is the composite keys plus the application predicate.
- Expired ephemeral agents are inactive by derivation but keep `status = active` until a
  sweeper retires them (not implemented).
- Per-tenant lock serialises all workforce writes of a tenant; acceptable at foundation scale.

## Rollback

Revert the code; migration 0050's header carries the DROP statements (workforce data only).

## Integration addendum (2026-09-30)

- **Principals** are issued by one `PrincipalAuthority` (frozen, WeakSet-registered). Humans come
  from `AuthenticatedSession` through the existing `AuthorizationService`, the system from a
  closed list of runtime components, agents only via a system principal. Nothing else is
  accepted. Tenant = explicit single-tenant shim.
- **Effective authority** (`core/workforce/authority.ts`) is evaluated over the whole supervision
  chain as it is now. Tool grants and memory scopes narrowed, revoked or suspended anywhere
  above an agent take effect at the next check (tool-grant and memory ports). Assignment still
  checks the assignee's own scope plus policy containment against its direct supervisor.
- **Tool grants** carry explicit `actions`. The Tool Gateway authorises only on the conjunction of
  its own exact grant and the workforce answer (see INTEGRATION.md §4).
- **Execution evidence** separates `selected` from `effective` compute. It refuses an effective
  model for an unsteered run. A failed execution is recorded (failure class, observation) and
  returns the work for another attempt.
- **Composition**: `createWorkforceRuntime` builds service, read model, compute port and
  authority port on one store and one authority. See `docs/icos/digital-workforce/INTEGRATION.md`,
  including the migration and decision collision manifest.
