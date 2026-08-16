import { describe, expect, it } from "vitest";

import type { Mission, Plan } from "@/core/mission";
import { createBoundedMissionPlan } from "@/core/planning/create-bounded-mission-plan";
import { taskDagSchema, taskNodeSchema } from "@/core/supervisor/contract";
import { validateDag } from "@/core/supervisor/lifecycle";

import { BoundedTaskDagError, createTaskDagFromPlan } from "./create-task-dag-from-plan";

const NOW = "2026-07-28T08:00:00.000Z";
const mission: Mission = {
  id: "mission-bounded-001",
  tenantId: "tenant-1",
  userRequest: "Preserve this exact repository objective",
  status: "CREATED",
  runs: [],
  createdAt: NOW,
  updatedAt: NOW,
};

describe("createTaskDagFromPlan", () => {
  it("creates one deterministic canonical mission-scoped DAG and TaskNode", () => {
    const plan = createBoundedMissionPlan(mission);
    const first = createTaskDagFromPlan({ mission, plan, now: NOW });
    const second = createTaskDagFromPlan({ mission, plan, now: NOW });
    const nodes = Object.values(first.nodes);

    expect(first).toEqual(second);
    expect(taskDagSchema.safeParse(first).success).toBe(true);
    expect(first.id).toBe("dag-mission-bounded-001");
    expect(first.missionId).toBe(mission.id);
    expect(first.tenantId).toBe(mission.tenantId);
    expect(first.status).toBe("CREATED");
    expect(nodes).toHaveLength(1);
    expect(taskNodeSchema.safeParse(nodes[0]).success).toBe(true);
    expect(nodes[0].status).toBe("PENDING");
    expect(nodes[0].description).toBe(mission.userRequest);
    expect(nodes[0].dependsOn).toEqual([]);
    expect(validateDag(nodes)).toEqual([]);
  });

  it("rejects plans outside the one-task bound", () => {
    const invalid: Plan = {
      steps: [
        {
          id: "task-one",
          description: "one",
          dependsOn: [],
          status: "pending",
        },
        {
          id: "task-two",
          description: "two",
          dependsOn: [],
          status: "pending",
        },
      ],
      totalSteps: 2,
      description: "invalid",
    };

    expect(() => createTaskDagFromPlan({ mission, plan: invalid, now: NOW })).toThrow(
      BoundedTaskDagError,
    );
  });
});
