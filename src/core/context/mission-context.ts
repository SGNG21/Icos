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
import type { Mission, MissionTask } from "@/core/mission/contracts";
import type { TaskExecutionResult } from "@/core/contracts/task-execution";
import type { ContextItem } from "@/core/contracts/context-item";
import { v4 as uuidv4 } from "uuid";

type MissionStatus = Mission["status"];
type MissionTaskStatus = MissionTask["status"];

/**
 * Mission Context (Hot Layer) - In-memory state for active mission execution
 * This is the "working set" that stays hot during mission execution.
 */
export class MissionContext {
  mission: Mission;
  tasks: Map<string, MissionTask> = new Map();
  taskResults: Map<string, TaskExecutionResult> = new Map();
  decisions: DecisionRecord[] = [];
  artifacts: ContextItem[] = [];
  evidence: ContextItem[] = [];
  errors: Array<{ code: string; message: string; taskId?: string; timestamp: string }> = [];
  checkpoints: CheckpointRef[] = [];

  // Computed views
  readyTasks: MissionTask[] = [];
  runningTasks: MissionTask[] = [];
  completedTasks: MissionTask[] = [];
  failedTasks: MissionTask[] = [];

  // Token tracking
  tokenEstimate: number = 0;

  constructor(mission: Mission) {
    this.mission = mission;
  }

  /**
   * Add or update a task
   */
  upsertTask(task: MissionTask): void {
    this.tasks.set(task.id, task);
    this.recomputeTaskViews();
    this.updateTokenEstimate();
  }

  /**
   * Get task by ID
   */
  getTask(taskId: string): MissionTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Add task execution result
   */
  addTaskResult(result: TaskExecutionResult): void {
    this.taskResults.set(result.taskId, result);
    this.updateTokenEstimate();
  }

  /**
   * Get task result
   */
  getTaskResult(taskId: string): TaskExecutionResult | undefined {
    return this.taskResults.get(taskId);
  }

  /**
   * Add decision
   */
  addDecision(decision: DecisionRecord): void {
    this.decisions.push(decision);
    // Keep only last 50 decisions in hot memory
    if (this.decisions.length > 50) {
      this.decisions = this.decisions.slice(-50);
    }
    this.updateTokenEstimate();
  }

  /**
   * Get recent decisions
   */
  getRecentDecisions(count: number = 10): DecisionRecord[] {
    return this.decisions.slice(-count);
  }

  /**
   * Add artifact
   */
  addArtifact(artifact: ContextItem): void {
    this.artifacts.push(artifact);
    this.updateTokenEstimate();
  }

  /**
   * Add evidence
   */
  addEvidence(evidence: ContextItem): void {
    this.evidence.push(evidence);
    this.updateTokenEstimate();
  }

  /**
   * Add error
   */
  addError(code: string, message: string, taskId?: string): void {
    this.errors.push({
      code,
      message,
      taskId,
      timestamp: new Date().toISOString(),
    });
    // Keep only last 20 errors
    if (this.errors.length > 20) {
      this.errors = this.errors.slice(-20);
    }
    this.updateTokenEstimate();
  }

  /**
   * Add checkpoint reference
   */
  addCheckpointRef(ref: CheckpointRef): void {
    this.checkpoints.push(ref);
    // Keep only last 10 checkpoints
    if (this.checkpoints.length > 10) {
      this.checkpoints = this.checkpoints.slice(-10);
    }
  }

  /**
   * Get blocking errors (errors on ready/running tasks)
   */
  getBlockingErrors(): Array<{ code: string; message: string; taskId?: string }> {
    const activeTaskIds = new Set([
      ...this.readyTasks.map((t) => t.id),
      ...this.runningTasks.map((t) => t.id),
    ]);
    return this.errors.filter((e) => e.taskId && activeTaskIds.has(e.taskId));
  }

  /**
   * Get pending approvals (tasks awaiting review)
   */
  getPendingApprovals(): Array<{ taskId: string; title: string; requestedAt: string }> {
    // This would be populated when a task is sent for review
    // For now, return empty - reviewer service would populate this
    return [];
  }

  /**
   * Recompute task views based on current statuses
   */
  private recomputeTaskViews(): void {
    this.readyTasks = [];
    this.runningTasks = [];
    this.completedTasks = [];
    this.failedTasks = [];

    for (const task of this.tasks.values()) {
      switch (task.status) {
        case "queued":
        case "draft":
          this.readyTasks.push(task);
          break;
        case "running":
        case "awaiting_approval":
          this.runningTasks.push(task);
          break;
        case "succeeded":
          this.completedTasks.push(task);
          break;
        case "failed":
        case "cancelled":
        case "blocked":
          this.failedTasks.push(task);
          break;
      }
    }
  }

  /**
   * Update token estimate
   */
  private updateTokenEstimate(): number {
    let tokens = 0;

    // Mission: ~200 tokens
    tokens += 200;

    // Tasks: ~50 tokens each
    tokens += this.tasks.size * 50;

    // Task results: ~200 tokens each
    tokens += this.taskResults.size * 200;

    // Decisions: ~100 tokens each
    tokens += this.decisions.length * 100;

    // Artifacts/Evidence: ~100 tokens each
    tokens += (this.artifacts.length + this.evidence.length) * 100;

    // Errors: ~50 tokens each
    tokens += this.errors.length * 50;

    this.tokenEstimate = tokens;
    return tokens;
  }

  /**
   * Get current token estimate
   */
  getTokenEstimate(): number {
    return this.tokenEstimate;
  }

  /**
   * Serialize to Checkpoint
   */
  toCheckpoint(label?: string): Checkpoint {
    const missionTasks = Array.from(this.tasks.values());
    // Convert taskResults Map to Record
    const taskResultsRecord: Record<string, TaskExecutionResult> = {};
    for (const [taskId, result] of this.taskResults.entries()) {
      taskResultsRecord[taskId] = result;
    }

    // Convert artifacts to checkpoint format
    const checkpointArtifacts = this.artifacts.map((a) => ({
      type: a.type,
      path: a.contentReference || undefined,
      url: a.contentReference?.startsWith("http") ? a.contentReference : undefined,
      mediaType: undefined as string | undefined,
      metadata: undefined as Record<string, unknown> | undefined,
    }));

    // Convert evidence to checkpoint format
    const checkpointEvidence = this.evidence.map((e) => ({
      type: e.type,
      source: e.scope,
      path: e.contentReference || undefined,
      url: e.contentReference?.startsWith("http") ? e.contentReference : undefined,
      timestamp: e.createdAt,
      metadata: undefined as Record<string, unknown> | undefined,
    }));

    // Convert errors to checkpoint format
    const checkpointErrors = this.errors.map((e) => ({
      code: e.code,
      message: e.message,
    }));

    return {
      id: `checkpoint-${uuidv4()}`,
      missionId: this.mission.id,
      label,
      createdAt: new Date().toISOString(),
      version: 1,
      mission: {
        id: this.mission.id,
        title: this.mission.title,
        objective: this.mission.objective,
        status: this.mission.status,
        createdAt: this.mission.createdAt.toISOString(),
        updatedAt: this.mission.updatedAt
          ? this.mission.updatedAt.toISOString()
          : this.mission.createdAt.toISOString(),
      },
      tasks: missionTasks,
      taskResults: taskResultsRecord,
      decisions: this.decisions,
      artifacts: checkpointArtifacts,
      evidence: checkpointEvidence,
      errors: checkpointErrors,
      tokenCount: this.tokenEstimate,
      compressed: false,
    };
  }

  /**
   * Restore from Checkpoint
   */
  static fromCheckpoint(checkpoint: Checkpoint): MissionContext {
    // Convert mission dates
    const mission: Mission = {
      id: checkpoint.mission.id,
      title: checkpoint.mission.title,
      objective: checkpoint.mission.objective,
      status: checkpoint.mission.status as MissionStatus,
      createdAt: new Date(checkpoint.mission.createdAt),
      updatedAt: checkpoint.mission.updatedAt
        ? new Date(checkpoint.mission.updatedAt)
        : new Date(checkpoint.mission.createdAt),
    };

    const context = new MissionContext(mission);

    // Restore tasks
    for (const task of checkpoint.tasks) {
      context.tasks.set(task.id, task as MissionTask);
    }

    // Restore task results
    if (checkpoint.taskResults) {
      for (const [taskId, result] of Object.entries(checkpoint.taskResults)) {
        context.taskResults.set(taskId, result);
      }
    }

    // Restore decisions
    if (checkpoint.decisions) {
      context.decisions = checkpoint.decisions;
    }

    // Restore artifacts
    if (checkpoint.artifacts) {
      context.artifacts = checkpoint.artifacts.map((a) => ({
        id: `artifact-${uuidv4()}`,
        scope: "mission" as const,
        type: a.type,
        summary: (a.metadata?.summary as string) || a.type,
        contentReference: a.path || a.url,
        createdAt: checkpoint.createdAt,
        updatedAt: checkpoint.createdAt,
        priority: 50,
        tokenEstimate: 100,
        missionId: checkpoint.missionId,
      }));
    }

    // Restore evidence
    if (checkpoint.evidence) {
      context.evidence = checkpoint.evidence.map((e) => ({
        id: `evidence-${uuidv4()}`,
        scope: "mission" as const,
        type: e.type,
        summary: (e.metadata?.summary as string) || e.type,
        contentReference: e.path || e.url,
        createdAt: e.timestamp,
        updatedAt: e.timestamp,
        priority: 50,
        tokenEstimate: 100,
        missionId: checkpoint.missionId,
      }));
    }

    // Restore errors
    if (checkpoint.errors) {
      context.errors = checkpoint.errors.map((e) => ({
        code: e.code,
        message: e.message,
        taskId: undefined,
        timestamp: checkpoint.createdAt,
      }));
    }

    context.recomputeTaskViews();
    context.updateTokenEstimate();

    return context;
  }
}

/**
 * Working Memory (Warm Layer) - Agent session memory
 * Persists across missions within an agent session.
 */
export class InMemoryWorkingMemory implements WorkingMemory {
  agentId: string;
  sessionId: string;
  patterns: LearnedPattern[] = [];
  preferences: AgentPreferences | undefined;
  templates: ContextTemplate[] = [];
  crossMissionDecisions: DecisionRecord[] = [];
  toolCalibration: ToolCalibration[] = [];
  tokenEstimate: number = 0;
  createdAt: string;
  updatedAt: string;

  constructor(agentId: string, sessionId: string) {
    this.agentId = agentId;
    this.sessionId = sessionId;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
  }

  /**
   * Learn a pattern from execution
   */
  async learnPattern(
    pattern: Omit<LearnedPattern, "id" | "occurrenceCount" | "lastSeenAt" | "createdAt" | "firstSeenAt" | "outcomeCounts" | "evidenceRefs">,
  ): Promise<void> {
    const existing = this.patterns.find(
      (p) =>
        p.signature.capability === pattern.signature.capability &&
        p.signature.workerKind === pattern.signature.workerKind &&
        p.signature.errorCode === pattern.signature.errorCode,
    );

    const now = new Date().toISOString();
    if (existing) {
      existing.occurrenceCount++;
      existing.lastSeenAt = now;
      // Increment the exact outcome count
      const outcomeKey = pattern.outcome as keyof typeof existing.outcomeCounts;
      if (outcomeKey in existing.outcomeCounts) {
        existing.outcomeCounts[outcomeKey]++;
      }
      // Merge observations (deduplicate)
      const mergedObservations = [...new Set([...existing.observations, ...pattern.observations])];
      existing.observations = mergedObservations;
      // Merge evidenceRefs (deduplicate)
      const mergedEvidence = [...new Set([...existing.evidenceRefs, ...(pattern.evidenceRefs ?? [])])];
      existing.evidenceRefs = mergedEvidence;
    } else {
      this.patterns.push({
        ...pattern,
        id: `pattern-${uuidv4()}`,
        occurrenceCount: 1,
        lastSeenAt: now,
        createdAt: now,
        firstSeenAt: now,
        outcomeCounts: {
          success: pattern.outcome === 'success' ? 1 : 0,
          failure: pattern.outcome === 'failure' ? 1 : 0,
          mixed: pattern.outcome === 'mixed' ? 1 : 0,
        },
        evidenceRefs: pattern.evidenceRefs ?? [],
      });
    }

    this.updatedAt = new Date().toISOString();
    this.updateTokenEstimate();
  }

  /**
   * Get relevant patterns for a task
   */
  getRelevantPatterns(
    capability?: string,
    workerKind?: string,
    errorCode?: string,
  ): LearnedPattern[] {
    return this.patterns
      .filter((p) => {
        if (capability && p.signature.capability !== capability) return false;
        if (workerKind && p.signature.workerKind !== workerKind) return false;
        if (errorCode && p.signature.errorCode !== errorCode) return false;
        return true;
      })
      .sort((a, b) => {
        // Deterministic ordering: lastSeenAt descending, then id ascending
        const dateDiff = new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime();
        if (dateDiff !== 0) return dateDiff;
        return a.id.localeCompare(b.id);
      });
  }

  /**
   * Update preferences
   */
  updatePreferences(prefs: Partial<AgentPreferences>): void {
    if (!this.preferences) {
      this.preferences = {
        agentId: this.agentId,
        riskTolerance: "balanced",
        updatedAt: new Date().toISOString(),
      };
    }
    this.preferences = {
      ...this.preferences,
      ...prefs,
      updatedAt: new Date().toISOString(),
    };
    this.updatedAt = new Date().toISOString();
    this.updateTokenEstimate();
  }

  /**
   * Add template
   */
  addTemplate(
    template: Omit<ContextTemplate, "id" | "usageCount" | "createdAt" | "updatedAt">,
  ): ContextTemplate {
    const newTemplate: ContextTemplate = {
      ...template,
      id: `template-${uuidv4()}`,
      usageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.templates.push(newTemplate);
    this.updatedAt = new Date().toISOString();
    this.updateTokenEstimate();
    return newTemplate;
  }

  /**
   * Use template (increments usage)
   */
  useTemplate(templateId: string): ContextTemplate | undefined {
    const template = this.templates.find((t) => t.id === templateId);
    if (template) {
      template.usageCount++;
      template.updatedAt = new Date().toISOString();
      this.updatedAt = new Date().toISOString();
    }
    return template;
  }

  /**
   * Record tool calibration
   */
  recordToolCalibration(calibration: ToolCalibration): void {
    const existing = this.toolCalibration.findIndex((t) => t.toolId === calibration.toolId);
    if (existing >= 0) {
      this.toolCalibration[existing] = calibration;
    } else {
      this.toolCalibration.push(calibration);
    }
    this.updatedAt = new Date().toISOString();
    this.updateTokenEstimate();
  }

  /**
   * Get best calibration for a tool
   */
  getToolCalibration(toolId: string): ToolCalibration | undefined {
    return this.toolCalibration.find((t) => t.toolId === toolId);
  }

  /**
   * Add cross-mission decision
   */
  addCrossMissionDecision(decision: DecisionRecord): void {
    this.crossMissionDecisions.push(decision);
    // Keep only last 100
    if (this.crossMissionDecisions.length > 100) {
      this.crossMissionDecisions = this.crossMissionDecisions.slice(-100);
    }
    this.updatedAt = new Date().toISOString();
    this.updateTokenEstimate();
  }

  /**
   * Flush to durable storage (called periodically)
   */
  async flush(durableMemory: DurableMemory): Promise<void> {
    // Save patterns
    for (const pattern of this.patterns) {
      await durableMemory.savePattern(pattern);
    }

    // Save preferences
    if (this.preferences) {
      // Would save to agent preferences table
    }

    // Save templates
    // Would save to templates table

    // Save calibration
    // Would save to calibration table

    // Save cross-mission decisions
    for (const decision of this.crossMissionDecisions) {
      await durableMemory.saveDecision(decision);
    }
  }

  /**
   * Load from durable storage
   */
  async load(durableMemory: DurableMemory): Promise<void> {
    // Load patterns
    this.patterns = await durableMemory.getPatterns({ limit: 100 });

    // Load templates
    // this.templates = await durableMemory.getTemplates({ agentId: this.agentId });

    // Load calibration
    // this.toolCalibration = await durableMemory.getCalibration({ agentId: this.agentId });

    this.updateTokenEstimate();
  }

  /**
   * Update token estimate
   */
  private updateTokenEstimate(): void {
    let tokens = 0;
    tokens += this.patterns.length * 150;
    tokens += this.templates.length * 200;
    tokens += this.crossMissionDecisions.length * 100;
    tokens += this.toolCalibration.length * 100;
    this.tokenEstimate = tokens;
  }

  /**
   * Serialize for persistence
   */
  toJSON(): WorkingMemory {
    return {
      agentId: this.agentId,
      sessionId: this.sessionId,
      patterns: this.patterns,
      preferences: this.preferences,
      templates: this.templates,
      crossMissionDecisions: this.crossMissionDecisions,
      toolCalibration: this.toolCalibration,
      tokenEstimate: this.tokenEstimate,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Restore from serialized
   */
  static fromJSON(data: WorkingMemory): InMemoryWorkingMemory {
    const wm = new InMemoryWorkingMemory(data.agentId, data.sessionId);
    wm.patterns = data.patterns;
    wm.preferences = data.preferences;
    wm.templates = data.templates;
    wm.crossMissionDecisions = data.crossMissionDecisions;
    wm.toolCalibration = data.toolCalibration;
    wm.tokenEstimate = data.tokenEstimate;
    wm.createdAt = data.createdAt;
    wm.updatedAt = data.updatedAt;
    return wm;
  }
}

// DurableMemory interface (imported from durable-memory.ts)
export interface DurableMemory {
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  getCheckpoints(missionId: string): Promise<Checkpoint[]>;
  getLatestCheckpoint(missionId: string): Promise<Checkpoint | null>;
  getCheckpointById(id: string): Promise<Checkpoint | null>;

  saveDecision(decision: DecisionRecord): Promise<void>;
  getDecisions(query: {
    missionId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<DecisionRecord[]>;

  saveExecutionResult(result: TaskExecutionResult): Promise<void>;
  getExecutionResults(query: {
    missionId?: string;
    taskId?: string;
    workflowId?: string;
    limit?: number;
  }): Promise<TaskExecutionResult[]>;

  savePattern(pattern: LearnedPattern): Promise<void>;
  getPatterns(query: {
    capability?: string;
    workerKind?: string;
    outcome?: string;
    limit?: number;
  }): Promise<LearnedPattern[]>;

  saveContextItem(item: ContextItem): Promise<void>;
  queryContextItems(query: ContextQuery): Promise<ContextItem[]>;

  saveHandoffPackage(pkg: HandoffPackage): Promise<void>;
  getHandoffPackage(id: string): Promise<HandoffPackage | null>;

  cleanup(olderThanDays?: number): Promise<number>;
}
