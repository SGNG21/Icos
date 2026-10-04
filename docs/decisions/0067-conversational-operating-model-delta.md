# 0067 — The conversational operating model: the minimal delta

**Status:** proposed · **Date:** 2026-10-04 · **Supersedes nothing**

The product contract is: *"I talk to ICOS like a capable associate. ICOS can think, search,
remember, plan and discuss with me. When I authorize or policy allows execution, it handles
the rest."*

This records the **delta only**. Most of the target already exists and is certified; the gap
is narrower than it looks, and the point of writing it down is to stop us rebuilding things
that work. Each item below says what exists, what is missing, and the smallest change that
closes it.

## What already exists (do not rebuild)

| Target | Already in the runtime |
|---|---|
| Path 1, conversation without a Goal | `CognitiveRuntime` + `ContextAssembler`. Proven live: a real turn completes in ~5 s with `memory.written`, no Goal involved. |
| Path 2, autonomous execution | Goal → Mission → DAG → task → lease → worker → review → settlement. Proven live end to end, reviewer APPROVE. |
| The two paths converging | `MissionGateway.launch` (0056) is the one seam: conversation proposal → goal intake → `start_mission`. One personality, one intake. |
| Intent decision layer | `ConversationIntent` already distinguishes `ANSWER_ONLY`, `CLARIFICATION`, `ACTION_REQUEST`, `MISSION_REQUEST`, `APPROVAL_REQUEST`, `NO_ACTION`. |
| Governed side effects | Tool Gateway (`policy.ts` risk classes, connector catalog) **and** Execution Gateway (Seatbelt, brokered credentials, certified). |
| Read-only web primitive | `HTTP_DEFINITION` already declares `READ` / risk `LOW` / approval `none` — "GET a path under the base URL". |
| Durable memory | `memory_records` with scoped retrieval; written on every conversation turn. |
| Self-description | `RuntimeSelfModel` is wired and assembled per turn — capability is measured, not prose. |

The architecture is right. What follows is almost entirely **declaration, policy and
lifecycle**, not new subsystems.

## The delta, in the order it must be done

### 1. Workforce cancellation (blocks everything else)

**Missing.** A child assignment leaves `assigned` only by being executed and reviewed.
`synthesize` refuses `CHILDREN_NOT_SETTLED`; `review(…,"BLOCK")` refuses
`INVALID_TRANSITION, REVIEWER_NOT_QUALIFIED`. So a failed mission strands its delegations
for ever, and six stranded assignments already exhaust `maxParallelAssignments` (4) — which
is why Chief refused to delegate and a goal ran undelegated.

**Delta:** one terminal transition, `cancel(principal, assignmentId, reason)`, grantable to
the delegating supervisor, allowed from any non-terminal status, writing
`assignment.cancelled`. Then `chiefRelease` (already wired to mission settlement) can
actually release. Nothing else unblocks Chief.

### 2. Governed executor declaration

**Inconsistent.** `exec-command-config.ts` states the rule — *"Adding Hermes, Codex or
anything else is CONFIGURATION… deliberately no built-in default"* — and
`ICOS_WORKER_EXEC_COMMANDS` is unset, so `tools.governed` correctly reads NOT_CONNECTED.
Meanwhile the Temporal activity **hardcodes hermes**, so the thing that runs is not the
thing that is declared.

**Delta:** declare the executors in config; have the activity resolve its executor from
that declaration instead of a literal. The self-model probe already counts the declaration,
so `tools.governed` becomes AVAILABLE as a consequence rather than by being told to.

### 3. Mission autonomy policy

**Wrong shape.** `mission.launch` is unconditionally `APPROVAL_REQUIRED`, with the honest
evidence "risk asserted by the model, therefore unverified".

**Delta:** classify deterministically from **what the mission may touch**, never from what
the model says about itself. The inputs already exist on the task contract:
`allowed_file_scope`, `required_capabilities`, workspace mode, and whether any granted tool
action carries a non-`none` approval. Read-only internal analysis, web reads, memory
retrieval, isolated-worktree coding and its tests become `AUTO_ALLOWED`; merge/deploy,
customer contact and external writes stay policy-gated; destructive and irreversible stay
`APPROVAL_REQUIRED`. The model may *describe* risk; only the resolver may *grant*.

### 4. Provider and self-model truth

**Partly done.** `routableWorkers`, `durableBrains`, `governedExecutors` and a real
`realtimeConnectors` measurement landed today. Still missing: live provider status, and the
richer vocabulary (`AVAILABLE`, `DEGRADED`, `DISABLED_BY_POLICY`, `NOT_CONFIGURED`,
`UNAVAILABLE`) — today's five states collapse "not configured" into "not connected".

**Delta:** extend `CapabilityState`, add a provider probe reading the same source the
compute probe uses. No new source of truth.

### 5. Web / realtime research

**Missing as a capability, present as a primitive.** `tool_connector_health` is 0: nothing
is installed for the tenant. `HTTP_DEFINITION` gives governed read-only fetch; search needs
a provider.

**Delta:** install the http connector for the tenant and add a `search` connector beside it,
both `READ`/`LOW`/no-approval so research is autonomous by default while external writes
stay gated. Capture source URL and retrieval time as provenance on anything written to
memory. Explicitly **not** satisfied by model connectivity: a model answers from weights.

### 6. Conversational model routing

**Missing.** One `ICOS_COGNITIVE_MODEL` serves every interaction, so a one-line reply pays
reasoning-model latency.

**Delta:** workload classes (`CONVERSATION_FAST`, `CONVERSATION_DEEP`, `RESEARCH`,
`PLANNING`, `CODING`, `REVIEW`, `VOICE`) resolved per turn from the intent that the
cognitive layer *already* classifies, each mapping to a model id with a declared fallback.
The budget seam is unchanged — it meters whatever is chosen.

### 7. Conversation ↔ Goal handoff

**Exists, under-used.** `MissionGateway.launch` is reached only through an approved
conversation proposal. With (3) in place, an `AUTO_ALLOWED` class should launch without a
separate approval step while still producing the proposal record for the audit trail.

**Delta:** policy consults the resolver from (3) instead of always requiring a human
decision. No new path.

### 8. Mission memory

**Missing.** Conversation turns write memory; mission settlement does not. Proven today: a
settled mission wrote zero `memory_records`.

**Delta:** on settlement write one durable record carrying goal, mission, outcome, review
verdict and result reference, idempotent on mission id so replay cannot duplicate it.

### 9. Voice over the same path

**Already true structurally** — voice shares the Cognitive Runtime. It inherits (6) and
needs no second pipeline. Wake word stays out of scope.

## The invariants this must not break

Everything below is certified and must survive unchanged:

- a dispatched attempt always carries a finite lease, and a finished execution releases it;
- a goal converts to at most one mission, enforced by `missions_goal_id_unique`;
- spend is attributed to the goal, reserved before dispatch and settled under one lock;
- the reviewer is independent of the worker and judges only its given context;
- the executor runs under `(deny default)` Seatbelt with a disposable HOME, and the
  workspace is bound **read-only** for analysis missions;
- the model never grants itself authority.

## Sequencing

1 unblocks Chief, so it is first and nothing else is worth testing before it. 2 and 3 make
the system's self-description and its autonomy honest. 4 is small and makes the rest
observable. 5 is the only genuinely new capability. 6–9 are improvements on paths that
already work.
