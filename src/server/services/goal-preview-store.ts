import { HighLevelGoal } from "@/core/contracts/high-level-goal";

/**
 * In-memory store for normalized goals to allow preview validation.
 * Goals are automatically removed after a max age to prevent memory leaks.
 */
export class GoalPreviewStore {
  private static readonly MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
  private static readonly instance: GoalPreviewStore = new GoalPreviewStore();
  private storeMap: Map<string, { goal: HighLevelGoal; timestamp: number }> = new Map();

  private constructor() {
    // No-op
  }

  static getInstance(): GoalPreviewStore {
    return GoalPreviewStore.instance;
  }

  /**
   * Store a normalized goal for later preview validation.
   * @param goalId - The ID of the goal.
   * @param goal - The normalized goal.
   */
  store(goalId: string, goal: HighLevelGoal): void {
    this.storeMap.set(goalId, {
      goal,
      timestamp: Date.now(),
    });
  }

  /**
   * Retrieve a normalized goal by ID if it exists and is not expired.
   * @param goalId - The ID of the goal.
   * @returns The goal if found and not expired, otherwise null.
   */
  retrieve(goalId: string): HighLevelGoal | null {
    const entry = this.storeMap.get(goalId);
    if (!entry) {
      return null;
    }

    const now = Date.now();
    if (now - entry.timestamp > GoalPreviewStore.MAX_AGE_MS) {
      // Remove expired entry
      this.storeMap.delete(goalId);
      return null;
    }

    return entry.goal;
  }

  /**
   * Remove a goal from the store (e.g., after preview conversion to prevent replay).
   * Note: We don't remove by default to allow idempotent conversion.
   * @param goalId - The ID of the goal to remove.
   */
  remove(goalId: string): void {
    this.storeMap.delete(goalId);
  }
}