import { sql, eq, desc, asc } from "drizzle-orm";
import type { Database } from "@/server/database/client";
import type { DurableMemory } from "@/core/context/durable-memory";
export type { DurableMemory } from "@/core/context/durable-memory";
import type {
  Checkpoint,
  DecisionRecord,
  LearnedPattern,
  HandoffPackage,
  ContextQuery,
} from "@/core/context/contracts";
import type { ContextItem } from "@/core/contracts/context-item";
import type {
  TaskExecutionResult,
  WorkerKind,
  ExecutionErrorCode,
} from "@/core/contracts/task-execution";
import {
  checkpoints,
  decisions,
  learnedPatterns,
  handoffPackages,
  contextItems,
  taskExecutionResults,
} from "@/server/database/schema";

/** JSON columns may come back already parsed or as a string depending on the driver path. */
function jsonAs<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

export class PostgresDurableMemory implements DurableMemory {
  constructor(private db: Database) {}

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    await this.db.insert(checkpoints).values({
      id: checkpoint.id,
      missionId: checkpoint.missionId,
      state: JSON.stringify({
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
        version: checkpoint.version,
        mission: checkpoint.mission,
        tasks: checkpoint.tasks,
        taskResults: checkpoint.taskResults,
        decisions: checkpoint.decisions,
        artifacts: checkpoint.artifacts,
        evidence: checkpoint.evidence,
        errors: checkpoint.errors,
        tokenCount: checkpoint.tokenCount,
        compressed: checkpoint.compressed ?? false,
      }),
      createdAt: new Date(checkpoint.createdAt),
      label: checkpoint.label ?? undefined,
    });
  }

  async getCheckpoints(missionId: string): Promise<Checkpoint[]> {
    const res = await this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.missionId, missionId))
      .orderBy(desc(checkpoints.createdAt))
      .execute();
    return res.map((row) => {
      const state = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
      return {
        id: row.id,
        missionId: row.missionId,
        label: state?.label,
        createdAt: state?.createdAt,
        version: state?.version,
        mission: state?.mission,
        tasks: state?.tasks,
        taskResults: state?.taskResults,
        decisions: state?.decisions,
        artifacts: state?.artifacts,
        evidence: state?.evidence,
        errors: state?.errors,
        tokenCount: state?.tokenCount,
        compressed: state?.compressed ?? false,
      };
    });
  }

  async getLatestCheckpoint(missionId: string): Promise<Checkpoint | null> {
    const checkpoints = await this.getCheckpoints(missionId);
    return checkpoints[0] ?? null;
  }

  async getCheckpointById(id: string): Promise<Checkpoint | null> {
    const res = await this.db
      .select()
      .from(checkpoints)
      .where(eq(checkpoints.id, id))
      .limit(1)
      .execute();
    const row = res[0];
    if (!row) return null;
    const state = typeof row.state === "string" ? JSON.parse(row.state) : row.state;
    return {
      id: row.id,
      missionId: row.missionId,
      label: state?.label,
      createdAt: state?.createdAt,
      version: state?.version,
      mission: state?.mission,
      tasks: state?.tasks,
      taskResults: state?.taskResults,
      decisions: state?.decisions,
      artifacts: state?.artifacts,
      evidence: state?.evidence,
      errors: state?.errors,
      tokenCount: state?.tokenCount,
      compressed: state?.compressed ?? false,
    };
  }

  async saveDecision(record: DecisionRecord): Promise<void> {
    await this.db.insert(decisions).values({
      id: record.id,
      missionId: record.missionId,
      taskId: record.taskId,
      workflowId: record.workflowId,
      decision: record.decision,
      reviewerKind: record.reviewerKind,
      severity: record.severity,
      reasons: record.reasons,
      requestedChanges: record.requestedChanges ?? null,
      evidenceRefs: record.evidenceRefs ?? null,
      findingRefs: record.findingRefs ?? null,
      policyRefs: record.policyRefs ?? null,
      providerMetadata: record.providerMetadata ?? null,
      confidence: record.confidence ?? null,
      createdAt: new Date(record.createdAt),
      humanOverridden: record.humanOverridden,
      overriddenBy: record.overriddenBy ?? null,
    });
  }

  async getDecisions(query: {
    missionId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<DecisionRecord[]> {
    let res = await this.db.select().from(decisions).orderBy(desc(decisions.createdAt)).execute();

    if (query.missionId) {
      res = res.filter((r) => r.missionId === query.missionId);
    }
    if (query.taskId) {
      res = res.filter((r) => r.taskId === query.taskId);
    }
    if (query.limit) {
      res = res.slice(0, query.limit);
    }

    return res.map((row) => ({
      id: row.id,
      missionId: row.missionId,
      taskId: row.taskId,
      workflowId: row.workflowId,
      decision: row.decision as DecisionRecord["decision"],
      reviewerKind: row.reviewerKind as DecisionRecord["reviewerKind"],
      severity: row.severity as DecisionRecord["severity"],
      reasons: jsonAs(row.reasons),
      requestedChanges: row.requestedChanges
        ? jsonAs(row.requestedChanges)
        : undefined,
      evidenceRefs: row.evidenceRefs
        ? jsonAs(row.evidenceRefs)
        : [],
      findingRefs: row.findingRefs
        ? jsonAs(row.findingRefs)
        : [],
      policyRefs: row.policyRefs
        ? jsonAs(row.policyRefs)
        : [],
      providerMetadata: row.providerMetadata
        ? jsonAs(row.providerMetadata)
        : undefined,
      confidence: row.confidence ?? undefined,
      createdAt: row.createdAt.toISOString(),
      humanOverridden: row.humanOverridden,
      overriddenBy: row.overriddenBy ?? undefined,
    }));
  }

  async savePattern(pattern: LearnedPattern): Promise<void> {
    await this.db.insert(learnedPatterns).values({
      id: pattern.id,
      capability: pattern.signature.capability ?? undefined,
      workerKind: pattern.signature.workerKind ?? undefined,
      signature: JSON.stringify(pattern.signature),
      description: pattern.description,
      outcome: pattern.outcome,
      observations: JSON.stringify({
        observations: pattern.observations,
        occurrenceCount: pattern.occurrenceCount,
        lastSeenAt: pattern.lastSeenAt,
      }),
      confidence: pattern.confidence,
      createdAt: new Date(),
    });
  }

  async getPatterns(query: {
    capability?: string;
    workerKind?: string;
    outcome?: string;
    limit?: number;
  }): Promise<LearnedPattern[]> {
    let res = await this.db
      .select()
      .from(learnedPatterns)
      .orderBy(desc(learnedPatterns.confidence))
      .execute();

    if (query.capability) {
      res = res.filter((r) => r.capability === query.capability);
    }
    if (query.workerKind) {
      res = res.filter((r) => r.workerKind === query.workerKind);
    }
    if (query.outcome) {
      res = res.filter((r) => r.outcome === query.outcome);
    }
    if (query.limit) {
      res = res.slice(0, query.limit);
    }

    return res.map((row) => {
      const obs = jsonAs<Pick<LearnedPattern, "observations" | "occurrenceCount" | "lastSeenAt">>(
        row.observations,
      );
      return {
        id: row.id,
        name: "",
        description: row.description,
        signature:
          jsonAs(row.signature),
        observations: obs.observations,
        occurrenceCount: obs.occurrenceCount,
        lastSeenAt: obs.lastSeenAt,
        confidence: row.confidence,
        outcome: row.outcome as LearnedPattern["outcome"],
        createdAt: row.createdAt.toISOString(),
      } as LearnedPattern;
    });
  }

  async saveHandoffPackage(pkg: HandoffPackage): Promise<void> {
    await this.db.insert(handoffPackages).values({
      id: pkg.id,
      missionId: pkg.missionId,
      fromAgent: pkg.fromAgent,
      toAgent: pkg.toAgent,
      timestamp: new Date(pkg.timestamp),
      reason: pkg.reason,
      instructions: pkg.instructions ?? null,
      missionContext: JSON.stringify(pkg.missionContext),
      workingMemorySlice: pkg.workingMemorySlice ? JSON.stringify(pkg.workingMemorySlice) : null,
      durableRefs: JSON.stringify(pkg.durableRefs),
    });
  }

  async getHandoffPackage(id: string): Promise<HandoffPackage | null> {
    const res = await this.db
      .select()
      .from(handoffPackages)
      .where(eq(handoffPackages.id, id))
      .limit(1)
      .execute();
    const row = res[0];
    if (!row) return null;
    return {
      id: row.id,
      missionId: row.missionId,
      fromAgent: row.fromAgent,
      toAgent: row.toAgent,
      timestamp: row.timestamp.toISOString(),
      reason: row.reason,
      instructions: row.instructions ?? undefined,
      missionContext:
        jsonAs(row.missionContext),
      workingMemorySlice: row.workingMemorySlice
        ? jsonAs(row.workingMemorySlice)
        : undefined,
      durableRefs: row.durableRefs
        ? jsonAs(row.durableRefs)
        : {},
    } as HandoffPackage;
  }

  async saveContextItem(item: ContextItem): Promise<void> {
    await this.db.insert(contextItems).values({
      id: item.id,
      missionId: item.missionId,
      scope: item.scope,
      type: item.type,
      summary: item.summary,
      contentReference: item.contentReference,
      createdAt: new Date(item.createdAt),
      priority: item.priority ?? 0,
      tokenEstimate: item.tokenEstimate ?? 0,
    });
  }

  async queryContextItems(query: ContextQuery): Promise<ContextItem[]> {
    const res = await this.db
      .select()
      .from(contextItems)
      .orderBy(desc(contextItems.createdAt))
      .execute();

    // Map to ContextItem (camelCase)
    const items = res.map((row) => ({
      id: row.id,
      scope: row.scope as ContextItem["scope"],
      type: row.type,
      summary: row.summary,
      contentReference: row.contentReference ?? undefined,
      createdAt: row.createdAt.toISOString(),
      priority: row.priority ?? 0,
      tokenEstimate: row.tokenEstimate,
      missionId: row.missionId,
    }));

    // Filter by missionId
    if (query.missionId) {
      return items.filter((item) => item.missionId === query.missionId);
    }

    // Filter by keywords
    if (query.keywords && query.keywords.length > 0) {
      const keywords = query.keywords.map((k) => k.toLowerCase());
      return items.filter((item) =>
        keywords.some(
          (k) => item.summary.toLowerCase().includes(k) || item.type.toLowerCase().includes(k),
          // Note: tags column does not exist in the database, so we skip tags filtering.
        ),
      );
    }

    // Sort by priority and recency (using createdAt only, as there is no updatedAt column)
    return items.sort((a, b) => {
      const priorityDiff = (b.priority ?? 0) - (a.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      const dateA = new Date(b.createdAt).getTime();
      const dateB = new Date(a.createdAt).getTime();
      return dateA - dateB;
    });
  }

  async saveExecutionResult(result: TaskExecutionResult): Promise<void> {
    await this.db.insert(taskExecutionResults).values({
      id: result.id,
      taskId: result.taskId,
      capability: result.capability ?? undefined,
      workflowId: result.workflowId,
      outcome: result.outcome,
      workerKind: result.workerKind ?? undefined,
      result: result.result ?? undefined,
      errorCode: result.error?.code ?? undefined,
      errorMessage: result.error?.message ?? undefined,
      digitalosExecutionId: result.digitalosExecutionId ?? undefined,
      startedAt: result.startedAt ? new Date(result.startedAt) : undefined,
      completedAt: new Date(result.completedAt),
      recordedAt: new Date(result.recordedAt),
      observations: JSON.stringify(result.observations),
      confidence: result.confidence ?? undefined,
      artifacts: JSON.stringify(result.artifacts),
      evidence: JSON.stringify(result.evidence),
      findings: JSON.stringify(result.findings),
    });
  }

  async getExecutionResults(query: {
    missionId?: string;
    taskId?: string;
    workflowId?: string;
    limit?: number;
  }): Promise<TaskExecutionResult[]> {
    let res = await this.db
      .select()
      .from(taskExecutionResults)
      .orderBy(desc(taskExecutionResults.recordedAt))
      .execute();

    if (query.taskId) {
      res = res.filter((r) => r.taskId === query.taskId);
    }
    if (query.workflowId) {
      res = res.filter((r) => r.workflowId === query.workflowId);
    }
    if (query.limit) {
      res = res.slice(0, query.limit);
    }

    return res.map((row) => {
      const error =
        row.errorCode && row.errorMessage
          ? {
              code: row.errorCode as unknown as ExecutionErrorCode,
              message: row.errorMessage,
            }
          : undefined;
      return {
        id: row.id,
        taskId: row.taskId,
        capability: row.capability ?? undefined,
        workflowId: row.workflowId,
        outcome: row.outcome as TaskExecutionResult["outcome"],
        workerKind: row.workerKind ? (row.workerKind as WorkerKind) : undefined,
        result: row.result ?? undefined,
        error,
        digitalosExecutionId: row.digitalosExecutionId ?? undefined,
        startedAt: row.startedAt ? row.startedAt.toISOString() : undefined,
        completedAt: row.completedAt.toISOString(),
        recordedAt: row.recordedAt.toISOString(),
        observations: row.observations
          ? jsonAs(row.observations)
          : undefined,
        confidence: row.confidence ?? undefined,
        artifacts: row.artifacts
          ? jsonAs(row.artifacts)
          : undefined,
        evidence: row.evidence
          ? jsonAs(row.evidence)
          : undefined,
        findings: row.findings
          ? jsonAs(row.findings)
          : undefined,
      };
    });
  }

  async cleanup(olderThanDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    let deleted = 0;

    // Delete old checkpoints
    const checkpointsRes = await this.db
      .delete(checkpoints)
      .where(sql.raw(`createdAt < ${cutoff.toISOString()}`));
    deleted += checkpointsRes.count ?? 0;

    // Delete old decisions
    const decisionsRes = await this.db
      .delete(decisions)
      .where(sql.raw(`createdAt < ${cutoff.toISOString()}`));
    deleted += decisionsRes.count ?? 0;

    // Delete old learned patterns
    const patternsRes = await this.db
      .delete(learnedPatterns)
      .where(sql.raw(`createdAt < ${cutoff.toISOString()}`));
    deleted += patternsRes.count ?? 0;

    // Delete old handoff packages
    const handoffRes = await this.db
      .delete(handoffPackages)
      .where(sql.raw(`timestamp < ${cutoff.toISOString()}`));
    deleted += handoffRes.count ?? 0;

    // Delete old context items
    const contextRes = await this.db
      .delete(contextItems)
      .where(sql.raw(`createdAt < ${cutoff.toISOString()}`));
    deleted += contextRes.count ?? 0;

    // Delete old task execution results
    const executionRes = await this.db
      .delete(taskExecutionResults)
      .where(sql.raw(`recordedAt < ${cutoff.toISOString()}`));
    deleted += executionRes.count ?? 0;

    return deleted;
  }
}