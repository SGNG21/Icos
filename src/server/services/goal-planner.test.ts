import { describe, expect, it, vi, beforeEach } from "vitest";

import { GoalPlanner } from "./goal-planner";
import { HighLevelGoalSchema, HighLevelGoal } from "@/core/contracts/high-level-goal";
import { GoalPlanPreviewSchema, GoalPlanPreview } from "@/core/contracts/high-level-goal";

describe("GoalPlanner", () => {
  let planner: GoalPlanner;

  beforeEach(() => {
    planner = new GoalPlanner();
  });

  it("should create a goal plan preview from a normalized goal", () => {
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
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const preview = planner.plan(goal);

    expect(preview.goalId).toBe("goal-test");
    expect(preview.missionTitle).toBe("Test Goal");
    expect(preview.missionObjective).toBe("Build a website for an electrician");
    expect(preview.tasks).toHaveLength(3);

    // Check the first task (research)
    const researchTask = preview.tasks.find(t => t.id === `${goal.id}-task-research`);
    expect(researchTask).toBeDefined();
    expect(researchTask?.title).toContain("Recherche et analyse");
    expect(researchTask?.dependsOn).toEqual([]);
    expect(researchTask?.humanApprovalRequired).toBe(false); // because riskLevel is reversible and policy is if_risky
    expect(researchTask?.parallelizable).toBe(true);
    expect(researchTask?.sandboxRequired).toBe(false);
    expect(researchTask?.isolatedWorkspaceRequired).toBe(false);

    // Check the second task (implementation)
    const implTask = preview.tasks.find(t => t.id === `${goal.id}-task-implementation`);
    expect(implTask).toBeDefined();
    expect(implTask?.title).toContain("Mise en œuvre");
    expect(implTask?.dependsOn).toEqual([`${goal.id}-task-research`]);
    expect(implTask?.humanApprovalRequired).toBe(false); // same reason
    expect(implTask?.parallelizable).toBe(false);
    expect(implTask?.sandboxRequired).toBe(true);
    expect(implTask?.isolatedWorkspaceRequired).toBe(true);

    // Check the third task (validation)
    const validationTask = preview.tasks.find(t => t.id === `${goal.id}-task-validation`);
    expect(validationTask).toBeDefined();
    expect(validationTask?.title).toContain("Validation et déploiement");
    expect(validationTask?.dependsOn).toEqual([`${goal.id}-task-implementation`]);
    expect(validationTask?.humanApprovalRequired).toBe(false);
    expect(validationTask?.parallelizable).toBe(false);
    expect(validationTask?.sandboxRequired).toBe(true);
    expect(validationTask?.isolatedWorkspaceRequired).toBe(true);

    // Validate the preview against the schema
    const parsed = GoalPlanPreviewSchema.safeParse(preview);
    expect(parsed.success).toBe(true);
  });

  it("should require human approval for sensitive risk level when policy is if_risky", () => {
    const goal: HighLevelGoal = {
      id: "goal-test",
      title: "Test Goal",
      objective: "Build a website for an electrician",
      rawInput: "Test Goal: Build a website for an electrician",
      normalizedIntent: "Build a website for an electrician",
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "sensitive", // sensitive risk level
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "if_risky",
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const preview = planner.plan(goal);

    // All tasks should require human approval because riskLevel is sensitive and policy is if_risky
    preview.tasks.forEach(task => {
      expect(task.humanApprovalRequired).toBe(true);
    });
  });

  it("should never require human approval when policy is never", () => {
    const goal: HighLevelGoal = {
      id: "goal-test",
      title: "Test Goal",
      objective: "Build a website for an electrician",
      rawInput: "Test Goal: Build a website for an electrician",
      normalizedIntent: "Build a website for an electrician",
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "sensitive",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "never",
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const preview = planner.plan(goal);

    preview.tasks.forEach(task => {
      expect(task.humanApprovalRequired).toBe(false);
    });
  });

  it("should always require human approval when policy is always", () => {
    const goal: HighLevelGoal = {
      id: "goal-test",
      title: "Test Goal",
      objective: "Build a website for an electrician",
      rawInput: "Test Goal: Build a website for an electrician",
      normalizedIntent: "Build a website for an electrician",
      constraints: [],
      successCriteria: [],
      priority: 3,
      riskLevel: "read_only",
      deadline: undefined,
      budget: undefined,
      allowedCapabilities: [],
      forbiddenCapabilities: [],
      humanApprovalPolicy: "always",
      metadata: {},
      createdAt: new Date().toISOString(),
    };

    const preview = planner.plan(goal);

    preview.tasks.forEach(task => {
      expect(task.humanApprovalRequired).toBe(true);
    });
  });
});