import { HighLevelGoalInputSchema, HighLevelGoalSchema, HighLevelGoalInput, HighLevelGoal } from "@/core/contracts/high-level-goal";
import { isoDateTimeSchema } from "@/core/contracts/common";

/**
 * GoalNormalizer transforms a raw high-level goal input into a normalized high-level goal.
 * It preserves user intent, detects explicit constraints and success criteria,
 * and does not invent information silently.
 */
export class GoalNormalizer {
  /**
   * Normalize the given goal input.
   * @param input - The raw goal input from the user.
   * @returns A normalized high-level goal.
   */
  normalize(input: HighLevelGoalInput): HighLevelGoal {
    // We generate an id based on the title and objective for now.
    // In a real system, this might be a UUID or a hash.
    const id = `goal-${this.sanitizeForId(input.title)}-${this.sanitizeForId(input.objective)}`;

    // We set the normalizedIntent to the objective (trimmed) for now.
    const normalizedIntent = input.objective.trim();

    // Preserve explicit fields if provided, otherwise use defaults or extraction.
    const constraints = input.constraints ?? this.extractConstraints(input.objective, input.title);
    const successCriteria = input.successCriteria ?? this.extractSuccessCriteria(input.objective, input.title);
    const priority = input.priority ?? 3; // medium priority
    const riskLevel = input.riskLevel ?? "reversible"; // default risk level
    const humanApprovalPolicy = input.humanApprovalPolicy ?? "if_risky"; // default approval policy
    const metadata = input.metadata ?? {}; // no extra metadata for now
    const createdAt = new Date().toISOString(); // timestamp of normalization as ISO string

    // Build the normalized goal.
    const goal: HighLevelGoal = {
      id,
      title: input.title.trim(),
      objective: input.objective.trim(),
      rawInput: `${input.title}: ${input.objective}`,
      normalizedIntent,
      constraints,
      successCriteria,
      priority,
      riskLevel,
      deadline: input.deadline,
      budget: input.budget,
      allowedCapabilities: input.allowedCapabilities ?? [],
      forbiddenCapabilities: input.forbiddenCapabilities ?? [],
      humanApprovalPolicy,
      metadata,
      createdAt,
    };

    // Validate the goal against the schema (throws if invalid).
    HighLevelGoalSchema.parse(goal);

    return goal;
  }

  /**
   * Sanitize a string to be used in an ID (lowercase, alphanumeric, hyphens, underscores).
   */
  private sanitizeForId(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""); // remove leading/trailing hyphens
  }

  /**
   * Extract constraints from the objective and title.
   * This is a simple implementation that looks for explicit constraint keywords.
   */
  private extractConstraints(objective: string, title: string): string[] {
    const text = `${objective} ${title}`.toLowerCase();
    const constraints: string[] = [];

    // Look for explicit constraint patterns.
    if (text.includes("deadline") || text.includes("by")) {
      // We don't extract the value here, just note that there is a deadline constraint.
      constraints.push("deadline");
    }
    if (text.includes("budget") || text.includes("cost")) {
      constraints.push("budget");
    }
    if (text.includes("must not") || text.includes("cannot") || text.includes("forbidden") || text.includes("do not") || text.includes("don't")) {
      constraints.push("restriction");
    }
    // Add more constraint extraction rules as needed.

    return constraints;
  }

  /**
   * Extract success criteria from the objective and title.
   * This is a simple implementation that looks for explicit success indicators.
   */
  private extractSuccessCriteria(objective: string, title: string): string[] {
    const text = `${objective} ${title}`.toLowerCase();
    const success: string[] = [];

    // Look for success criteria patterns.
    if (text.includes("success") || text.includes("achieve") || text.includes("goal")) {
      success.push("achieve stated objective");
    }
    if (text.includes("measure") || text.includes("metric")) {
      success.push("define and meet metrics");
    }
    // Add more success criteria extraction rules as needed.

    return success;
  }
}