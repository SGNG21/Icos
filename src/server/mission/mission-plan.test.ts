import {
  describe,
  expect,
  it,
} from "vitest";

import {
  fingerprintMissionPlan,
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

describe("fingerprintMissionPlan", () => {
  it("is stable across repeated calls", () => {
    const plan = validPlan();

    expect(fingerprintMissionPlan(plan)).toBe(
      fingerprintMissionPlan(plan),
    );
  });

  it("is insensitive to property insertion order", () => {
    const a: MissionPlan = {
      version: 1,
      tasks: [
        {
          key: "a",
          title: "A",
          dependsOn: [],
        },
      ],
    };

    // Same logical content, properties declared in a different order.
    const b = {
      tasks: [
        {
          dependsOn: [],
          title: "A",
          key: "a",
        },
      ],
      version: 1,
    } as MissionPlan;

    expect(fingerprintMissionPlan(a)).toBe(
      fingerprintMissionPlan(b),
    );
  });

  /*
   * Regression guard for the defect recorded in
   * audit/self-build-bootstrap/M0-RECOVERY-REPORT.md (D1).
   *
   * The original implementation used
   *   JSON.stringify(plan, Object.keys(plan).sort())
   * where the second argument is a replacer WHITELIST applied at every
   * depth. It stripped every task property, so any two plans with the same
   * task count collided and applyPlan silently skipped genuine replans.
   */
  it("distinguishes different task content with the same task count", () => {
    const a: MissionPlan = {
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [] },
        {
          key: "b",
          title: "B",
          dependsOn: ["a"],
        },
      ],
    };

    const b: MissionPlan = {
      version: 1,
      tasks: [
        { key: "x", title: "X", dependsOn: [] },
        {
          key: "y",
          title: "Y",
          dependsOn: ["x"],
        },
      ],
    };

    expect(a.tasks).toHaveLength(b.tasks.length);
    expect(fingerprintMissionPlan(a)).not.toBe(
      fingerprintMissionPlan(b),
    );
  });

  it("distinguishes a changed dependency edge", () => {
    const a: MissionPlan = {
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [] },
        {
          key: "b",
          title: "B",
          dependsOn: ["a"],
        },
      ],
    };

    const b: MissionPlan = {
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [] },
        { key: "b", title: "B", dependsOn: [] },
      ],
    };

    expect(fingerprintMissionPlan(a)).not.toBe(
      fingerprintMissionPlan(b),
    );
  });

  it("distinguishes an added task", () => {
    const base = validPlan();
    const extended: MissionPlan = {
      ...base,
      tasks: [
        ...base.tasks,
        {
          key: "extra",
          title: "Extra",
          dependsOn: [],
        },
      ],
    };

    expect(
      fingerprintMissionPlan(base),
    ).not.toBe(fingerprintMissionPlan(extended));
  });

  it("distinguishes a changed plan version", () => {
    const a = validPlan();
    const b: MissionPlan = { ...a, version: 2 };

    expect(fingerprintMissionPlan(a)).not.toBe(
      fingerprintMissionPlan(b),
    );
  });

  it("treats an explicit undefined property as absent", () => {
    const a: MissionPlan = {
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [] },
      ],
    };

    const b: MissionPlan = {
      version: 1,
      tasks: [
        {
          key: "a",
          title: "A",
          dependsOn: [],
          description: undefined,
          workerKind: undefined,
        },
      ],
    };

    expect(fingerprintMissionPlan(a)).toBe(
      fingerprintMissionPlan(b),
    );
  });

  it("is a sha256 hex digest and never a plan identity", () => {
    expect(
      fingerprintMissionPlan(validPlan()),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});
