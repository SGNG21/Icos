import { HighLevelGoal, GoalPlanPreview } from "@/core/contracts/high-level-goal";
import type { GoalRepository } from "@/server/repositories/ports";

/**
 * Store for normalized goals to allow preview validation.
 * Uses a repository for persistence and an in-memory cache for recent goals.
 */
export class GoalPreviewStore {
  private static readonly MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
  private readonly repository: GoalRepository;
  private cache: Map<string, { goal: HighLevelGoal; timestamp: number }> = new Map();

  constructor(repository: GoalRepository) {
    this.repository = repository;
  }

  /**
   * Store a normalized goal and its preview for later preview validation.
   * @param goalId - The ID of the goal.
   * @param goal - The normalized goal.
   * @param preview - The generated preview for the goal.
   */
  async store(goalId: string, goal: HighLevelGoal, preview: GoalPlanPreview): Promise<void> {
    // Persist to repository
    await this.repository.create(goal, preview);
    // Update cache
    this.cache.set(goalId, { goal, timestamp: Date.now() });
  }

  /**
   * Retrieve a normalized goal by ID if it exists and is not expired.
   * @param goalId - The ID of the goal.
   * @returns The goal if found and not expired, otherwise null.
   */
  async retrieve(goalId: string): Promise<HighLevelGoal | null> {
    // Check cache first
    const cached = this.cache.get(goalId);
    if (cached && (Date.now() - cached.timestamp <= GoalPreviewStore.MAX_AGE_MS)) {
      return cached.goal;
    }

    // If not in cache or expired, try the repository
    const result = await this.repository.getById(goalId);
    if (result) {
      // Update cache
      this.cache.set(goalId, { goal: result.goal, timestamp: Date.now() });
      return result.goal;
    }

    return null;
  }

  /**
   * Remove a goal from the cache (e.g., after preview conversion to prevent replay).
   * Note: We don't remove from the repository to preserve audit and idempotency.
   * @param goalId - The ID of the goal to remove from the cache.
   */
  async remove(goalId: string): Promise<void> {
    this.cache.delete(goalId);
  }
}