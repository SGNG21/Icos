import type { Mission, Plan } from "@/core/mission";

import { BOUNDED_MISSION_ACCEPTANCE_CRITERIA } from "@/core/planning/create-bounded-mission-plan";
import { taskDagSchema, taskNodeSchema, type TaskDag, type TaskNode } from "./contract";

export class BoundedTaskDagError extends Error {
  readonly code = "INVALID_BOUNDED_PLAN";

  constructor() {
    super("The bounded Mission plan must contain exactly one task.");
    this.name = "BoundedTaskDagError";
  }
}

/**
 * Pure deterministic Plan -> TaskDag adapter. Timestamps are injected so the
 * same inputs produce the same canonical aggregate.
 */
export function createTaskDagFromPlan(input: {
  mission: Mission;
  plan: Plan;
  now: string;
}): TaskDag {
  if (input.plan.totalSteps !== 1 || input.plan.steps.length !== 1) {
    throw new BoundedTaskDagError();
  }

  const [step] = input.plan.steps;
  const node: TaskNode = taskNodeSchema.parse({
    id: step.id,
    label: "Execute bounded repository task",
    description: input.mission.userRequest,
    acceptanceCriteria: [...BOUNDED_MISSION_ACCEPTANCE_CRITERIA],
    status: "PENDING",
    dependsOn: [],
    blockedBy: [],
    workerAssignments: [],
    correctionIds: [],
    correctionCount: 0,
    retryCount: 0,
    maxRetries: 2,
    createdAt: input.now,
    updatedAt: input.now,
  });

  return taskDagSchema.parse({
    id: `dag-${input.mission.id}`,
    missionId: input.mission.id,
    tenantId: input.mission.tenantId,
    status: "CREATED",
    nodes: { [node.id]: node },
    nodeOrder: [node.id],
    createdAt: input.now,
    updatedAt: input.now,
  });
}
