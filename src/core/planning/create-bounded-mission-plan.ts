import { planSchema, type Mission, type Plan } from "@/core/mission";

/**
 * The milestone deliberately supports one repository-development task only.
 * These criteria are descriptive orchestration constraints, never authority.
 */
export const BOUNDED_MISSION_ACCEPTANCE_CRITERIA = [
  "Work remains local to the current repository and within the Mission objective.",
  "Relevant focused tests are added or updated and pass.",
  "An independent review reports PASS before integration.",
  "Canonical GlobalGates pass before the result is accepted.",
  "Stop before merge: no merge, deployment, production, client-system, credential, or arbitrary external action is performed.",
] as const;

export const BOUNDED_MISSION_PLAN_DESCRIPTION =
  "One local repository-development task only. Preserve the exact Mission objective. " +
  "Run relevant focused tests, require independent review and canonical GlobalGates, " +
  "then stop before merge. No deployment, production, client-system, credential, " +
  "arbitrary external action, recursive planning, or AI/network planning.";

/**
 * Pure, deterministic Mission -> Plan adapter for MISSION-SUPERVISOR-BRIDGE-1.
 * It does not interpret the objective as commands and performs no I/O.
 */
export function createBoundedMissionPlan(mission: Mission): Plan {
  return planSchema.parse({
    steps: [
      {
        id: `task-${mission.id}`,
        description: mission.userRequest,
        dependsOn: [],
        status: "pending",
      },
    ],
    totalSteps: 1,
    description: BOUNDED_MISSION_PLAN_DESCRIPTION,
  });
}
