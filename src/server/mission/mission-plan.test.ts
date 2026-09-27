import {
  describe,
  expect,
  it,
} from "vitest";

import {
  PLAN_TASK_DEFAULTS,
  fingerprintMissionPlan,
  planExecutionOrder,
  resolvePlanTaskMetadata,
  validateMissionPlan,
  type MissionPlan,
  type MissionPlanTask,
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

/*
 * M2 — canonical planning metadata (mission N11/N12).
 *
 * These pin that planner-supplied metadata is VALIDATED and that malformed
 * values fail closed rather than being coerced to a default.
 */
describe("validateMissionPlan — canonical planning metadata", () => {
  const withTask = (
    over: Partial<MissionPlanTask>,
  ): MissionPlan => ({
    version: 1,
    tasks: [
      {
        key: "a",
        title: "A",
        dependsOn: [],
        ...over,
      },
    ],
  });

  it("accepts a fully specified planner task", () => {
    expect(() =>
      validateMissionPlan(
        withTask({
          objective: "Ship the thing",
          instructions: "Do it carefully",
          successCriteria: ["tests pass"],
          requiredCapabilities: ["typescript"],
          riskClass: "sensitive",
          allowedFileScope: ["src/**"],
          expectedArtifacts: ["diff"],
          priority: 1,
          attemptBudget: 5,
          reviewPolicy: "always",
          integrationPolicy: "gate",
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an unknown risk class instead of defaulting it", () => {
    expect(() =>
      validateMissionPlan(
        withTask({
          riskClass: "catastrophic" as never,
        }),
      ),
    ).toThrow(/MISSION_PLAN_INVALID_RISK_CLASS:a/);
  });

  it("rejects an unknown review policy", () => {
    expect(() =>
      validateMissionPlan(
        withTask({
          reviewPolicy: "whenever" as never,
        }),
      ),
    ).toThrow(
      /MISSION_PLAN_INVALID_REVIEW_POLICY:a/,
    );
  });

  it.each([0, 6, 2.5, Number.NaN])(
    "rejects out-of-range priority %s",
    (priority) => {
      expect(() =>
        validateMissionPlan(
          withTask({ priority }),
        ),
      ).toThrow(/MISSION_PLAN_INVALID_PRIORITY:a/);
    },
  );

  it.each([0, -1, 1.5])(
    "rejects invalid attempt budget %s",
    (attemptBudget) => {
      expect(() =>
        validateMissionPlan(
          withTask({ attemptBudget }),
        ),
      ).toThrow(
        /MISSION_PLAN_INVALID_ATTEMPT_BUDGET:a/,
      );
    },
  );

  it("rejects an empty objective", () => {
    expect(() =>
      validateMissionPlan(
        withTask({ objective: "   " }),
      ),
    ).toThrow(
      /MISSION_PLAN_EMPTY_OBJECTIVE:a/,
    );
  });

  it("rejects a blank success criterion rather than dropping it", () => {
    expect(() =>
      validateMissionPlan(
        withTask({
          successCriteria: ["ok", "  "],
        }),
      ),
    ).toThrow(
      /MISSION_PLAN_INVALID_SUCCESS_CRITERION:a/,
    );
  });

  it("rejects duplicate required capabilities", () => {
    expect(() =>
      validateMissionPlan(
        withTask({
          requiredCapabilities: ["ts", "ts"],
        }),
      ),
    ).toThrow(
      /MISSION_PLAN_DUPLICATE_REQUIRED_CAPABILITY:a/,
    );
  });

  it("rejects a blank allowed file scope entry", () => {
    expect(() =>
      validateMissionPlan(
        withTask({ allowedFileScope: [""] }),
      ),
    ).toThrow(
      /MISSION_PLAN_INVALID_ALLOWED_FILE_SCOPE:a/,
    );
  });

  it("refuses a sensitive task that is explicitly never reviewed", () => {
    expect(() =>
      validateMissionPlan(
        withTask({
          riskClass: "sensitive",
          reviewPolicy: "never",
        }),
      ),
    ).toThrow(
      /MISSION_PLAN_SENSITIVE_TASK_UNREVIEWED:a/,
    );
  });

  it("still accepts a legacy task carrying no planning metadata", () => {
    expect(() =>
      validateMissionPlan(withTask({})),
    ).not.toThrow();
  });
});

describe("resolvePlanTaskMetadata", () => {
  it("applies the documented defaults when the planner omits everything", () => {
    const resolved = resolvePlanTaskMetadata({
      key: "a",
      title: "A title",
      dependsOn: [],
    });

    expect(resolved).toEqual({
      objective: "A title",
      instructions: "",
      successCriteria: [],
      requiredCapabilities: [],
      riskClass: PLAN_TASK_DEFAULTS.riskClass,
      allowedFileScope: [],
      expectedArtifacts: [],
      priority: PLAN_TASK_DEFAULTS.priority,
      attemptBudget:
        PLAN_TASK_DEFAULTS.attemptBudget,
      reviewPolicy:
        PLAN_TASK_DEFAULTS.reviewPolicy,
      integrationPolicy:
        PLAN_TASK_DEFAULTS.integrationPolicy,
    });
  });

  it("lets planner values win over every default", () => {
    const resolved = resolvePlanTaskMetadata({
      key: "a",
      title: "A title",
      dependsOn: [],
      objective: "Real objective",
      instructions: "Real instructions",
      successCriteria: ["c1"],
      requiredCapabilities: ["cap"],
      riskClass: "read_only",
      allowedFileScope: ["src/**"],
      expectedArtifacts: ["report"],
      priority: 1,
      attemptBudget: 9,
      reviewPolicy: "always",
      integrationPolicy: "manual",
    });

    expect(resolved.objective).toBe(
      "Real objective",
    );
    expect(resolved.instructions).toBe(
      "Real instructions",
    );
    expect(resolved.riskClass).toBe("read_only");
    expect(resolved.priority).toBe(1);
    expect(resolved.attemptBudget).toBe(9);
    expect(resolved.reviewPolicy).toBe("always");
    expect(resolved.integrationPolicy).toBe(
      "manual",
    );
    expect(resolved.successCriteria).toEqual([
      "c1",
    ]);
    expect(resolved.allowedFileScope).toEqual([
      "src/**",
    ]);
    expect(resolved.expectedArtifacts).toEqual([
      "report",
    ]);
  });

  it("promotes a legacy single capability into requiredCapabilities", () => {
    expect(
      resolvePlanTaskMetadata({
        key: "a",
        title: "A",
        dependsOn: [],
        capability: "typescript",
      }).requiredCapabilities,
    ).toEqual(["typescript"]);
  });

  it("falls back to description for instructions", () => {
    expect(
      resolvePlanTaskMetadata({
        key: "a",
        title: "A",
        description: "from description",
        dependsOn: [],
      }).instructions,
    ).toBe("from description");
  });

  it("does not alias the planner's arrays", () => {
    const criteria = ["c1"];
    const resolved = resolvePlanTaskMetadata({
      key: "a",
      title: "A",
      dependsOn: [],
      successCriteria: criteria,
    });

    resolved.successCriteria.push("mutated");

    expect(criteria).toEqual(["c1"]);
  });
});

describe("planExecutionOrder", () => {
  const diamond: MissionPlan = {
    version: 1,
    tasks: [
      { key: "root-b", title: "B", dependsOn: [] },
      { key: "root-a", title: "A", dependsOn: [] },
      {
        key: "join",
        title: "Join",
        dependsOn: ["root-a", "root-b"],
      },
    ],
  };

  it("identifies every independent root (parallel roots)", () => {
    const { roots } =
      planExecutionOrder(diamond);

    expect(roots).toEqual([
      "root-a",
      "root-b",
    ]);
  });

  it("groups concurrently runnable tasks into levels", () => {
    const { levels } =
      planExecutionOrder(diamond);

    // Both roots run together; the join waits for both.
    expect(levels).toEqual([
      ["root-a", "root-b"],
      ["join"],
    ]);
  });

  it("is deterministic regardless of the planner's task order", () => {
    const shuffled: MissionPlan = {
      version: 1,
      tasks: [
        diamond.tasks[2],
        diamond.tasks[0],
        diamond.tasks[1],
      ],
    };

    expect(planExecutionOrder(shuffled)).toEqual(
      planExecutionOrder(diamond),
    );
  });

  it("emits dependencies before dependents", () => {
    const { order } = planExecutionOrder({
      version: 1,
      tasks: [
        { key: "c", title: "C", dependsOn: ["b"] },
        { key: "b", title: "B", dependsOn: ["a"] },
        { key: "a", title: "A", dependsOn: [] },
      ],
    });

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("orders a single chain into one task per level", () => {
    const { levels } = planExecutionOrder({
      version: 1,
      tasks: [
        { key: "a", title: "A", dependsOn: [] },
        { key: "b", title: "B", dependsOn: ["a"] },
      ],
    });

    expect(levels).toEqual([["a"], ["b"]]);
  });

  it("fails closed on a graph that is not a DAG", () => {
    // validateMissionPlan would reject this first; ordering must not truncate.
    expect(() =>
      planExecutionOrder({
        version: 1,
        tasks: [
          {
            key: "a",
            title: "A",
            dependsOn: ["b"],
          },
          {
            key: "b",
            title: "B",
            dependsOn: ["a"],
          },
        ],
      }),
    ).toThrow("MISSION_PLAN_NOT_A_DAG");
  });
});
