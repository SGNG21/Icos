import { describe, expect, it } from "vitest";

import type { Mission } from "@/core/mission";

import {
  BOUNDED_MISSION_ACCEPTANCE_CRITERIA,
  createBoundedMissionPlan,
} from "./create-bounded-mission-plan";

const mission: Mission = {
  id: "mission-bounded-001",
  tenantId: "tenant-1",
  userRequest: "Inspect $(danger) && preserve this exact objective",
  status: "CREATED",
  runs: [],
  createdAt: "2026-07-28T08:00:00.000Z",
  updatedAt: "2026-07-28T08:00:00.000Z",
};

describe("createBoundedMissionPlan", () => {
  it("creates exactly one deterministic canonical step and preserves the exact objective", () => {
    const first = createBoundedMissionPlan(mission);
    const second = createBoundedMissionPlan(structuredClone(mission));

    expect(first).toEqual(second);
    expect(first.totalSteps).toBe(1);
    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]).toEqual({
      id: "task-mission-bounded-001",
      description: mission.userRequest,
      dependsOn: [],
      status: "pending",
    });
  });

  it("keeps repository safeguards explicit without deriving shell commands", () => {
    expect(BOUNDED_MISSION_ACCEPTANCE_CRITERIA).toHaveLength(5);
    expect(BOUNDED_MISSION_ACCEPTANCE_CRITERIA.join(" ")).toMatch(/focused tests/i);
    expect(BOUNDED_MISSION_ACCEPTANCE_CRITERIA.join(" ")).toMatch(/independent review/i);
    expect(BOUNDED_MISSION_ACCEPTANCE_CRITERIA.join(" ")).toMatch(/GlobalGates/);
    expect(BOUNDED_MISSION_ACCEPTANCE_CRITERIA.join(" ")).toMatch(/Stop before merge/i);

    const plan = createBoundedMissionPlan(mission);
    expect(plan.description).toMatch(/focused tests/i);
    expect(plan.description).toMatch(/independent review/i);
    expect(plan.description).toMatch(/GlobalGates/);
    expect(plan.description).toMatch(/stop before merge/i);
    expect(plan).not.toHaveProperty("command");
    expect(plan.steps[0]).not.toHaveProperty("command");
    expect(plan.steps[0].description).toBe(mission.userRequest);
  });
});
