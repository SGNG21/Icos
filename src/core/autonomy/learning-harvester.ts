import { createHash } from "node:crypto";
import { idSchema, isoDateTimeSchema } from "@/core/contracts/common";
import type { TaskExecutionResult } from "@/core/contracts/task-execution";
import type { ReviewDecisionRecord } from "@/core/contracts/review";
import type { DurableMemory } from "@/core/context/durable-memory";
import type { LearnedPattern } from "@/core/context/contracts";

/** Outcome of a single execution or review, stripped of confidence. */
export interface FactualOutcome {
  id: string;
  source: 'execution' | 'review';
  missionId: string;
  taskId: string;
  workflowId: string;
  outcome: 'success' | 'failure';
  capability?: string;
  workerKind?: string;
  errorCode?: string;
  errorMessage?: string;
  findings: {
    severity: string;
    check: string;
    message: string;
    category?: string;
    repairability?: string;
  }[];
  evidenceRefs: string[];
  timestamp: string;
  /** Only for execution outcomes with repair action */
  repairAction?: string;
  repairSucceeded?: boolean;
  /** Only for review outcomes */
  reviewDecision?: string;
}

/** Learned pattern based solely on observable evidence (without confidence). */
export interface FactualLearnedPattern {
  id: string;
  name: string;
  description: string;
  // Pattern signature (what triggers it)
  signature: {
    capability?: string;
    workerKind?: string;
    errorCode?: string;
    findingCategory?: string;
    taskTitleKeywords?: string[];
  };
  // Outcome
  outcome: 'success' | 'failure' | 'mixed';
  // Observations
  observations: string[];
  // How many times observed
  occurrenceCount: number;
  // Counts per outcome
  outcomeCounts: Record<'success' | 'failure', number>;
  // First time this pattern was seen
  firstSeenAt: string;
  // Last time this pattern was seen
  lastSeenAt: string;
  // Evidence references that support this pattern
  evidenceRefs: string[];
}

/** Input to the learning harvester. */
export interface LearningHarvesterInput {
  executionResults: TaskExecutionResult[];
  reviewDecisions: ReviewDecisionRecord[];
}

/** Result of the learning harvest. */
export interface LearningHarvestResult {
  outcomesProcessed: number;
  newPatterns: FactualLearnedPattern[];
  updatedPatterns: FactualLearnedPattern[];
  errors: string[];
}

/**
 * Extract facts from execution results.
 * Maps TaskExecutionResult to FactualOutcome.
 */
export function extractOutcomesFromExecution(results: TaskExecutionResult[] | undefined): FactualOutcome[] {
  if (!results) {
    return [];
  }
  return results.map((result, index) => {
    const id = `exec-${result.id}`;
    const now = result.recordedAt || new Date().toISOString();
    const outcome = result.outcome === 'success' ? 'success' : 'failure';
    const error = result.error;
    return {
      id,
      source: 'execution',
      missionId: '', // TODO: missionId should come from context, but not available here; tests expect empty string
      taskId: result.taskId,
      workflowId: result.workflowId,
      outcome,
      capability: result.capability,
      workerKind: result.workerKind,
      errorCode: error?.code,
      errorMessage: error?.message,
      findings: result.findings?.map(f => ({
        severity: f.severity.toLowerCase(),
        check: f.check,
        message: f.message,
        category: f.category,
        repairability: f.repairability,
      })) ?? [],
      evidenceRefs: result.evidence?.map(e =>
        e.url ?? e.path ?? `${e.source}:${e.timestamp}`
      ) ?? [],
      timestamp: now,
      // repairAction and repairSucceeded are not in TaskExecutionResult; leave undefined
    };
  });
}

/**
 * Extract facts from review decisions.
 * Maps ReviewDecisionRecord to FactualOutcome.
 */
export function extractOutcomesFromReview(decisions: ReviewDecisionRecord[] | undefined): FactualOutcome[] {
  if (!decisions) {
    return [];
  }
  return decisions.map((decision, index) => {
    const id = `review-${decision.id}`;
    const now = decision.createdAt || new Date().toISOString();
    const outcome = decision.decision === 'APPROVE' ? 'success' : 'failure';
    const findings: {
      severity: string;
      check: string;
      message: string;
      category?: string;
      repairability?: string;
    }[] = [];
    if (decision.requestedChanges) {
      for (const change of decision.requestedChanges) {
        findings.push({
          severity: 'warning',
          check: change.field,
          message: change.reason,
          category: 'review_change_request',
          repairability: 'manual',
        });
      }
    }
    return {
      id,
      source: 'review',
      missionId: decision.missionId,
      taskId: decision.taskId,
      workflowId: decision.workflowId,
      outcome,
      capability: undefined,
      workerKind: undefined,
      errorCode: undefined,
      errorMessage: undefined,
      findings,
      evidenceRefs: decision.evidenceRefs ?? [],
      timestamp: now,
      reviewDecision: decision.decision,
    };
  });
}

/**
 * Group outcomes by their signature (capability, workerKind, errorCode, findingCategories).
 */
export function groupOutcomesBySignature(outcomes: FactualOutcome[]): Map<string, FactualOutcome[]> {
  const map = new Map<string, FactualOutcome[]>();
  for (const outcome of outcomes) {
    const capability = outcome.capability ?? '';
    const workerKind = outcome.workerKind ?? '';
    const errorCode = outcome.errorCode ?? '';
    const findingCategories = (outcome.findings ?? [])
      .map(f => f.category ?? '')
      .filter(c => c !== '')
      .sort()
      .join(',');
    const signatureParts: string[] = [];
    if (capability) signatureParts.push(`cap:${capability}`);
    if (workerKind) signatureParts.push(`wk:${workerKind}`);
    if (errorCode) signatureParts.push(`err:${errorCode}`);
    if (findingCategories) signatureParts.push(`cat:${findingCategories}`);
    const signature = signatureParts.length > 0 ? signatureParts.join('|') : 'default';
    if (!map.has(signature)) {
      map.set(signature, []);
    }
    map.get(signature)!.push(outcome);
  }
  return map;
}

/**
 * Generate a readable pattern name from signature and outcome.
 */
export function generatePatternName(signature: string, outcome: 'success' | 'failure' | 'mixed'): string {
  if (!signature) {
    return `${outcome}: `;
  }
  const parts = signature.split('|');
  const map: Record<string, string> = {
    cap: 'capability',
    wk: 'worker',
    err: 'error',
    cat: 'finding',
  };
  const readable = parts
    .map(part => {
      const [key, value] = part.split(':');
      return `${map[key] || key}:${value}`;
    })
    .join(', ');
  return `${outcome}: ${readable}`;
}

/**
 * Generate a pattern description from grouped outcomes.
 */
export function generatePatternDescription(
  outcomes: FactualOutcome[],
  signature: string
): string {
  const outcomeCounts: Record<'success' | 'failure', number> = { success: 0, failure: 0 };
  const capabilities = new Set<string>();
  const workers = new Set<string>();
  const errorCodes = new Set<string>();
  for (const o of outcomes) {
    if (o.outcome === 'success') outcomeCounts.success++;
    else if (o.outcome === 'failure') outcomeCounts.failure++;
    if (o.capability) capabilities.add(o.capability);
    if (o.workerKind) workers.add(o.workerKind);
    if (o.errorCode) errorCodes.add(o.errorCode);
  }
  const outcomeParts: string[] = [];
  if (outcomeCounts.success > 0) outcomeParts.push(`${outcomeCounts.success} success`);
  if (outcomeCounts.failure > 0) outcomeParts.push(`${outcomeCounts.failure} failure`);
  const outcomeStr = `Observed ${outcomes.length} time(s): ${outcomeParts.join(', ')}.`;
  const caps = Array.from(capabilities).sort().join(', ') || 'none';
  const workersStr = Array.from(workers).sort().join(', ') || 'none';
  const errors = Array.from(errorCodes).sort().join(', ') || 'none';
  const descParts = [outcomeStr];
  if (caps !== 'none') {
    descParts.push(`Capabilities: ${caps}.`);
  }
  if (workersStr !== 'none') {
    descParts.push(`Workers: ${workersStr}.`);
  }
  if (errors !== 'none') {
    descParts.push(`Error codes: ${errors}.`);
  }
  return descParts.join(' ');
}

/**
 * Extract observations from outcomes (errors, repairs, review decisions, findings).
 */
export function extractObservations(outcomes: FactualOutcome[]): string[] {
  const observations: string[] = [];
  for (const o of outcomes) {
    if (o.errorMessage) {
      observations.push(`Error: ${o.errorMessage}`);
    }
    if (o.repairAction !== undefined) {
      const status = o.repairSucceeded ? '(succeeded)' : '(failed)';
      observations.push(`Repair: ${o.repairAction} ${status}`);
    }
    if (o.reviewDecision) {
      observations.push(`Review decision: ${o.reviewDecision}`);
    }
    for (const f of o.findings ?? []) {
      observations.push(`Finding [${f.severity}]: ${f.check} - ${f.message}`);
    }
  }
  // Cap at 20 observations
  return observations.slice(0, 20);
}

/**
 * Build a FactualLearnedPattern from a group of outcomes.
 */
export function buildPatternFromOutcomes(
  signature: string,
  outcomes: FactualOutcome[]
): FactualLearnedPattern {
  const firstSeen = outcomes.reduce((earliest, o) =>
    o.timestamp < earliest ? o.timestamp : earliest,
    outcomes[0].timestamp
  );
  const lastSeen = outcomes.reduce((latest, o) =>
    o.timestamp > latest ? o.timestamp : latest,
    outcomes[0].timestamp
  );
  const outcomeCounts: Record<'success' | 'failure', number> = { success: 0, failure: 0 };
  const observations: string[] = [];
  const evidenceRefs: string[] = [];
  for (const o of outcomes) {
    if (o.outcome === 'success') outcomeCounts.success++;
    else if (o.outcome === 'failure') outcomeCounts.failure++;
    observations.push(...(o.findings ?? []).map(f => `${f.severity}: ${f.check}`));
    evidenceRefs.push(...o.evidenceRefs);
  }
  // Deduplicate observations and evidenceRefs
  const uniqueObservations = [...new Set(observations)];
  const uniqueEvidenceRefs = [...new Set(evidenceRefs)];
  const signatureObj: any = {};
  if (outcomes[0].capability !== undefined) {
    signatureObj.capability = outcomes[0].capability;
  }
  if (outcomes[0].workerKind !== undefined) {
    signatureObj.workerKind = outcomes[0].workerKind;
  }
  if (outcomes[0].errorCode !== undefined) {
    signatureObj.errorCode = outcomes[0].errorCode;
  }
  if (outcomes[0].findings?.length > 0 && outcomes[0].findings[0].category !== undefined) {
    signatureObj.findingCategory = outcomes[0].findings[0].category;
  }
  // taskTitleKeywords is optional; we leave it undefined if empty
  // but we can set to empty array if we want to keep the key; we'll omit for now.
  // However, the type expects taskTitleKeywords?: string[]; we can set to undefined.
  // We'll not add the key if empty.
  return {
    id: createHash('sha256')
      .update(signature + outcomes[0].missionId, 'utf-8')
      .digest('hex')
      .slice(0, 16),
    name: generatePatternName(signature, outcomeCounts.success > 0 && outcomeCounts.failure > 0 ? 'mixed' : outcomeCounts.success > 0 ? 'success' : 'failure'),
    description: generatePatternDescription(outcomes, signature),
    signature: signatureObj,
    outcome:
      outcomeCounts.success > 0 && outcomeCounts.failure > 0
        ? 'mixed'
        : outcomeCounts.success > 0
        ? 'success'
        : 'failure',
    observations: uniqueObservations,
    occurrenceCount: outcomes.length,
    outcomeCounts,
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    evidenceRefs: uniqueEvidenceRefs,
  };
}

/**
 * Harvest learning from execution results and review decisions.
 * Updates durable memory with new or updated patterns.
 */
export async function harvestLearning(
  input: LearningHarvesterInput,
  durableMemory: DurableMemory
): Promise<LearningHarvestResult> {
  const executionOutcomes = extractOutcomesFromExecution(input.executionResults);
  const reviewOutcomes = extractOutcomesFromReview(input.reviewDecisions);
  const allOutcomes = [...executionOutcomes, ...reviewOutcomes];
  const grouped = groupOutcomesBySignature(allOutcomes);
  const existingPatterns = await durableMemory.getPatterns({});
  const existingMap = new Map<string, FactualLearnedPattern>();
  for (const p of existingPatterns) {
    // LearnedPattern is already factual; no confidence field to omit
    existingMap.set(p.id, p as FactualLearnedPattern);
  }
  const newPatterns: FactualLearnedPattern[] = [];
  const updatedPatterns: FactualLearnedPattern[] = [];
  const errors: string[] = [];
  for (const [signature, outcomes] of grouped.entries()) {
    try {
      const candidate = buildPatternFromOutcomes(signature, outcomes);
      const existing = existingMap.get(candidate.id);
      if (existing) {
        // Merge: update counts, timestamps, evidenceRefs
        const merged: FactualLearnedPattern = {
          ...existing,
          occurrenceCount: existing.occurrenceCount + candidate.occurrenceCount,
          outcomeCounts: {
            success: existing.outcomeCounts.success + candidate.outcomeCounts.success,
            failure: existing.outcomeCounts.failure + candidate.outcomeCounts.failure,
          },
          firstSeenAt:
            existing.firstSeenAt < candidate.firstSeenAt
              ? existing.firstSeenAt
              : candidate.firstSeenAt,
          lastSeenAt:
            existing.lastSeenAt > candidate.lastSeenAt
              ? existing.lastSeenAt
              : candidate.lastSeenAt,
          evidenceRefs: [...new Set([...existing.evidenceRefs, ...candidate.evidenceRefs])],
          observations: [...new Set([...existing.observations, ...candidate.observations])],
        };
        updatedPatterns.push(merged);
        await durableMemory.savePattern(merged);
      } else {
        newPatterns.push(candidate);
        await durableMemory.savePattern(candidate);
      }
    } catch (err) {
      errors.push(
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return {
    outcomesProcessed: allOutcomes.length,
    newPatterns,
    updatedPatterns,
    errors,
  };
}

/**
 * Query learned patterns from durable memory with optional filters.
 */
export async function queryLearnedPatterns(
  durableMemory: DurableMemory,
  query: {
    capability?: string;
    workerKind?: string;
    outcome?: string;
    limit?: number;
  }
): Promise<FactualLearnedPattern[]> {
  const patterns = await durableMemory.getPatterns(query);
  // Map LearnedPattern to FactualLearnedPattern by omitting confidence
  return patterns.map(({ confidence, ...factual }) => factual as FactualLearnedPattern);
}

/**
 * Get a learned pattern by its ID.
 */
export async function getLearnedPatternById(
  durableMemory: DurableMemory,
  id: string
): Promise<FactualLearnedPattern | null> {
  const patterns = await durableMemory.getPatterns({});
  const found = patterns.find(p => p.id === id);
  if (!found) {
    return null;
  }
  const { confidence, ...factual } = found;
  return factual as FactualLearnedPattern;
}