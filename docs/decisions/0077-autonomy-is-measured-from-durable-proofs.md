# 0077 — Autonomy is measured from durable proofs, never declared

Date: 2026-10-11 · Status: accepted (BR-06, BR-07) · Owner: FABLE 5.1 convergence

## Context

The Autonomy center showed every level L0–L6 as UNKNOWN and every dimension as NOT AVAILABLE
(BR-06): no component produced an assessment, and the one metrics service in the code
(`SelfDevelopmentMetrics`) was an in-memory counter that reset at every boot and was composed
nowhere. Human interventions were counted from every human-actor audit entry (BR-07), which
makes logging in look like autonomy debt.

Every step of an autonomous cycle already leaves a durable row written by its own authority:
CORE3 converts a goal (`goal.converted`), the execution callback settles a run
(`task.execution.completed`), reviewers persist their verdicts (`review_decisions`), the
integration gate records its report (`workspace.gate.reported`, migration 0063), self-development
goals carry their provenance (`goals.metadata.source`). Those rows are the only evidence worth
showing.

## Decision

1. **One assessment port**, `container.autonomyAssessment.current()`, computed by a pure ladder
   (`src/core/autonomy/assessment.ts`) over facts read by `src/server/autonomy/autonomy-evidence.ts`.
   The reader only reads existing repositories; it never writes, samples or infers.
2. **Three states per dimension**: PROVEN (≥1 durable proof row), UNPROVEN (source read, no
   proof yet), UNKNOWN (source unreadable). The level is UNKNOWN whenever a rung it depends on
   is UNKNOWN. A readable, empty runtime is L0 — the honest answer, not a guess.
3. **The ladder is ordinal and bounded by the evidence vocabulary**: L1 planning; L2 + routing;
   L3 + recovery; L4 + review + integration + a succeeded self-development mission. L5 and L6
   are declared unmeasurable until a source records value-based prioritisation; the cockpit
   shows them as UNKNOWN, never NOT REACHED.
4. **Certification names where the proof was made**: `ICOS_RUNTIME_TIER=lab|live`, declared by
   the deployment, never inferred. A proof in an undeclared runtime is CODE_READY only. The
   overall certification is the weakest of the proven dimensions.
5. **Interventions are tagged at their source** (`details.intervention = true` +
   `interventionReason`): approval decisions by a human (`record-action-decision.ts`) and executed
   control commands (`control/command-bus.ts`). The cockpit counts tagged entries as debt and
   names untagged human entries as a proxy, apart. Reserved reason: MANUAL_TRANSITION.
6. **In-memory counters are not evidence.** `SelfDevelopmentMetrics` stays unexposed.
7. **Reproducible**: `pnpm autonomy:assess [--json]` prints the same assessment the cockpit shows,
   from the same rows.

## Consequences

- First measurement (N1 lab, `icos_lab_run4`, 2026-10-11 19:29 UTC): **L2, LAB_CERTIFIED** —
  planning (1), routing (1), review (2) proven; recovery, integration, self-development
  UNPROVEN; deployment UNKNOWN (no source).
- The live runtime (@049a7d9) cannot be measured by this code until the convergence is
  deployed: its schema predates migration 0062, which the container composition reads.
- Tagging other human acts (holds, re-drives, manual retries — BR-23/24) extends the ledger
  without changing the cockpit: they only need `interventionDetails(...)` at their writer.
- Deployment stays a human act and stays UNKNOWN until a release ledger exists.
