# Cognitive → CORE3 live certification — 2026-09-30

Branch `feat/cognitive-runtime`, code at `44eaac7` (decision 0057). Harness:
`scripts/cognitive-live-certification.ts` (two separate processes). Evidence rows kept in
the test database `icos_cognitive_test`.

## Configuration (no secret printed)

| Item                                                                         | Status                                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| OmniRoute route `127.0.0.1:20129` + ICOS key (`/Users/coco/icos/.env.local`) | AVAILABLE (`/v1/models` HTTP 200, 440 models)                                                                                               |
| `ICOS_COGNITIVE_MODEL` (and fallback `ICOS_CEO_MODEL`)                       | NOT_CONFIGURED — test-time override set to the configured `ICOS_PLANNER_MODEL` id                                                           |
| `ICOS_PLANNER_MODEL` = `nvidia/nvidia/nemotron-3-super-120b-a12b`            | AVAILABLE (listed, invoked)                                                                                                                 |
| PostgreSQL `:5432`                                                           | AVAILABLE — live DB `icos_n23_probe` does not have migration 0051, so the run used the migrated test DB                                     |
| Durable Scheduler / production services for this branch                      | NOT RUNNING — the two `next-server` processes serve other checkouts; the scheduler side was run as a separate process with CORE3's handlers |
| Temporal `:7233`                                                             | AVAILABLE, deliberately NOT used: task dispatch was intercepted (shared with other lanes)                                                   |

## Run

1. **Initiator process** (`cognitiveRuntimeFor(container)`, real OmniRoute engine):
   conversation `conv-2deb09b0-8ec3-4235-a031-ef2673b50a48`, turn
   `turn-405130c8-8e16-41ec-a37b-56bd5391693e`, requested
   `nvidia/nvidia/nemotron-3-super-120b-a12b`, effective `nvidia/nemotron-3-super-120b-a12b`,
   HTTP 200, 17.2 s. Outcome **MISSION_REQUEST** parsed by the runtime without injection or
   repair (`riskLevel: read_only`, 3 constraints, 3 success criteria). Policy:
   `approval_required` (`CONVERSATIONAL_GOAL_RISK_MODEL_ASSERTED`); approved by the conversation
   owner → `launched`: goal `goal-analyse-des-pertes-…`, scheduler job
   `f5118dfd-47ee-4a0c-b009-7b657c2074af` (`start_mission`, key
   `cognitive-proposal:tref-87136864-…`, state `scheduled`), mission id
   `65d17f8b-1f2d-45a5-adc5-7e14df3ef9ec` **not yet created** when the process exited.
   Events: `conversation.created, turn.received, turn.processing, context.assembled,
proposal.created, turn.completed, memory.written, proposal.decided, proposal.launching,
proposal.launched`.
2. **Separate scheduler process** (`DurableScheduler` + `createSchedulerHandlers`, real
   `container.autonomousPlanner`): job claimed → `igniteAutonomousMission` created mission
   `65d17f8b-…` (goal lineage kept) and its autonomous runtime (`running`,
   `AUTONOMY_STARTED`); the real planner was invoked and failed
   **`AUTONOMY_PLANNER_INVALID_OUTPUT`** (JSON parse or `missionPlanSchema` failure, 3 attempts,
   `canonical-mission-planner.ts`); start **deferred** — mission `draft`, 0 tasks, no plan, job
   `succeeded` (attempt 1). Not repaired; planning retry belongs to the production recovery
   sweeper (not run here).

## Verdicts

REAL_MODEL_USED TRUE (cognitive, override of an unconfigured variable) · REAL_GOAL_CREATED TRUE ·
REAL_JOB_CREATED TRUE · REAL_MISSION_CREATED TRUE (planned: FALSE) ·
NO_OPERATOR_STAGE_ADVANCEMENT TRUE (only the policy approval) · DURABLE_AFTER_REQUEST_END TRUE
(mission created by another process after the initiator exited) · live certification: FALSE
(planner output invalid; cognitive model not configured; dispatch intercepted).
