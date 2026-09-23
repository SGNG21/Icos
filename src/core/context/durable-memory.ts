import type {
  Checkpoint,
  CheckpointRef,
  DecisionRecord,
  LearnedPattern,
  AgentPreferences,
  ContextTemplate,
  ToolCalibration,
  WorkingMemory,
  HandoffPackage,
  ContextQuery,
  SelectionResult,
  CompactedContext,
  CompactionResult,
  ConsistencyReport,
} from "@/core/context/contracts";
import type { ContextItem } from "@/core/contracts/context-item";
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { TaskExecutionResult } from "@/core/contracts/task-execution";
import { v4 as uuidv4 } from "uuid";

function cloneLearnedPattern(pattern: LearnedPattern): LearnedPattern {
  return {
    ...pattern,
    signature: {
      ...pattern.signature,
      ...(pattern.signature.taskTitleKeywords
        ? { taskTitleKeywords: [...pattern.signature.taskTitleKeywords] }
        : {}),
    },
    observations: [...pattern.observations],
    outcomeCounts: { ...pattern.outcomeCounts },
    evidenceRefs: [...pattern.evidenceRefs],
  };
}

/**
 * In-memory implementation of DurableMemory for testing and development.
 * Production should use PostgreSQL backend.
 */
export class InMemoryDurableMemory implements DurableMemory {
  private checkpoints: Map<string, Checkpoint> = new Map();
  private decisions: Map<string, DecisionRecord> = new Map();
  private executionResults: Map<string, TaskExecutionResult> = new Map();
  private patterns: Map<string, LearnedPattern> = new Map();
  private contextItems: Map<string, ContextItem> = new Map();
  private handoffPackages: Map<string, HandoffPackage> = new Map();

  // Checkpoints
  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, checkpoint);
  }

  async getCheckpoints(missionId: string): Promise<Checkpoint[]> {
    return Array.from(this.checkpoints.values())
      .map((checkpoint, insertionIndex) => ({ checkpoint, insertionIndex }))
      .filter(({ checkpoint }) => checkpoint.missionId === missionId)
      .sort((a, b) => {
        const timeDiff =
          new Date(b.checkpoint.createdAt).getTime() - new Date(a.checkpoint.createdAt).getTime();

        if (timeDiff !== 0) {
          return timeDiff;
        }

        // Map preserves insertion order. If timestamps are identical,
        // the checkpoint saved last is the newest one.
        return b.insertionIndex - a.insertionIndex;
      })
      .map(({ checkpoint }) => checkpoint);
  }

  async getLatestCheckpoint(missionId: string): Promise<Checkpoint | null> {
    const checkpoints = await this.getCheckpoints(missionId);
    return checkpoints[0] || null;
  }

  async getCheckpointById(id: string): Promise<Checkpoint | null> {
    return this.checkpoints.get(id) || null;
  }

  // Decisions
  async saveDecision(decision: DecisionRecord): Promise<void> {
    this.decisions.set(decision.id, decision);
  }

  async getDecisions(query: {
    missionId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<DecisionRecord[]> {
    let results = Array.from(this.decisions.values());

    if (query.missionId) {
      results = results.filter((d) => d.missionId === query.missionId);
    }
    if (query.taskId) {
      results = results.filter((d) => d.taskId === query.taskId);
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  // Execution Results
  async saveExecutionResult(result: TaskExecutionResult): Promise<void> {
    this.executionResults.set(result.id, result);
  }

  async getExecutionResults(query: {
    missionId?: string;
    taskId?: string;
    workflowId?: string;
    limit?: number;
  }): Promise<TaskExecutionResult[]> {
    let results = Array.from(this.executionResults.values());

    if (query.missionId) {
      // We'd need to filter by missionId, but TaskExecutionResult doesn't have it directly
      // This would require a join or storing missionId in the result
    }
    if (query.taskId) {
      results = results.filter((r) => r.taskId === query.taskId);
    }
    if (query.workflowId) {
      results = results.filter((r) => r.workflowId === query.workflowId);
    }

    results.sort((a, b) => new Date(b.recordedAt).getTime() - new Date(a.recordedAt).getTime());

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  // Patterns
  async savePattern(pattern: LearnedPattern): Promise<void> {
    // Persist exactly the supplied aggregate while isolating nested mutable values.
    this.patterns.set(pattern.id, cloneLearnedPattern(pattern));
  }

  async getPatterns(query: {
    capability?: string;
    workerKind?: string;
    outcome?: string;
    limit?: number;
  }): Promise<LearnedPattern[]> {
    let results = Array.from(this.patterns.values());

    if (query.capability) {
      results = results.filter((p) => p.signature.capability === query.capability);
    }
    if (query.workerKind) {
      results = results.filter((p) => p.signature.workerKind === query.workerKind);
    }
    if (query.outcome) {
      results = results.filter((p) => p.outcome === query.outcome);
    }

    // Deterministic ordering: lastSeenAt descending, then id ascending
    results.sort((a, b) => {
      const dateDiff = new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
      if (dateDiff !== 0) return dateDiff;
      return a.id.localeCompare(b.id);
    });

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results.map(cloneLearnedPattern);
  }

  // Context Items (for retrieval)
  async saveContextItem(item: ContextItem): Promise<void> {
    this.contextItems.set(item.id, item);
  }

  async queryContextItems(query: ContextQuery): Promise<ContextItem[]> {
    let results = Array.from(this.contextItems.values());

    // Filter by mission scope
    // Note: ContextItem doesn't have missionId, so this would need adjustment
    // For now, return all and let selection handle it

    if (query.keywords && query.keywords.length > 0) {
      const keywords = query.keywords.map((k: string) => k.toLowerCase());
      results = results.filter((item: ContextItem) =>
        keywords.some(
          (k) =>
            item.summary.toLowerCase().includes(k) ||
            item.type.toLowerCase().includes(k) ||
            item.tags?.some((t) => t.toLowerCase().includes(k)),
        ),
      );
    }

    // Sort by priority and recency
    results.sort((a, b) => {
      const priorityDiff = (b.priority || 0) - (a.priority || 0);
      if (priorityDiff !== 0) return priorityDiff;
      return (
        new Date(b.updatedAt || b.createdAt).getTime() -
        new Date(a.updatedAt || a.createdAt).getTime()
      );
    });

    if (query.maxTokens) {
      let total = 0;
      results = results.filter((item) => {
        total += item.tokenEstimate || 0;
        return total <= query.maxTokens!;
      });
    }

    return results;
  }

  // Handoff packages
  async saveHandoffPackage(pkg: HandoffPackage): Promise<void> {
    this.handoffPackages.set(pkg.id, pkg);
  }

  async getHandoffPackage(id: string): Promise<HandoffPackage | null> {
    return this.handoffPackages.get(id) || null;
  }

  // Cleanup
  async cleanup(olderThanDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let deleted = 0;

    for (const [id, checkpoint] of this.checkpoints) {
      if (new Date(checkpoint.createdAt) < cutoff) {
        this.checkpoints.delete(id);
        deleted++;
      }
    }

    return deleted;
  }
}

/**
 * Interface for durable memory (cold storage)
 */
export interface DurableMemory {
  // Checkpoints
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoints(missionId: string): Promise<Checkpoint[]>;
  getLatestCheckpoint(missionId: string): Promise<Checkpoint | null>;
  getCheckpointById(id: string): Promise<Checkpoint | null>;

  // Decisions
  saveDecision(decision: DecisionRecord): Promise<void>;
  getDecisions(query: {
    missionId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<DecisionRecord[]>;

  // Execution Results
  saveExecutionResult(result: TaskExecutionResult): Promise<void>;
  getExecutionResults(query: {
    missionId?: string;
    taskId?: string;
    workflowId?: string;
    limit?: number;
  }): Promise<TaskExecutionResult[]>;

  // Patterns
  savePattern(pattern: LearnedPattern): Promise<void>;
  getPatterns(query: {
    capability?: string;
    workerKind?: string;
    outcome?: string;
    limit?: number;
  }): Promise<LearnedPattern[]>;

  // Context Items
  saveContextItem(item: ContextItem): Promise<void>;
  queryContextItems(query: ContextQuery): Promise<ContextItem[]>;

  // Handoff
  saveHandoffPackage(pkg: HandoffPackage): Promise<void>;
  getHandoffPackage(id: string): Promise<HandoffPackage | null>;

  // Maintenance
  cleanup(olderThanDays?: number): Promise<number>;
}
