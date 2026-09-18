import {
  describe,
  expect,
  it,
} from "vitest";

import {
  validateMissionPlan,
  type MissionPlan,
} from "@/server/mission/mission-plan";

function validPlan(): MissionPlan {
  return {
    version: 1,
    tasks: [
      {
        key: "A",
        title: "Discover",
        description:
          "Inspect the current state",
        dependsOn: [],
        workerKind: "agent",
      },
      {
        key: "B",
        title: "Implement",
        description:
          "Implement the change",
        dependsOn: ["A"],
        workerKind: "agent",
      },
      {
        key: "C",
        title: "Verify",
        description:
          "Verify the result",
        dependsOn: ["A", "B"],
        workerKind: "agent",
      },
    ],
  };
}

describe(
  "MissionPlan deterministic validation",
  () => {
    it("accepts a valid DAG", () => {
      expect(() =>
        validateMissionPlan(validPlan()),
      ).not.toThrow();
    });

    it(
      "rejects an unknown dependency",
      () => {
        const plan = validPlan();

        plan.tasks[1].dependsOn = [
          "UNKNOWN",
        ];

        expect(() =>
          validateMissionPlan(plan),
        ).toThrow(
          "MISSION_PLAN_UNKNOWN_DEPENDENCY",
        );
      },
    );

    it("rejects self dependency", () => {
      const plan = validPlan();

      plan.tasks[0].dependsOn = ["A"];

      expect(() =>
        validateMissionPlan(plan),
      ).toThrow(
        "MISSION_PLAN_SELF_DEPENDENCY",
      );
    });

    it("rejects cycles", () => {
      const plan = validPlan();

      plan.tasks[0].dependsOn = ["C"];

      expect(() =>
        validateMissionPlan(plan),
      ).toThrow(
        "MISSION_PLAN_CYCLE",
      );
    });

    it("rejects duplicate keys", () => {
      const plan = validPlan();

      plan.tasks[2].key = "A";

      expect(() =>
        validateMissionPlan(plan),
      ).toThrow(
        "MISSION_PLAN_DUPLICATE_KEY",
      );
    });
  },
);
