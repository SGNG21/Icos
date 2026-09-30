# Digital Workforce — integration handoff (lane D)

Branch `feat/digital-workforce`. Decision [0057](../../decisions/0057-digital-workforce-foundation.md).
Everything below is REAL and tested unless marked NOT_CONNECTED.

## 1. Composition (what the integrator wires)

```ts
import { createWorkforceRuntime, createWorkforceStore } from "@/server/workforce/composition";

const workforce = createWorkforceRuntime({
  store: createWorkforceStore(
    persistence === "postgres" ? { kind: "postgres", db } : { kind: "memory" },
  ),
});
// routes / server components : workforce.service, workforce.readModel, workforce.sessions
// CORE3 dispatch             : workforce.compute   + workforce.runtime.system("core3-dispatch")
// Tool Gateway               : workforce.authority + workforce.runtime.system("tool-gateway")
// Cognitive Runtime          : workforce.authority + workforce.runtime.system("cognitive-runtime")
// Bootstrap CLI              : workforce.runtime.system("workforce-bootstrap") is NOT an admin:
//                              seeding needs a human session holding agents.manage.
```

- `workforce.runtime` must never reach a route handler; routes only get `sessions.fromSession`.
- `container.ts` was not edited (cross-lane conflict). No new dependency.

## 2. Principal boundary

| Source                                          | Factory                               | Result                                                                                                                |
| ----------------------------------------------- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `AuthenticatedSession` (after `requireSession`) | `sessions.fromSession`                | human; `id` = user id; permissions = the existing `AuthorizationService.can` over `PERMISSIONS`; disabled user ⇒ none |
| trusted in-process component (closed list)      | `runtime.system(component)`           | system                                                                                                                |
| system principal vouching for an agent          | `runtime.actAsAgent(system, agentId)` | agent                                                                                                                 |

- Every principal is frozen and registered in a private `WeakSet` of ONE authority. The service,
  the ports and the read model accept only principals that authority issued. Literals, JSON copies,
  spread copies and principals from another authority are refused (`UntrustedPrincipalError`, no
  event written because their tenant is untrusted).
- Tenant: explicit single-tenant shim `CURRENT_SINGLE_TENANT_ID`. No multi-tenancy is simulated;
  replace in COMPLIANCE-1.
- Client/project scope for humans: `AuthenticatedSession` has none, so none is retained. Agents
  carry theirs in their own record.

## 3. CORE3 compute port — `workforce.compute` (CORE3 not modified)

| Call                                              | Contract                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestFor(system, assignmentId, { taskRisk? })` | `{ missionId, taskId, assignmentId, agent, skillId, requiredCapabilities, compute: { workerCapabilities, complexity, risk?, modelHints }, workerRequirement: { requiredCapabilities }, approval: { required, satisfied } }`. No model field. `approval.satisfied === false` ⇒ CORE3 must not dispatch.                                    |
| `recordExecution(system, assignmentId, evidence)` | `evidence = { workerId, requestedCapabilities?, selected?: {modelKey, provider}, effective?: {modelKey, provider}, modelSteered?, result: succeeded\|failed, failureClass (required if failed), source: REAL\|SIMULATED\|NOT_CONNECTED, startedAt, finishedAt, evidence[], costCents?, tokens?, review?: { reviewerWorkerId, outcome } }` |

- `selected` is what the router chose. `effective` is what the runtime reports actually ran. With
  `modelSteered: false` (0054: the CLI default model ran) an `effective.modelKey` is refused. The
  workforce never copies `selected` into `effective`.
- `failed` returns the assignment to `assigned` (another attempt) and records an observation
  with the failure class. `succeeded` goes to review. A reported CORE3 review is applied at once;
  the reviewing worker must differ from the executing worker.
- For an `EXECUTION_WORKER` agent the evidence must name its registered `workerId`
  (`WORKER_MISMATCH` otherwise). Other kinds may run on any routed worker, which is recorded.
- Mapping to the canonical router: `workerRequirement.requiredCapabilities` → `WorkerRequirement`;
  `compute.complexity` / `compute.risk` → `ComputeRequirement.complexity` / `.risk`.

## 4. Tool grant port — `workforce.authority.checkToolGrant`

`checkToolGrant(system, { agentId, toolId, action, clientId?, projectId?, missionId? })` →
`{ granted, reasons[], grant?: { toolId, actions, grantedBy, delegatedBy?, expiresAt? }, chainVersion, evaluatedAt }`.

- Consults only live grants. It never looks at the role or the skill.
- Each link of the supervision chain is re-contained for that tool. A grant revoked from any
  ancestor makes the answer `TOOL_NOT_HELD_BY_PARENT` at the next call.
- Refused when an ancestor is blocked or suspended (`ANCESTOR_NOT_ACTIVE`), for another client or
  project (`SCOPE_ESCAPE`), or for another mission when the agent is mission-bound
  (`MISSION_MISMATCH`).
- Refused when the agent's autonomy now exceeds an ancestor's (`AUTONOMY_EXCEEDS_PARENT`).
- `chainVersion` changes with any policy change on the chain. A gateway must not cache past it.

**Semantics with the Tool Gateway lane** (`feat/tool-gateway-connectors`, `tool_grants`: exact
per-(tenant, agent, tool, action), no wildcard, uppercase `ActionClass`):

```
gateway authorises (agent, tool, ACTION) ⇔ gateway exact grant exists
                                        ∧ workforce.checkToolGrant(...).granted
                                        ∧ gateway policy / approval (its own)
```

- The workforce grant is the organisational ceiling: hierarchy, containment, revocation, drift,
  scope and mission. The gateway grant is the exact execution permission. Neither implies the
  other.
- Workforce actions are free strings with `*` meaning "every action of this tool" (ceiling only).
  The gateway's exact grant still has to name the action.
- **Integrator decision (strategic):** keep the conjunction, or make one store the single grant
  source. Recommended: keep the conjunction until both lanes are merged, then decide.

## 5. Memory scope port — `workforce.authority`

- `resolveMemoryScope(system, agentId)` → `{ agentId, tenantId, active, reasons, missionId?,
clientIds, projectIds, read[], write[], maxVisibility, retentionDays?, expiresAt?, chainVersion }`.
  This is the agent's stored scope intersected with every ancestor as they are NOW.
- `checkMemoryAccess(system, { agentId, namespace, mode, visibility?, retentionDays?, clientId?,
projectId?, missionId? })` → `{ allowed, reasons }`.
- Vocabulary matches `core/memory`: visibility `private < restricted < tenant`; namespaces nest
  (`a/b` is inside `a`; `*` holds everything).
- Creation refuses a child with wider namespaces, broader visibility or longer (or unbounded,
  under a bounded parent) retention (`MEMORY_SCOPE_ESCAPE`). Siblings share nothing implicitly.
- Storage and enforcement at read/write time belong to the Cognitive Runtime (lane C): NOT_CONNECTED here.

## 6. Cockpit read model — `workforce.readModel.snapshot(principal)`

- Requires an issued human holding `cockpit.read`, or the system.
- Returns deep-frozen copies: agents (kind, role, department, supervisor, depth, status, **health**
  `active|suspended|blocked|retired|expired|degraded` + reasons, autonomy, budget
  `{computeUnits, allocatedToReports, committedToAssignments}`, tool grants with `live`, effective
  memory summary, scope, mission, expiry, objectives, KPIs, active assignments, performance),
  departments, roles, skills, active assignments (with `approvalPending`), organisation
  performance.
- No mutating method. Commands go through `WorkforceService`.

## 7. Integration collision manifest (audited 2026-09-30, local branches, read-only)

**CURRENT_MIGRATIONS** (≥ 0048)

| Branch                                                         | Head        | Migration                       | Journal idx / `when`   |
| -------------------------------------------------------------- | ----------- | ------------------------------- | ---------------------- |
| feat/autonomy-core3-goal-planner-dag (+ all lanes based on it) | d110f96     | `0048_compute_routing_evidence` | 45 / 1790972802287     |
| integration/core3-control-foundation                           | 2156ddd     | `0048_control_plane`            | 45 / 1790886403287     |
| feat/tool-gateway-connectors                                   | 21d8818     | `0049_tool_gateway`             | 46 / 1791059202287     |
| feat/proactive-supervisor                                      | f79a7b6     | `0049_proactive_supervisor`     | 46 / 1791059202287     |
| feat/cognitive-runtime                                         | 3ea6f49     | `0050_cognitive_runtime`        | 46 / 1791145602287     |
| **feat/digital-workforce**                                     | this branch | **`0051_digital_workforce`**    | **46 / 1791059202287** |

**CURRENT_DECISIONS** (≥ 0054)

| Decision                                                   | Branch                       |
| ---------------------------------------------------------- | ---------------------------- |
| 0054-governed-multi-model-worker-routing                   | shared base                  |
| 0055-governed-tool-gateway                                 | feat/tool-gateway-connectors |
| 0055-proactive-supervisor                                  | feat/proactive-supervisor    |
| 0056-cognitive-runtime-and-memory-v1                       | feat/cognitive-runtime       |
| 0056-voice-is-a-transport-adapter-around-cognitive-runtime | feat/voice-realtime          |
| **0057-digital-workforce-foundation**                      | **feat/digital-workforce**   |

**KNOWN_COLLISIONS**

- Migration prefix `0048`: compute_routing_evidence vs control_plane.
- Migration prefix `0049`: tool_gateway vs proactive_supervisor.
- Migration prefix `0050`: **digital_workforce vs cognitive_runtime**.
- Every lane appends journal idx 46. Several share `when` 1791059202287.
- Decision `0055` ×2. Decision `0056` ×3 (**including this one**).
- SQL object names: none. The prefixes `workforce_*`, `icos_workforce_*`, `cognitive_*`,
  `memory_*`, `tool_*` and `supervisor_*` are disjoint. 0051_digital_workforce alters no shared
  table or constraint. It does NOT touch `audit_event_type_check` (which 0049_tool_gateway widens)
  or `scheduled_jobs_kind_check` (which 0049_proactive_supervisor widens).

**REQUIRED_RESEQUENCING** (proposal. The integrator owns the order. No branch was renumbered.)

1. Keep `0048_compute_routing_evidence` (base of every lane). The control-plane 0048 needs its
   own number if that branch is still integrated.
2. Assign unique consecutive prefixes in merge order, e.g. `0049_tool_gateway`,
   `0050_proactive_supervisor`, `0051_cognitive_runtime`, `0052_digital_workforce`. Renaming this
   file is a pure rename: nothing inside it depends on its number.
3. Decisions: give each a unique number in merge order, e.g. 0055 tool gateway, 0056 proactive
   supervisor, 0057 cognitive runtime, 0058 voice, **0059 digital workforce**. Update the in-file
   references (`decision 0057` in `src/core/workforce/*`, `src/server/workforce/*`,
   `workforce-schema.ts`, the migration header and these docs):
   `grep -rl "0056" src/core/workforce src/server/workforce src/server/database/workforce-schema.ts docs/icos/digital-workforce drizzle/*digital_workforce.sql`.
4. Two widened CHECKs must merge their value lists if they ever touch the same constraint. Today
   they are different constraints.

**JOURNAL_CHANGES_REQUIRED** (`drizzle/meta/_journal.json`)

- One entry per migration, `idx` contiguous from 46, tags matching the renamed files.
- `when` strictly increasing **and** greater than the `when` of any migration already applied in
  any existing database. Drizzle skips a migration whose `when` is not after the last applied
  one, so a resequenced migration keeping an old `when` would silently never run.
- This branch adds exactly one entry (`0051_digital_workforce`, idx 46, when 1791059202287).
  Replace it; don't merge it verbatim.
- Checks: `src/server/database/migration-journal.test.ts` (bijection, contiguous idx, increasing
  `when`, unique prefixes) and `migrations-fresh-database.integration.test.ts`.

## 8. Still NOT_CONNECTED

Container/route wiring, the model side of capability decomposition, memory enforcement inside the
Cognitive Runtime, gateway-side conjunction code, a sweeper to retire expired ephemeral agents,
and RLS.
