import type { DurableMemory } from "./durable-memory";
import type {
  Checkpoint,
  ContextQuery,
  HandoffPackage,
  CompactionResult,
  WorkingMemory,
} from "../contracts";
import type { ContextItem } from "../contracts/context-item";
import { MissionContext, InMemoryWorkingMemory } from "./mission-context";

/**
 * ContextEngine orchestrates the three memory layers: Mission Context (hot),
 * Working Memory (warm), and Durable Memory (cold).
 */
export class ContextEngine {
  constructor(
    private missionContext: MissionContext,
    private workingMemory: WorkingMemory,
    private durableMemory: DurableMemory,
  ) {}

  /**
   * Create or get a ContextEngine for a mission.
   * @param missionId - The mission ID
   * @returns Promise resolving to a ContextEngine instance
   */
  static async forMission(missionId: string): Promise<ContextEngine> {
    // For now, we create dummy instances. In a real implementation,
    // these would be loaded from the database or constructed with proper dependencies.
    const mission = {
      id: missionId,
      title: `Mission ${missionId}`,
      objective: "",
      status: "draft" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const missionContext = new MissionContext(mission);
    const workingMemory = new InMemoryWorkingMemory("default-agent", `session-${missionId}`);
    // We need a DurableMemory implementation. For now, we'll use a simple in-memory one.
    // In practice, this would be PostgresDurableMemory from the server layer.
    const { InMemoryDurableMemory } = await import("./durable-memory");
    const durableMemory = new InMemoryDurableMemory();
    return new ContextEngine(missionContext, workingMemory, durableMemory);
  }

  /**
   * Save a checkpoint of the current mission context.
   * @param missionId - The mission ID
   * @param label - Optional label for the checkpoint
   * @returns Promise resolving to the saved checkpoint
   */
  async checkpoint(missionId: string, label?: string): Promise<Checkpoint> {
    return this.missionContext.toCheckpoint(label);
  }

  /**
   * Restore mission context from a checkpoint.
   * @param missionId - The mission ID
   * @param checkpointId - Optional specific checkpoint ID; if not provided, uses the latest
   * @returns Promise resolving to the restored mission context
   */
  async restore(missionId: string, checkpointId?: string): Promise<MissionContext> {
    let checkpoint;
    if (checkpointId) {
      checkpoint = await this.durableMemory.getCheckpointById(checkpointId);
      if (!checkpoint) {
        throw new Error(`Checkpoint not found: ${checkpointId}`);
      }
    } else {
      checkpoint = await this.durableMemory.getLatestCheckpoint(missionId);
      if (!checkpoint) {
        // Cold start: return a fresh context
        const mission = {
          id: missionId,
          title: `Mission ${missionId}`,
          objective: "",
          status: "draft" as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return new MissionContext(mission);
      }
    }
    return MissionContext.fromCheckpoint(checkpoint);
  }

  /**
   * Compact the mission context to fit within a token budget.
   * @param missionId - The mission ID
   * @returns Promise resolving to the compaction result
   */
  async compact(missionId: string): Promise<CompactionResult> {
    // TODO: Implement actual compaction logic
    // For now, return a placeholder indicating no change
    return {
      originalTokens: 0,
      compactedTokens: 0,
      reductionPercent: 0,
      criticalKept: 0,
      highPriorityKept: 0,
      mediumSummarized: 0,
      lowDropped: 0,
      details: [],
    };
  }

  /**
   * Select relevant context items based on a query.
   * @param query - The context query
   * @returns Promise resolving to an array of context items
   */
  async selectRelevant(query: ContextQuery): Promise<ContextItem[]> {
    // TODO: Implement actual selection logic based on query
    // For now, return an empty array
    return [];
  }

  /**
   * Create a handoff package for transferring mission context from one agent to another.
   * @param fromAgent - The agent ID of the source agent
   * @param toAgent - The agent ID of the target agent
   * @param missionId - The mission ID
   * @returns Promise resolving to the handoff package
   */
  async handoff(fromAgent: string, toAgent: string, missionId: string): Promise<HandoffPackage> {
    // TODO: Implement actual handoff logic
    // For now, return a minimal package
    return {
      id: `handoff-${Math.random().toString(36).substring(2, 9)}`,
      missionId,
      fromAgent,
      toAgent,
      timestamp: new Date().toISOString(),
      reason: "specialization",
      missionContext: {
        mission: {
          id: this.missionContext.mission.id,
          title: this.missionContext.mission.title,
          objective: this.missionContext.mission.objective,
          status: this.missionContext.mission.status,
          createdAt: this.missionContext.mission.createdAt.toISOString(),
          updatedAt: (this.missionContext.mission.updatedAt
            ? this.missionContext.mission.updatedAt
            : this.missionContext.mission.createdAt
          ).toISOString(),
        },
        tasks: Array.from(this.missionContext.tasks.values()),
        taskResults: Object.fromEntries(this.missionContext.taskResults),
        recentDecisions: this.missionContext.decisions,
        currentArtifacts: this.missionContext.artifacts.map((a) => ({
          type: a.type,
          path: a.contentReference || undefined,
          url: a.contentReference?.startsWith("http") ? a.contentReference : undefined,
          mediaType: undefined as string | undefined,
          metadata: undefined as Record<string, unknown> | undefined,
        })),
        evidence: this.missionContext.evidence.map((e) => ({
          type: e.type,
          source: e.scope,
          path: e.contentReference || undefined,
          url: e.contentReference?.startsWith("http") ? e.contentReference : undefined,
          timestamp: e.createdAt,
          metadata: undefined as Record<string, unknown> | undefined,
        })),
        errors: this.missionContext.errors.map((e) => ({ code: e.code, message: e.message })),
        checkpoints: this.missionContext.checkpoints,
        tokenEstimate: this.missionContext.getTokenEstimate(),
      },
      workingMemorySlice: {
        patterns: [],
        templates: [],
        calibration: [],
      },
      durableRefs: {
        checkpointId: "",
        decisionIds: [],
        resultIds: [],
      },
    };
  }
}
