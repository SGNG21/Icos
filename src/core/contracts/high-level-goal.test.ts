import { describe, expect, it } from "vitest";

import { HighLevelGoalInputSchema, HighLevelGoalSchema, HighLevelGoalInput, HighLevelGoal } from "./high-level-goal";
import { GoalPlanPreviewSchema, GoalPlanPreview } from "./high-level-goal";

describe("HighLevelGoal contracts", () => {
  it("should validate a valid high-level goal input", () => {
    const input: HighLevelGoalInput = {
      title: "Test Goal",
      objective: "Build a website for an electrician",
    };
    const parsed = HighLevelGoalInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.title).toBe("Test Goal");
      expect(parsed.data.objective).toBe("Build a website for an electrician");
    }
  });

  it("should invalidate high-level goal input with empty title", () => {
      const input: HighLevelGoalInput = {
        title: "",
        objective: "Build a website",
      };
      const parsed = HighLevelGoalInputSchema.safeParse(input);
      expect(parsed.success).toBe(false);
    });

  it("should validate a normalized high-level goal", () => {
    const goal: HighLevelGoal = {
      id: "goal-test",
      title: "Test Goal",
      objective: "Build a website for an electrician",
      rawInput: "Test Goal: Build a website for an electrician",
      normalizedIntent: "Build a website for an electrician",
      constraints: ["budget", "deadline"],
      successCriteria: ["SEO optimized", "Mobile responsive"],
      priority: 3,
      riskLevel: "reversible",
      deadline: "2026-12-31T00:00:00.000Z",
      budget: 5000,
      allowedCapabilities: ["web.design", "web.development"],
      forbiddenCapabilities: ["crypto.mining"],
      humanApprovalPolicy: "if_risky",
      metadata: { source: "user" },
      createdAt: new Date().toISOString(),
    };
    const parsed = HighLevelGoalSchema.safeParse(goal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.id).toBe("goal-test");
      expect(parsed.data.constraints).toContain("budget");
      expect(parsed.data.successCriteria).toContain("SEO optimized");
    }
  });

  it("should invalidate normalized goal with invalid risk level", () => {
    const goal: HighLevelGoal = {
      id: "goal-test",
      title: "Test Goal",
      objective: "Build a website",
      rawInput: "Test Goal: Build a website",
      normalizedIntent: "Build a website",
      constraints: [],
      successCriteria: [],
      priority: 3,
      // @ts-expect-error - intentionally invalid risk level
      riskLevel: "invalid",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    const parsed = HighLevelGoalSchema.safeParse(goal);
    expect(parsed.success).toBe(false);
  });

  it("should validate a goal plan preview", () => {
    const preview: GoalPlanPreview = {
      goalId: "goal-test",
      missionTitle: "Build website mission",
      missionObjective: "Build a website for an electrician",
      tasks: [
        {
          id: "task-research",
          title: "Research",
          description: "Research the requirements",
          dependsOn: [],
          capability: undefined,
          workerKind: undefined,
          riskLevel: "read_only",
          humanApprovalRequired: false,
          acceptanceCriteria: ["Research complete"],
          parallelizable: true,
          sandboxRequired: false,
          isolatedWorkspaceRequired: false,
        },
        {
          id: "task-implementation",
          title: "Implementation",
          description: "Build the website",
          dependsOn: ["task-research"],
          capability: "web.development",
          workerKind: "developer",
          riskLevel: "reversible",
          humanApprovalRequired: true,
          acceptanceCriteria: ["Website built"],
          parallelizable: false,
          sandboxRequired: true,
          isolatedWorkspaceRequired: true,
        },
      ],
    };
    const parsed = GoalPlanPreviewSchema.safeParse(preview);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tasks[0].parallelizable).toBe(true);
      expect(parsed.data.tasks[1].sandboxRequired).toBe(true);
    }
  });
});