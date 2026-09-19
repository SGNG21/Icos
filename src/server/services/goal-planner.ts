import { HighLevelGoalSchema, HighLevelGoal } from "@/core/contracts/high-level-goal";
import { GoalPlanPreviewSchema, GoalPlanPreview } from "@/core/contracts/high-level-goal";
import { z } from "zod";
import { idSchema } from "@/core/contracts/common";

/**
 * GoalPlanner transforms a normalized high-level goal into a goal plan preview.
 * It creates a mission plan with tasks, dependencies, and requirements.
 * This is a placeholder implementation that can be replaced by an AI planner later.
 */
export class GoalPlanner {
  /**
   * Create a goal plan preview from the given normalized goal.
   * @param goal - The normalized high-level goal.
   * @returns A goal plan preview.
   */
  plan(goal: HighLevelGoal): GoalPlanPreview {
    // We'll create a simple plan with three tasks: research, implementation, validation.
    // In a real system, this would be more sophisticated and based on the goal's content.

    // Generate stable IDs for tasks (based on goal ID and task index).
    const taskIds = {
      research: `${goal.id}-task-research`,
      implementation: `${goal.id}-task-implementation`,
      validation: `${goal.id}-task-validation`,
    };

    // Define tasks.
    const tasks = [
      {
        id: taskIds.research,
        title: `Recherche et analyse pour : ${goal.objective}`,
        description: `Analyser les besoins, les contraintes et les critères de succès liés à l'objectif : "${goal.objective}".`,
        dependsOn: [] as string[], // No dependencies for the first task.
        capability: undefined, // To be determined by worker matching.
        workerKind: undefined, // To be determined by worker matching.
        riskLevel: goal.riskLevel, // Inherit risk level from goal.
        humanApprovalRequired: this.requiresHumanApproval(goal, "research"),
        acceptanceCriteria: [
          "Contraintes identifiées",
          "Critères de succès définis",
          "Risques évalués",
        ],
        // Worker requirements
        parallelizable: true, // Research can often be parallelized
        sandboxRequired: false, // Research typically doesn't need sandbox
        isolatedWorkspaceRequired: false, // Research can share workspace
      },
      {
        id: taskIds.implementation,
        title: `Mise en œuvre de : ${goal.objective}`,
        description: `Développer la solution répondant à l'objectif : "${goal.objective}".`,
        dependsOn: [taskIds.research], // Depends on research.
        capability: undefined,
        workerKind: undefined,
        riskLevel: goal.riskLevel,
        humanApprovalRequired: this.requiresHumanApproval(goal, "implementation"),
        acceptanceCriteria: [
          "Solution développée selon les spécifications",
          "Code révisé et testé",
          "Documentation produite",
        ],
        // Worker requirements
        parallelizable: false, // Implementation is often sequential
        sandboxRequired: true, // Implementation usually needs sandbox for safety
        isolatedWorkspaceRequired: true, // Implementation benefits from isolated workspace
      },
      {
        id: taskIds.validation,
        title: `Validation et déploiement de : ${goal.objective}`,
        description: `Valider la solution et la déployer en production pour l'objectif : "${goal.objective}".`,
        dependsOn: [taskIds.implementation], // Depends on implementation.
        capability: undefined,
        workerKind: undefined,
        riskLevel: goal.riskLevel,
        humanApprovalRequired: this.requiresHumanApproval(goal, "validation"),
        acceptanceCriteria: [
          "Solution validée contre les critères de succès",
          "Déploiement réussi",
          "Monitoring mis en place",
        ],
        // Worker requirements
        parallelizable: false, // Validation and deployment are typically sequential
        sandboxRequired: true, // Validation needs sandbox to test safely
        isolatedWorkspaceRequired: true, // Deployment often needs isolated workspace
      },
    ];

    // Build the goal plan preview.
    const preview: GoalPlanPreview = {
      goalId: goal.id,
      missionTitle: goal.title,
      missionObjective: goal.objective,
      tasks,
    };

    // Validate the preview against the schema (throws if invalid).
    GoalPlanPreviewSchema.parse(preview);

    return preview;
  }

  /**
   * Determine if a task requires human approval based on the goal's policy and risk level.
   * @param goal - The normalized high-level goal.
   * @param taskType - The type of task (research, implementation, validation).
   * @returns True if human approval is required.
   */
  private requiresHumanApproval(goal: HighLevelGoal, taskType: string): boolean {
    // If the policy is "always", require approval.
    if (goal.humanApprovalPolicy === "always") {
      return true;
    }
    // If the policy is "never", never require approval.
    if (goal.humanApprovalPolicy === "never") {
      return false;
    }
    // If the policy is "if_risky", require approval for sensitive risk level.
    if (goal.humanApprovalPolicy === "if_risky") {
      return goal.riskLevel === "sensitive";
    }
    // Default to false.
    return false;
  }
}