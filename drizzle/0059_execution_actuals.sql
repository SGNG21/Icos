-- WHAT ACTUALLY EXECUTED, separate from what was requested.
--
-- A successful run was attributed to `nvidia/nvidia/nemotron-3-super-120b-a12b` — a model
-- id the gateway currently rejects as not in its live catalog — because the only trace
-- was the ROUTING DECISION, which records the logical route that was selected. The work
-- was really done by hermes. An audit that reports a model which could not have answered
-- is worse than one that reports nothing.
--
-- So the requested route keeps its own field (dispatch_attempts.routing_decision) and
-- these record what the executor itself reported. All nullable: an executor that does not
-- report its model leaves `actual_model` NULL, which says "unreported" rather than
-- repeating the request as though it were an observation.
ALTER TABLE task_execution_results
  ADD COLUMN IF NOT EXISTS actual_executor text,
  ADD COLUMN IF NOT EXISTS actual_provider text,
  ADD COLUMN IF NOT EXISTS actual_model text;
