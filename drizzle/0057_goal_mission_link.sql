-- One Goal converts to at most ONE Mission.
--
-- The link is written on two rows (missions.goal_id at insert, goals."resultingMissionId"
-- just after). Application code alone cannot keep that pair unique under a retry or two
-- concurrent converts: both callers see no mission and both create one. Only the database
-- can refuse the second, so the uniqueness lives here and the route treats the violation
-- as "someone else already converted this goal" rather than as an error.
--
-- Partial: a generic/manual mission carries no goal_id, and many of those may coexist.
CREATE UNIQUE INDEX IF NOT EXISTS missions_goal_id_unique
  ON missions (goal_id)
  WHERE goal_id IS NOT NULL;
